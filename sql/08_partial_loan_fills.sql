-- =========================
-- Partial Loan Fills Support (Issue #269)
-- =========================
-- Allows multiple lenders to each fund a slice of one large loan request.
--
-- Before this migration a loan had exactly one lender: /api/loans/fund flipped
-- the loan straight to 'active' and recorded the lender in ledger_transactions.
-- That model cannot express "50% funded", and it cannot hold two lenders.
--
-- After this migration:
--   * public.loan_fundings   -- one row per lender contribution
--   * loans.funded_amount    -- running total, the source of truth for progress
--   * a loan activates only when funded_amount >= principal_amount
--
-- Backward-compatible: existing single-lender loans are backfilled from
-- ledger_transactions in step 6, so their progress renders as 100%.

-- =========================
-- 1. Running funded total on the loan
-- =========================

alter table public.loans
  add column if not exists funded_amount numeric(20, 6) not null default 0
  check (funded_amount >= 0);

comment on column public.loans.funded_amount is
  'Total XLM committed by all lenders so far. The loan activates when this reaches principal_amount (Issue #269).';

-- Partially funded loans are the hot query on the marketplace.
create index if not exists idx_loans_status_funded on public.loans(status, funded_amount);

-- =========================
-- 2. Per-lender contributions
-- =========================

create table if not exists public.loan_fundings (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  lender_id uuid not null references public.profiles(id) on delete restrict,
  amount numeric(20, 6) not null check (amount > 0),
  tx_hash text not null,
  lender_address text,
  funded_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- One Stellar payment can only ever be claimed once. This is the replay guard:
-- the old code deduped on (ref_type, ref_id) in ledger_transactions, which
-- rejected the *second lender* rather than a resubmitted transaction.
create unique index if not exists idx_loan_fundings_tx_hash on public.loan_fundings(tx_hash);

create index if not exists idx_loan_fundings_loan_id on public.loan_fundings(loan_id);
create index if not exists idx_loan_fundings_lender_id on public.loan_fundings(lender_id);
create index if not exists idx_loan_fundings_lender_loan on public.loan_fundings(lender_id, loan_id);

comment on table public.loan_fundings is
  'One row per lender contribution to a loan. Multiple rows per loan = a partially filled loan (Issue #269).';

-- =========================
-- 3. Row level security
-- =========================

alter table public.loan_fundings enable row level security;

-- A lender sees their own contributions; a borrower sees who funded their loan.
drop policy if exists loan_fundings_select_own on public.loan_fundings;
create policy loan_fundings_select_own
on public.loan_fundings
for select
using (
  auth.uid() = lender_id
  or exists (
    select 1
    from public.loans l
    where l.id = loan_fundings.loan_id
      and l.borrower_id = auth.uid()
  )
);

-- Writes go exclusively through record_loan_funding() below, which is
-- security definer. No direct insert/update/delete policy is granted.

-- =========================
-- 4. Atomic funding RPC
-- =========================
-- Replaces activate_loan_funding() for partial fills. The loan row is locked
-- FOR UPDATE so two lenders funding the same loan concurrently cannot both
-- read the same remaining amount and overfund it.

-- Dropped first so re-running this migration after a signature change works.
drop function if exists public.record_loan_funding(uuid, uuid, numeric, text, text, timestamptz);

create function public.record_loan_funding(
  p_loan_id uuid,
  p_lender_id uuid,
  p_amount numeric,
  p_tx_hash text,
  p_lender_address text default null,
  p_funded_at timestamptz default now()
)
returns table (
  loan_id uuid,
  status public.loan_status,
  principal_amount numeric,
  funded_amount numeric,
  remaining_amount numeric,
  is_fully_funded boolean,
  funding_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan public.loans;
  v_new_total numeric(20, 6);
  v_remaining numeric(20, 6);
  v_funding_id uuid;
  v_due_at timestamptz;
begin
  if auth.uid() is distinct from p_lender_id then
    raise exception 'not authorized';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'funding amount must be greater than zero';
  end if;

  if p_tx_hash is null or length(trim(p_tx_hash)) = 0 then
    raise exception 'a stellar transaction hash is required';
  end if;

  -- Lock the loan for the duration of the transaction.
  select * into v_loan
  from public.loans
  where id = p_loan_id
  for update;

  if not found then
    raise exception 'loan not found';
  end if;

  if v_loan.status not in ('requested', 'approved') then
    raise exception 'loan is not available for funding (status: %)', v_loan.status;
  end if;

  if v_loan.borrower_id = p_lender_id then
    raise exception 'you cannot fund your own loan';
  end if;

  v_remaining := v_loan.principal_amount - v_loan.funded_amount;

  if v_remaining <= 0 then
    raise exception 'loan is already fully funded';
  end if;

  -- Reject overfunding outright rather than silently capping: the lender has
  -- already sent this exact amount on-chain, so accepting a smaller figure
  -- would under-credit them.
  if p_amount > v_remaining then
    raise exception 'funding amount % exceeds the remaining % on this loan', p_amount, v_remaining;
  end if;

  insert into public.loan_fundings (loan_id, lender_id, amount, tx_hash, lender_address, funded_at)
  values (p_loan_id, p_lender_id, p_amount, trim(p_tx_hash), p_lender_address, p_funded_at)
  returning id into v_funding_id;

  v_new_total := v_loan.funded_amount + p_amount;

  if v_new_total >= v_loan.principal_amount then
    -- 100% funded: the loan goes live and the repayment clock starts now.
    v_due_at := p_funded_at + make_interval(days => v_loan.duration_days);

    update public.loans
    set funded_amount = v_new_total,
        status        = 'active',
        approved_at   = coalesce(approved_at, p_funded_at),
        funded_at     = coalesce(funded_at, p_funded_at),
        due_at        = v_due_at,
        updated_at    = now()
    where id = p_loan_id
    returning * into v_loan;
  else
    -- Still short: stay open on the marketplace for the next lender.
    update public.loans
    set funded_amount = v_new_total,
        updated_at    = now()
    where id = p_loan_id
    returning * into v_loan;
  end if;

  return query
  select
    v_loan.id,
    v_loan.status,
    v_loan.principal_amount,
    v_loan.funded_amount,
    greatest(v_loan.principal_amount - v_loan.funded_amount, 0)::numeric,
    (v_loan.funded_amount >= v_loan.principal_amount),
    v_funding_id;
end;
$$;

grant execute on function public.record_loan_funding(uuid, uuid, numeric, text, text, timestamptz) to authenticated;

-- =========================
-- 5. Marketplace listing with funding progress
-- =========================
-- Adds principal/funded/remaining so the UI can draw the progress bar, and
-- drops loans that have already reached 100% but are mid-activation.

-- CREATE OR REPLACE cannot change a function's return type, and this adds
-- columns to the existing signature — so drop it first.
drop function if exists public.get_marketplace_loans();

create function public.get_marketplace_loans()
returns table (
  id uuid,
  principal_amount numeric,
  funded_amount numeric,
  remaining_amount numeric,
  apr_bps integer,
  duration_days integer,
  borrower_id uuid,
  borrower_name text,
  borrower_wallet text,
  trust_score integer,
  lender_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.principal_amount,
    l.funded_amount,
    greatest(l.principal_amount - l.funded_amount, 0)::numeric as remaining_amount,
    l.apr_bps,
    l.duration_days,
    l.borrower_id,
    case
      when coalesce(nullif(p.full_name, ''), '') <> '' then p.full_name
      else 'Borrower ' || left(l.borrower_id::text, 6)
    end as borrower_name,
    coalesce(p.wallet_address, '') as borrower_wallet,
    coalesce(rs.score_total, 250) as trust_score,
    (select count(*) from public.loan_fundings lf where lf.loan_id = l.id)::integer as lender_count
  from public.loans l
  left join public.profiles p on p.id = l.borrower_id
  left join public.reputation_snapshots rs on rs.user_id = l.borrower_id
  where l.status in ('requested', 'approved')
    and l.funded_amount < l.principal_amount
  order by l.created_at asc;
$$;

grant execute on function public.get_marketplace_loans() to authenticated;

-- =========================
-- 6. Backfill existing single-lender loans
-- =========================
-- Loans funded before this migration recorded the lender only in
-- ledger_transactions. Replay those into loan_fundings so historical loans
-- report 100% progress and lenders keep their claim to repayment.

-- The funding route writes metadata with JSON.stringify(), which lands in the
-- jsonb column as a *string scalar* rather than an object. Normalize both
-- shapes before reading txHash out of it.
with legacy_funding as (
  select
    l.id as loan_id,
    lt.id as ledger_tx_id,
    lt.user_id as lender_id,
    l.principal_amount,
    coalesce(l.funded_at, lt.created_at) as funded_at,
    case jsonb_typeof(lt.metadata)
      when 'object' then lt.metadata
      when 'string' then (lt.metadata #>> '{}')::jsonb
      else '{}'::jsonb
    end as meta
  from public.loans l
  join public.ledger_transactions lt
    on lt.ref_type = 'loan_fund'
   and lt.ref_id = l.id
  where not exists (
    select 1 from public.loan_fundings lf where lf.loan_id = l.id
  )
)
insert into public.loan_fundings (loan_id, lender_id, amount, tx_hash, lender_address, funded_at, metadata)
select
  loan_id,
  lender_id,
  principal_amount,
  coalesce(nullif(meta ->> 'txHash', ''), 'legacy:' || ledger_tx_id::text),
  meta ->> 'lenderAddress',
  funded_at,
  jsonb_build_object('backfilled', true, 'source_ledger_tx', ledger_tx_id)
from legacy_funding
on conflict (tx_hash) do nothing;

-- Mark those loans fully funded.
update public.loans l
set funded_amount = l.principal_amount
where l.funded_amount = 0
  and exists (select 1 from public.loan_fundings lf where lf.loan_id = l.id);

-- Any loan already past the funding stage is by definition fully funded.
update public.loans
set funded_amount = principal_amount
where funded_amount = 0
  and status in ('active', 'funded', 'repaid', 'defaulted');

-- Force PostgREST schema cache reload so the new RPCs are discoverable.
notify pgrst, 'reload schema';
