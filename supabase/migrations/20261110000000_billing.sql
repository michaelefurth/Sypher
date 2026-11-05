-- Billing with Stripe: invoices for an engagement (deposits, milestones, retainers, one-off
-- fees), each with Stripe Tax, paid by the client on Stripe's hosted invoice page.
--
-- Stripe is the record of truth. These tables mirror what the portal needs to show and are
-- written only by the server (the billing and stripe-webhook functions, with the service role):
--   billing_profiles  the client's billing name, email and address (Stripe Tax needs a location)
--                     and their Stripe customer id
--   invoices          one row per Stripe invoice, kept current by webhooks
--   stripe_events     webhook events already applied, so a retried delivery is applied once
--
-- Michael (admin) sees everything. A client sees their own billing profile and the invoices of
-- engagements they own. Team members (attorneys, CPAs, contractors) never see billing.
-- Idempotent: safe to re-run; no drops.

-- 1. Billing profiles -------------------------------------------------------------------
create table if not exists public.billing_profiles (
  client_id          uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id text unique,
  billing_name       text,
  billing_email      text,
  line1              text,
  line2              text,
  city               text,
  state              text,
  postal_code        text,
  country            text not null default 'US',
  updated_at         timestamptz not null default now()
);
alter table public.billing_profiles enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'billing_profiles' and policyname = 'billing profiles: admin') then
    create policy "billing profiles: admin" on public.billing_profiles for all using (public.is_admin()) with check (public.is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'billing_profiles' and policyname = 'billing profiles: client reads own') then
    create policy "billing profiles: client reads own" on public.billing_profiles for select using (client_id = auth.uid());
  end if;
end $$;

-- 2. Invoices -----------------------------------------------------------------------------
create table if not exists public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  engagement_id      uuid not null references public.engagements (id) on delete cascade,
  client_id          uuid references public.profiles (id) on delete set null,
  proposal_id        uuid,
  stripe_invoice_id  text not null unique,
  number             text,
  kind               text not null default 'one_off' check (kind in ('deposit', 'milestone', 'retainer', 'one_off')),
  description        text,
  status             text not null default 'draft' check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency           text not null default 'usd',
  subtotal           bigint,          -- amounts in cents
  tax                bigint,
  total              bigint,
  amount_due         bigint,
  amount_paid        bigint,
  amount_remaining   bigint,
  refunded           bigint not null default 0,
  credited           bigint not null default 0,
  due_date           date,
  hosted_invoice_url text,
  invoice_pdf        text,
  last_payment_error text,
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  finalized_at       timestamptz,
  paid_at            timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists invoices_eng_idx on public.invoices (engagement_id, created_at desc);
alter table public.invoices enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'invoices' and policyname = 'invoices: admin') then
    create policy "invoices: admin" on public.invoices for all using (public.is_admin()) with check (public.is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'invoices' and policyname = 'invoices: client reads own') then
    create policy "invoices: client reads own" on public.invoices for select using (public.owns_engagement(engagement_id) and status <> 'draft');
  end if;
end $$;

-- 3. Webhook events already applied ------------------------------------------------------
-- No policies: only the service role (the webhook function) reads or writes it.
create table if not exists public.stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;

-- 4. Live updates in the portal -------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'invoices') then
    alter publication supabase_realtime add table public.invoices;
  end if;
end $$;
