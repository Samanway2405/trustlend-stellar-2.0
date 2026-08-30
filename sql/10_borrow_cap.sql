-- Migration: Add borrow_cap column to lending_pools table
-- Issue #153: Implement maximum cap on total borrowable amount per pool
-- Run this migration in your Supabase SQL editor

-- Add borrow_cap column (nullable - null means no cap)
alter table public.lending_pools
  add column if not exists borrow_cap numeric(20, 7) null
  constraint lending_pools_borrow_cap_check check (borrow_cap is null or borrow_cap > 0);

comment on column public.lending_pools.borrow_cap is
  'Maximum total XLM/USDC that can be borrowed from this pool at any time. NULL means no cap enforced.';

-- Index to quickly find pools that have a cap set
create index if not exists idx_lending_pools_borrow_cap
  on public.lending_pools (borrow_cap)
  where borrow_cap is not null;
