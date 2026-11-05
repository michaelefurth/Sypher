-- Sypher Solutions: the owner model's personal section. Run after 20261108000000_owner_model.sql.
--
-- The owner as a person: marital status and marital agreements, dependents, vehicles, accounts,
-- personal debts, insurance, retirement, estate documents. Each item has a value and/or a
-- liability, a status (current, in progress, needed, resolved) and who is to act. A lender
-- reads these beside the businesses; a marital agreement decides what the owner actually owns.
-- Written without drop statements so it applies the same way from the CLI and by hand.

create table if not exists public.om_personal (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.om_models (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  category       text not null default 'other' check (category in ('marital', 'agreement', 'dependents', 'residence', 'vehicle', 'account', 'debt', 'insurance', 'retirement', 'estate', 'tax', 'other')),
  label          text not null,
  detail         text,
  amount         numeric(14, 2),                        -- value, where there is one
  liability      numeric(14, 2),                        -- what is owed against it
  as_of          date,
  status         text not null default 'current' check (status in ('current', 'in_progress', 'needed', 'resolved')),
  owner_label    text,
  position       integer not null default 0,
  note           text,
  updated_by     uuid references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now()
);
create index if not exists om_personal_model_idx on public.om_personal (model_id, position);

alter table public.om_personal enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'om_personal' and policyname = 'om_personal: admin') then
    create policy "om_personal: admin" on public.om_personal for all using (public.is_admin()) with check (public.is_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'om_personal' and policyname = 'om_personal: read') then
    create policy "om_personal: read" on public.om_personal for select using (public.can_see_model(engagement_id));
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'om_personal') then
    alter publication supabase_realtime add table public.om_personal;
  end if;
end $$;
