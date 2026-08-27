-- =========================
-- Referral Program (Issue #266)
-- =========================
-- Users get a unique referral link; when an invited friend takes out a loan,
-- the referrer earns a bonus paid on-chain by the ReferralRewardsContract.
--
-- This migration owns the *off-chain* half:
--   * profiles.referral_code  -- the unique code behind each user's link
--   * public.referrals        -- one row per invited user, with payout state
--   * claim_referral_bonus()  -- marks a referral payable when a loan activates
--
-- The on-chain contract remains the source of truth for whether a bonus was
-- actually transferred. Rows here track intent and mirror the result, so the
-- dashboard can render progress without an RPC round-trip per referral.

-- =========================
-- 1. Referral code on the profile
-- =========================

alter table public.profiles
  add column if not exists referral_code text;

comment on column public.profiles.referral_code is
  'Unique invite code behind this user''s referral link, e.g. TL7F3KQ2 (Issue #266).';

-- Codes are handed out in links, so they must be unique. Partial index keeps
-- pre-existing rows with a NULL code valid until they are backfilled.
create unique index if not exists idx_profiles_referral_code
  on public.profiles(referral_code)
  where referral_code is not null;

-- =========================
-- 2. Referral edges
-- =========================

-- Wrapped so re-running this migration is a no-op, matching 01_core_schema.
do $$ begin
  create type public.referral_status as enum (
    'pending',   -- friend signed up, has not borrowed yet
    'qualified', -- friend's loan activated; bonus is owed
    'paid',      -- bonus confirmed transferred on-chain
    'rejected'   -- disqualified (self-referral, fraud, cap reached)
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  referee_id uuid not null references public.profiles(id) on delete cascade,
  -- The code as it was used, retained even if the referrer later rotates it.
  referral_code text not null,
  status public.referral_status not null default 'pending',
  -- The loan whose activation qualified this referral.
  qualifying_loan_id uuid references public.loans(id) on delete set null,
  qualified_at timestamptz,
  paid_at timestamptz,
  -- Bonus as reported by the contract, in whole reward tokens.
  bonus_amount numeric(20, 7) not null default 0 check (bonus_amount >= 0),
  -- Stellar transaction that carried the payout.
  payout_tx_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A user is attributed to exactly one referrer, forever. This is the
  -- database-side mirror of the contract's immutable ReferrerOf mapping.
  constraint referrals_referee_unique unique (referee_id),
  -- Self-referral is meaningless and is the cheapest possible abuse.
  constraint referrals_no_self check (referrer_id <> referee_id)
);

create index if not exists idx_referrals_referrer_id on public.referrals(referrer_id);
create index if not exists idx_referrals_status on public.referrals(status);
create index if not exists idx_referrals_referrer_status
  on public.referrals(referrer_id, status);

comment on table public.referrals is
  'One row per invited user. Mirrors the on-chain ReferralRewardsContract state (Issue #266).';

drop trigger if exists trg_referrals_updated_at on public.referrals;
create trigger trg_referrals_updated_at
before update on public.referrals
for each row execute function public.set_updated_at();

-- =========================
-- 3. Row level security
-- =========================

alter table public.referrals enable row level security;

-- A referrer sees who they invited; an invited user sees their own edge.
drop policy if exists referrals_select_own on public.referrals;
create policy referrals_select_own
on public.referrals
for select
using (auth.uid() = referrer_id or auth.uid() = referee_id);

drop policy if exists referrals_admin_all on public.referrals;
create policy referrals_admin_all
on public.referrals
for all
using (public.is_admin())
with check (public.is_admin());

-- Writes go through the security-definer functions below. No direct
-- insert/update policy is granted to authenticated users, so nobody can
-- attribute themselves to a referrer or mark their own bonus paid.

-- =========================
-- 4. Code assignment
-- =========================
-- Generating the code in SQL keeps every account guaranteed to have one, even
-- for users created before this migration or through a path that bypasses the
-- app. The alphabet mirrors lib/referrals/codes.ts (no 0/O/1/I/L/U).

create or replace function public.generate_referral_code()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code text;
  v_attempt int := 0;
begin
  loop
    v_code := 'TL';
    for _ in 1..6 loop
      -- floor(random() * 30) + 1 -> 1..30, substr is 1-indexed.
      v_code := v_code || substr(v_alphabet, floor(random() * 30)::int + 1, 1);
    end loop;

    exit when not exists (
      select 1 from public.profiles where referral_code = v_code
    );

    v_attempt := v_attempt + 1;
    if v_attempt > 20 then
      -- 30^6 is ~729M; 20 collisions in a row means something is very wrong.
      raise exception 'Could not generate a unique referral code after % attempts', v_attempt;
    end if;
  end loop;

  return v_code;
end;
$$;

-- Assign a code to any profile that lacks one.
create or replace function public.ensure_referral_code(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  select referral_code into v_code
  from public.profiles
  where id = p_user_id;

  if v_code is not null then
    return v_code;
  end if;

  v_code := public.generate_referral_code();

  update public.profiles
  set referral_code = v_code
  where id = p_user_id and referral_code is null;

  -- Another session may have won the race; return whatever actually stuck.
  select referral_code into v_code
  from public.profiles
  where id = p_user_id;

  return v_code;
end;
$$;

grant execute on function public.ensure_referral_code(uuid) to authenticated;

-- New users get a code at signup.
create or replace function public.assign_referral_code_on_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.referral_code is null then
    new.referral_code := public.generate_referral_code();
  end if;
  return new;
exception
  when others then
    -- Never block profile creation over a referral code; ensure_referral_code()
    -- backfills it on first visit to the referrals page.
    return new;
end;
$$;

drop trigger if exists trg_profiles_referral_code on public.profiles;
create trigger trg_profiles_referral_code
before insert on public.profiles
for each row execute function public.assign_referral_code_on_profile();

-- Backfill everyone who predates this migration.
update public.profiles
set referral_code = public.generate_referral_code()
where referral_code is null;

-- =========================
-- 5. Attribution
-- =========================
-- Called when a new user signs up with ?ref=CODE. Security definer because the
-- referee must not be able to write arbitrary rows into public.referrals.

create or replace function public.record_referral(
  p_referee_id uuid,
  p_referral_code text
)
returns table (
  referral_id uuid,
  referrer_id uuid,
  status public.referral_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer_id uuid;
  v_code text;
  v_referral_id uuid;
  v_status public.referral_status;
begin
  v_code := upper(trim(p_referral_code));

  if v_code is null or v_code = '' then
    raise exception 'Referral code is required';
  end if;

  select id into v_referrer_id
  from public.profiles
  where referral_code = v_code;

  if v_referrer_id is null then
    raise exception 'Unknown referral code';
  end if;

  if v_referrer_id = p_referee_id then
    raise exception 'Cannot refer yourself';
  end if;

  -- One attribution per referee, first one wins. ON CONFLICT keeps a double
  -- submit idempotent instead of raising.
  insert into public.referrals (referrer_id, referee_id, referral_code, status)
  values (v_referrer_id, p_referee_id, v_code, 'pending')
  on conflict (referee_id) do nothing
  returning id into v_referral_id;

  if v_referral_id is null then
    -- Already attributed; return the existing edge unchanged.
    select r.id, r.referrer_id, r.status
    into v_referral_id, v_referrer_id, v_status
    from public.referrals r
    where r.referee_id = p_referee_id;

    referral_id := v_referral_id;
    referrer_id := v_referrer_id;
    status := v_status;
    return next;
    return;
  end if;

  referral_id := v_referral_id;
  referrer_id := v_referrer_id;
  status := 'pending'::public.referral_status;
  return next;
end;
$$;

grant execute on function public.record_referral(uuid, text) to authenticated;

-- =========================
-- 6. Qualification
-- =========================
-- Called by the loan-funding route when a loan reaches 100% and activates.
-- Flips the referee's pending edge to 'qualified' so the dashboard can show
-- the bonus as owed while the chain settles.

create or replace function public.qualify_referral(
  p_referee_id uuid,
  p_loan_id uuid
)
returns table (
  referral_id uuid,
  referrer_id uuid,
  status public.referral_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.referrals;
begin
  -- Lock the edge so two concurrent activations cannot both qualify it.
  select * into v_row
  from public.referrals
  where referee_id = p_referee_id
  for update;

  if not found then
    return; -- borrower was not referred; nothing to do
  end if;

  -- Only a pending referral can qualify. Anything already qualified, paid or
  -- rejected stays as it is — this is what stops a second loan from earning a
  -- second bonus, mirroring the contract's BonusPaid flag.
  if v_row.status <> 'pending'::public.referral_status then
    referral_id := v_row.id;
    referrer_id := v_row.referrer_id;
    status := v_row.status;
    return next;
    return;
  end if;

  update public.referrals
  set status = 'qualified'::public.referral_status,
      qualifying_loan_id = p_loan_id,
      qualified_at = now()
  where id = v_row.id;

  referral_id := v_row.id;
  referrer_id := v_row.referrer_id;
  status := 'qualified'::public.referral_status;
  return next;
end;
$$;

grant execute on function public.qualify_referral(uuid, uuid) to service_role;

-- =========================
-- 7. Settlement
-- =========================
-- Records the on-chain result once the payout transaction is observed.

create or replace function public.settle_referral_payout(
  p_referral_id uuid,
  p_bonus_amount numeric,
  p_tx_hash text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_bonus_amount < 0 then
    raise exception 'Bonus amount cannot be negative';
  end if;

  update public.referrals
  set status = 'paid'::public.referral_status,
      bonus_amount = p_bonus_amount,
      payout_tx_hash = p_tx_hash,
      paid_at = now()
  where id = p_referral_id
    and status <> 'paid'::public.referral_status;
end;
$$;

grant execute on function public.settle_referral_payout(uuid, numeric, text) to service_role;

-- =========================
-- 8. Dashboard read model
-- =========================

create or replace function public.get_referral_stats(p_user_id uuid)
returns table (
  referral_code text,
  total_invited bigint,
  pending_count bigint,
  qualified_count bigint,
  paid_count bigint,
  total_earned numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.referral_code,
    count(r.id) as total_invited,
    count(r.id) filter (where r.status = 'pending') as pending_count,
    count(r.id) filter (where r.status = 'qualified') as qualified_count,
    count(r.id) filter (where r.status = 'paid') as paid_count,
    coalesce(sum(r.bonus_amount) filter (where r.status = 'paid'), 0) as total_earned
  from public.profiles p
  left join public.referrals r on r.referrer_id = p.id
  where p.id = p_user_id
  group by p.referral_code;
$$;

grant execute on function public.get_referral_stats(uuid) to authenticated;
