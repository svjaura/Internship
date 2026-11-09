-- Refi Watch: initial schema.
--
-- Data minimization: these tables hold only what the brief allows.
--   borrowers:   name and invite email
--   plaid_items: servicer name, connection status, last updated, item id, the access token ENCRYPTED (AES-256-GCM, app-side key)
--   loans:       rate and type, balance, next payment and due date, origination date, original amount,
--                term, maturity, loan type, last 4 of the loan number
-- Never stored: passwords, 2FA codes, SSNs, transactions, full account numbers, escrow, PMI,
-- property address, past-due amounts, late fees.
--
-- Every table has org_id and row-level security. The app server uses the service role
-- (which bypasses RLS) and checks staff membership itself; RLS is the backstop for any
-- access with the anon or authenticated keys. Policies also require a two-factor (aal2) session.

-- gen_random_uuid() is built into Postgres 13+, so no extension is needed.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.orgs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid generated always as (id) stored,  -- so every table has org_id
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.staff_members (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'staff' check (role in ('owner', 'staff')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index staff_members_user_idx on public.staff_members (user_id);

create table public.borrowers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  full_name     text not null check (length(full_name) between 1 and 120),
  invite_email  text check (invite_email is null or length(invite_email) <= 254),
  invite_code   text not null unique check (invite_code ~ '^[A-Za-z0-9_-]{16,64}$'),
  consented_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index borrowers_org_idx on public.borrowers (org_id);

create table public.plaid_items (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  borrower_id       uuid not null references public.borrowers(id) on delete cascade,
  item_id           text not null unique,
  access_token_enc  text not null check (access_token_enc like 'v1.%'),  -- AES-256-GCM, never plaintext
  institution_name  text,
  status            text not null default 'ok'
                    check (status in ('ok', 'login_required', 'pending_expiration', 'revoked', 'error')),
  status_reason     text,
  last_updated_at   timestamptz,
  created_at        timestamptz not null default now()
);
create index plaid_items_org_idx on public.plaid_items (org_id);
-- One live connection per borrower, so nobody creates a duplicate (Trial slots are not freed by removal).
create unique index plaid_items_one_per_borrower on public.plaid_items (borrower_id) where status <> 'revoked';

create table public.loans (
  id                             uuid primary key default gen_random_uuid(),
  org_id                         uuid not null references public.orgs(id) on delete cascade,
  borrower_id                    uuid not null references public.borrowers(id) on delete cascade,
  plaid_item_id                  uuid not null references public.plaid_items(id) on delete cascade,
  plaid_account_id               text not null,  -- Plaid's opaque id, not an account number
  servicer_name                  text,
  interest_rate_percentage       numeric(6,3),
  interest_rate_type             text check (interest_rate_type in ('fixed', 'variable')),
  current_balance                numeric(14,2),
  next_monthly_payment           numeric(12,2),
  next_payment_due_date          date,
  origination_date               date,
  origination_principal_amount   numeric(14,2),
  maturity_date                  date,
  loan_term                      text check (loan_term is null or length(loan_term) <= 40),
  loan_type_description          text check (loan_type_description is null or length(loan_type_description) <= 80),
  account_last4                  text check (account_last4 is null or account_last4 ~ '^[A-Za-z0-9]{1,4}$'),
  last_updated                   timestamptz not null default now(),
  unique (plaid_item_id, plaid_account_id)
);
create index loans_org_idx on public.loans (org_id);

create table public.org_settings (
  org_id         uuid primary key references public.orgs(id) on delete cascade,
  today_rate     numeric(6,3)  not null default 6.125 check (today_rate between 0 and 25),
  closing_costs  numeric(12,2) not null default 4000  check (closing_costs >= 0),
  min_drop       numeric(6,3)  not null default 0.75  check (min_drop >= 0),
  min_savings    numeric(12,2) not null default 150   check (min_savings >= 0),
  max_payback    numeric(6,2)  not null default 36    check (max_payback >= 0),
  min_seasoning  numeric(6,2)  not null default 6     check (min_seasoning >= 0),
  new_term       text not null default 'keep' check (new_term in ('keep', '360')),
  roll_costs     boolean not null default false,
  preset         text not null default 'standard' check (preset in ('standard', 'va', 'fha')),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id) on delete set null
);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.orgs(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  event       text not null check (event in ('login', 'export', 'settings_update', 'invite_created',
                                             'plaid_connected', 'plaid_refresh', 'plaid_status')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_org_idx on public.audit_log (org_id, created_at desc);

-- Every new org gets the default rule.
create or replace function public.create_org_settings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.org_settings (org_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger orgs_create_settings after insert on public.orgs
  for each row execute function public.create_org_settings();

-- The audit log is append-only, even for the service role.
create or replace function public.audit_log_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Is the signed-in user a staff member of this org? security definer so it can read
-- staff_members without recursing through its own policy.
create or replace function public.is_org_member(target_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff_members s
    where s.org_id = target_org and s.user_id = auth.uid()
  );
$$;
revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

alter table public.orgs           enable row level security;
alter table public.staff_members  enable row level security;
alter table public.borrowers      enable row level security;
alter table public.plaid_items    enable row level security;
alter table public.loans          enable row level security;
alter table public.org_settings   enable row level security;
alter table public.audit_log      enable row level security;

-- Two-factor is required for every row: a restrictive policy on each table.
create policy require_aal2 on public.orgs          as restrictive to authenticated using ((auth.jwt() ->> 'aal') = 'aal2');
create policy require_aal2 on public.staff_members as restrictive to authenticated using ((auth.jwt() ->> 'aal') = 'aal2');
create policy require_aal2 on public.borrowers     as restrictive to authenticated using ((auth.jwt() ->> 'aal') = 'aal2');
create policy require_aal2 on public.plaid_items   as restrictive to authenticated using ((auth.jwt() ->> 'aal') = 'aal2');
create policy require_aal2 on public.loans         as restrictive to authenticated using ((auth.jwt() ->> 'aal') = 'aal2');
create policy require_aal2 on public.org_settings  as restrictive to authenticated using ((auth.jwt() ->> 'aal') = 'aal2') with check ((auth.jwt() ->> 'aal') = 'aal2');
create policy require_aal2 on public.audit_log     as restrictive to authenticated using ((auth.jwt() ->> 'aal') = 'aal2');

-- Org membership.
create policy member_read on public.orgs          for select to authenticated using (public.is_org_member(id));
create policy member_read on public.staff_members for select to authenticated using (public.is_org_member(org_id));
create policy member_read on public.borrowers     for select to authenticated using (public.is_org_member(org_id));
create policy member_read on public.plaid_items   for select to authenticated using (public.is_org_member(org_id));
create policy member_read on public.loans         for select to authenticated using (public.is_org_member(org_id));
create policy member_read on public.org_settings  for select to authenticated using (public.is_org_member(org_id));
create policy member_update on public.org_settings for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy member_read on public.audit_log     for select to authenticated using (public.is_org_member(org_id));
-- No insert/update/delete policies otherwise: writes go through the server (service role).

-- The encrypted token is never readable with the anon or authenticated keys, even by staff.
revoke all on public.plaid_items from anon, authenticated;
grant select (id, org_id, borrower_id, item_id, institution_name, status, status_reason, last_updated_at, created_at)
  on public.plaid_items to authenticated;

-- Nothing is readable without logging in.
revoke all on public.orgs, public.staff_members, public.borrowers, public.loans, public.org_settings, public.audit_log from anon;
