-- Sypher Solutions: the owner model. Everything a person owns, the way a forensic accountant,
-- a tax CPA and a lender's underwriter look at it. Run after 20261107000000_project_model.sql.
--
-- An owner model belongs to an engagement. It holds the owner's entities and their books by
-- period (with the filed tax figures beside them), the adjustments that normalize the books
-- and bridge them to the returns, the properties with their land, building and cost
-- segregation components, the findings register (what was observed, why it matters, the
-- test, the evidence needed, who owns it), and the assumptions (inputs) the arithmetic uses.
-- It can point at a project model so coverage is shown with the new debt.
--
-- Who can see it: the same people as the project model (Michael, the client, and team members
-- given model access; never a pricing sheet's contractor). Michael edits the structure; the
-- client and advisers set the assumptions they are asked to confirm and comment on anything.

create table if not exists public.om_models (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  title          text not null,
  owner_name     text,
  pm_model_id    uuid references public.pm_models (id) on delete set null,
  notes          text,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists om_models_eng_idx on public.om_models (engagement_id);

-- The entities: trades, LLCs, rentals, the person.
create table if not exists public.om_entities (
  id                   uuid primary key default gen_random_uuid(),
  model_id             uuid not null references public.om_models (id) on delete cascade,
  engagement_id        uuid not null references public.engagements (id) on delete cascade,
  name                 text not null,
  kind                 text not null default 'smllc' check (kind in ('sole_prop', 'smllc', 'partnership', 's_corp', 'c_corp', 'rental', 'individual')),
  tax_form             text,                          -- 'Schedule C', 'Schedule E', 'Form 1065'...
  ownership_pct        numeric(6, 2) not null default 100,
  disregarded          boolean not null default true,  -- taxed as part of the owner's return
  recurring_cash_flow  numeric(14, 2),                 -- overrides the latest full year when set
  w2_wages             numeric(14, 2),                 -- for the qualified business income limit
  ubia                 numeric(14, 2),                 -- unadjusted basis of qualified property
  sstb                 boolean not null default false,
  position             integer not null default 0,
  note                 text,
  updated_by           uuid references public.profiles (id) on delete set null,
  updated_at           timestamptz not null default now()
);
create index if not exists om_entities_model_idx on public.om_entities (model_id, position);

-- The books by period, with the filed figures beside them. Amounts as reported, never recomputed.
create table if not exists public.om_periods (
  id                 uuid primary key default gen_random_uuid(),
  model_id           uuid not null references public.om_models (id) on delete cascade,
  engagement_id      uuid not null references public.engagements (id) on delete cascade,
  entity_id          uuid not null references public.om_entities (id) on delete cascade,
  period             text not null,                   -- '2024', '2025', '2026 YTD'
  period_start       date,
  period_end         date,
  months             integer not null default 12 check (months between 1 and 12),
  basis              text not null default 'cash' check (basis in ('cash', 'accrual', 'tax')),
  revenue            numeric(14, 2),
  cogs               numeric(14, 2),
  opex               numeric(14, 2),
  depreciation       numeric(14, 2),
  interest           numeric(14, 2),
  rent_paid          numeric(14, 2),
  rent_related       numeric(14, 2),                  -- rent paid to the owner or a related party (eliminated)
  owner_comp         numeric(14, 2),                  -- owner pay expensed in the books (a draw for tax)
  other_expense      numeric(14, 2),
  net_income         numeric(14, 2),
  tax_gross          numeric(14, 2),                  -- gross receipts on the filed return
  tax_net            numeric(14, 2),                  -- net profit on the filed return
  cash               numeric(14, 2),
  total_assets       numeric(14, 2),
  total_liabilities  numeric(14, 2),
  source             text,
  confidence         text not null default 'estimate' check (confidence in ('firm', 'estimate', 'unknown')),
  position           integer not null default 0,
  note               text,
  updated_by         uuid references public.profiles (id) on delete set null,
  updated_at         timestamptz not null default now(),
  unique (entity_id, period)
);
create index if not exists om_periods_model_idx on public.om_periods (model_id, entity_id, position);

-- Adjustments: add-backs and deductions that normalize cash flow, and the items that bridge
-- the books to the return. Only evidenced or approved ones count in the figures.
create table if not exists public.om_adjustments (
  id               uuid primary key default gen_random_uuid(),
  model_id         uuid not null references public.om_models (id) on delete cascade,
  engagement_id    uuid not null references public.engagements (id) on delete cascade,
  entity_id        uuid references public.om_entities (id) on delete cascade,
  period           text not null,
  kind             text not null check (kind in ('addback', 'deduction', 'nonrecurring', 'elimination', 'book_tax')),
  applies_to       text not null default 'both' check (applies_to in ('cash_flow', 'tax', 'both')),
  label            text not null,
  amount           numeric(14, 2),
  evidence_status  text not null default 'proposed' check (evidence_status in ('proposed', 'evidenced', 'approved', 'rejected')),
  source           text,
  position         integer not null default 0,
  note             text,
  updated_by       uuid references public.profiles (id) on delete set null,
  updated_at       timestamptz not null default now()
);
create index if not exists om_adjustments_model_idx on public.om_adjustments (model_id, entity_id, period, position);

-- Properties: title, use, income, debt, and the basis the depreciation starts from.
create table if not exists public.om_properties (
  id                   uuid primary key default gen_random_uuid(),
  model_id             uuid not null references public.om_models (id) on delete cascade,
  engagement_id        uuid not null references public.engagements (id) on delete cascade,
  label                text not null,
  address              text,
  use                  text not null default 'commercial' check (use in ('restaurant', 'commercial', 'warehouse', 'residential', 'equine', 'mixed', 'land', 'personal')),
  owner_name           text,
  used_by_entity_id    uuid references public.om_entities (id) on delete set null,
  tenant               text,
  rent_source          text not null default 'none' check (rent_source in ('self', 'third_party', 'family', 'none')),
  se_business          boolean not null default false,   -- used in the owner's own trade: depreciation against business income
  passive              boolean not null default false,   -- a rental: losses limited by the passive activity rules
  acquired             date,
  placed_in_service    date,
  cost_basis           numeric(14, 2),
  land_pct             numeric(6, 2),
  land_value           numeric(14, 2),
  recovery_years       numeric(4, 1),                    -- 27.5 or 39; blank means by use
  prior_depreciation   numeric(14, 2),                   -- taken through the year before the study, if known
  bonus_elected_out    boolean not null default false,
  market_value         numeric(14, 2),
  debt_balance         numeric(14, 2),
  annual_debt_service  numeric(14, 2),
  annual_interest      numeric(14, 2),
  annual_rent          numeric(14, 2),
  annual_opex          numeric(14, 2),                   -- taxes, insurance, repairs, management
  seg_status           text not null default 'none' check (seg_status in ('none', 'estimated', 'study')),
  confidence           text not null default 'estimate' check (confidence in ('firm', 'estimate', 'unknown')),
  position             integer not null default 0,
  note                 text,
  updated_by           uuid references public.profiles (id) on delete set null,
  updated_at           timestamptz not null default now()
);
create index if not exists om_properties_model_idx on public.om_properties (model_id, position);

-- Cost segregation components: the share of a property's depreciable basis (or a fixed amount,
-- for a later improvement) in each recovery class.
create table if not exists public.om_components (
  id                 uuid primary key default gen_random_uuid(),
  model_id           uuid not null references public.om_models (id) on delete cascade,
  engagement_id      uuid not null references public.engagements (id) on delete cascade,
  property_id        uuid not null references public.om_properties (id) on delete cascade,
  label              text,
  category           text not null check (category in ('p5', 'p7', 'li15', 'qip', 'ag10', 'farm20', 'bldg')),
  pct                numeric(6, 2),
  amount             numeric(14, 2),
  acquired           date,
  placed_in_service  date,
  bonus_eligible     boolean not null default true,
  confidence         text not null default 'estimate' check (confidence in ('firm', 'estimate', 'unknown')),
  position           integer not null default 0,
  note               text,
  updated_by         uuid references public.profiles (id) on delete set null,
  updated_at         timestamptz not null default now()
);
create index if not exists om_components_prop_idx on public.om_components (property_id, position);

-- The findings register.
create table if not exists public.om_findings (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.om_models (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  ref            text,                                  -- 'F01'
  severity       text not null default 'high' check (severity in ('critical', 'high', 'medium', 'low')),
  area           text,                                  -- 'Books', 'Tax', 'Property', 'Financing', 'Project'
  entity_id      uuid references public.om_entities (id) on delete set null,
  period         text,
  observation    text not null,
  why            text,
  test           text,
  evidence       text,
  owner_label    text,                                  -- 'CPA', 'Bookkeeper', 'Borrower'...
  owner_id       uuid references public.profiles (id) on delete set null,
  status         text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'dismissed')),
  resolution     text,
  position       integer not null default 0,
  updated_by     uuid references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now()
);
create index if not exists om_findings_model_idx on public.om_findings (model_id, position);

-- Assumptions, as in the project model: a value, a status, and who confirms it.
create table if not exists public.om_inputs (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.om_models (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  key            text not null,
  section        text not null,
  label          text not null,
  hint           text,
  unit           text not null default 'usd' check (unit in ('usd', 'pct', 'months', 'years', 'x', 'date', 'count', 'sf', 'text')),
  value          numeric(16, 4),
  text_value     text,
  status         text not null default 'unknown' check (status in ('confirmed', 'estimate', 'unknown')),
  owner_id       uuid references public.profiles (id) on delete set null,
  position       integer not null default 0,
  updated_by     uuid references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now(),
  unique (model_id, key)
);
create table if not exists public.om_input_log (
  id             uuid primary key default gen_random_uuid(),
  input_id       uuid not null references public.om_inputs (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  old_value      numeric(16, 4),
  new_value      numeric(16, 4),
  old_text       text,
  new_text       text,
  old_status     text,
  new_status     text,
  note           text,
  changed_by     uuid references public.profiles (id) on delete set null,
  changed_at     timestamptz not null default now()
);
create index if not exists om_input_log_idx on public.om_input_log (input_id, changed_at desc);

create table if not exists public.om_comments (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.om_models (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  target_kind    text not null check (target_kind in ('model', 'entity', 'period', 'adjustment', 'property', 'component', 'finding', 'input')),
  target_id      uuid,
  target_label   text,
  author_id      uuid references public.profiles (id) on delete set null default auth.uid(),
  body           text not null check (length(body) between 1 and 4000),
  created_at     timestamptz not null default now()
);
create index if not exists om_comments_model_idx on public.om_comments (model_id, created_at);

create table if not exists public.om_snapshots (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.om_models (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  label          text not null,
  data           jsonb not null,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now()
);

-- Set an assumption. Michael may set any; anyone else who can see the model, the ones they're
-- asked to confirm. Logged, and it answers the matching request.
create or replace function public.om_set_input(input uuid, p_value numeric, p_text text, p_status text, p_note text default null)
returns public.om_inputs language plpgsql security definer set search_path = public as $$
declare i public.om_inputs; before public.om_inputs; shown text;
begin
  select * into before from public.om_inputs where id = input;
  if not found then raise exception 'That item no longer exists.'; end if;
  if not (public.is_admin() or coalesce(public.can_see_model(before.engagement_id) and before.owner_id = auth.uid(), false)) then
    raise exception 'Only the person asked to confirm this can change it.';
  end if;
  if p_status not in ('confirmed', 'estimate', 'unknown') then raise exception 'Unknown status.'; end if;
  if p_text is not null and before.unit = 'date' and p_text !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Use a month like 2027-03.'; end if;
  if p_text is not null and before.unit = 'text' and length(p_text) > 80 then raise exception 'Keep it to 80 characters.'; end if;
  update public.om_inputs
     set value = p_value, text_value = nullif(btrim(p_text), ''), status = p_status, updated_by = auth.uid(), updated_at = now()
   where id = input returning * into i;
  if i.value is distinct from before.value or i.text_value is distinct from before.text_value or i.status is distinct from before.status or nullif(btrim(p_note), '') is not null then
    insert into public.om_input_log (input_id, engagement_id, old_value, new_value, old_text, new_text, old_status, new_status, note, changed_by)
    values (i.id, i.engagement_id, before.value, i.value, before.text_value, i.text_value, before.status, i.status, nullif(btrim(p_note), ''), auth.uid());
  end if;
  if not public.is_admin() and i.status <> 'unknown' then
    shown := coalesce(i.text_value, case when i.value is null then 'blank' else trim(to_char(i.value, 'FM999,999,999,990.##')) end);
    update public.action_items
       set status = 'submitted', submitted_at = now(), submitted_by = auth.uid(),
           response = 'Set to ' || shown || case when i.status = 'estimate' then ' (estimate)' else '' end
                      || coalesce('. ' || nullif(btrim(p_note), ''), '')
     where link_kind = 'om_input' and link_ref = i.id and status in ('open', 'changes_requested');
  end if;
  update public.om_models set updated_at = now() where id = i.model_id;
  return i;
end;
$$;

-- Michael asks someone to confirm an assumption: they become its owner and get a request.
create or replace function public.om_ask_input(input uuid, who uuid, p_due date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare i public.om_inputs; req uuid; client uuid;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into i from public.om_inputs where id = input;
  if not found then raise exception 'That item no longer exists.'; end if;
  select client_id into client from public.engagements where id = i.engagement_id;
  if who is distinct from client and not exists (
       select 1 from public.engagement_members m where m.engagement_id = i.engagement_id and m.user_id = who
          and m.status = 'active' and m.can_model and (m.expires_at is null or m.expires_at > now())) then
    raise exception 'Give them access to the model first.';
  end if;
  update public.om_inputs set owner_id = who where id = input;
  insert into public.action_items (engagement_id, kind, link_kind, link_ref, assignee_id, created_by, position, title, detail, due_date)
  values (i.engagement_id, 'answer', 'om_input', i.id, case when who = client then null else who end, auth.uid(), 0,
          'Confirm: ' || i.label, coalesce(i.hint, 'Set it in the Books and tax tab; it updates the whole model.'), p_due)
  returning id into req;
  return req;
end;
$$;

-- Michael assigns a finding to someone with model access; they get a request to resolve it.
create or replace function public.om_ask_finding(finding uuid, who uuid, p_due date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare f public.om_findings; req uuid; client uuid;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into f from public.om_findings where id = finding;
  if not found then raise exception 'That finding no longer exists.'; end if;
  select client_id into client from public.engagements where id = f.engagement_id;
  if who is distinct from client and not exists (
       select 1 from public.engagement_members m where m.engagement_id = f.engagement_id and m.user_id = who
          and m.status = 'active' and m.can_model and (m.expires_at is null or m.expires_at > now())) then
    raise exception 'Give them access to the model first.';
  end if;
  update public.om_findings set owner_id = who, status = case when status = 'open' then 'in_progress' else status end where id = finding;
  insert into public.action_items (engagement_id, kind, link_kind, link_ref, assignee_id, created_by, position, title, detail, due_date)
  values (f.engagement_id, 'answer', 'om_finding', f.id, case when who = client then null else who end, auth.uid(), 0,
          coalesce(f.ref || ': ', '') || left(f.observation, 120), coalesce(f.evidence, f.test, 'See the finding in the Books and tax tab.'), p_due)
  returning id into req;
  return req;
end;
$$;

create or replace function public.notify_owner_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text := public.display_name(auth.uid());
begin
  if tg_table_name = 'om_comments' then
    perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'model'), 'comment',
      who || ' commented' || coalesce(' on ' || new.target_label, ''), left(new.body, 160), 'owner');
  elsif tg_table_name = 'om_inputs' then
    if not public.is_admin() and (new.value is distinct from old.value or new.text_value is distinct from old.text_value or new.status is distinct from old.status) then
      perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'private'), 'model',
        who || ' updated ' || new.label, case when new.status = 'confirmed' then 'Confirmed' else 'Marked ' || new.status end, 'owner');
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists notify_owner_comment on public.om_comments;
create trigger notify_owner_comment after insert on public.om_comments for each row execute function public.notify_owner_event();
drop trigger if exists notify_owner_input on public.om_inputs;
create trigger notify_owner_input after update on public.om_inputs for each row execute function public.notify_owner_event();

-- ===========================================================================
-- Row level security: Michael edits; the client and advisers with model access read, set
-- the assumptions assigned to them (through om_set_input), comment, and save versions.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['om_models', 'om_entities', 'om_periods', 'om_adjustments', 'om_properties', 'om_components', 'om_findings', 'om_inputs', 'om_snapshots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: admin" on public.%I', t, t);
    execute format('create policy "%s: admin" on public.%I for all using (public.is_admin()) with check (public.is_admin())', t, t);
    execute format('drop policy if exists "%s: read" on public.%I', t, t);
    execute format('create policy "%s: read" on public.%I for select using (public.can_see_model(engagement_id))', t, t);
  end loop;
end $$;
alter table public.om_input_log enable row level security;
drop policy if exists "om input log: read" on public.om_input_log;
create policy "om input log: read" on public.om_input_log for select using (public.can_see_model(engagement_id));

alter table public.om_comments enable row level security;
drop policy if exists "om comments: admin" on public.om_comments;
create policy "om comments: admin" on public.om_comments for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "om comments: read" on public.om_comments;
create policy "om comments: read" on public.om_comments for select using (public.can_see_model(engagement_id));
drop policy if exists "om comments: add" on public.om_comments;
create policy "om comments: add" on public.om_comments for insert with check (
  public.can_see_model(engagement_id) and author_id = auth.uid()
  and model_id in (select m.id from public.om_models m where m.engagement_id = om_comments.engagement_id));
drop policy if exists "om comments: remove own" on public.om_comments;
create policy "om comments: remove own" on public.om_comments for delete using (author_id = auth.uid());

drop policy if exists "om_snapshots: client add" on public.om_snapshots;
create policy "om_snapshots: client add" on public.om_snapshots for insert with check (
  public.owns_engagement(engagement_id) and created_by = auth.uid()
  and model_id in (select m.id from public.om_models m where m.engagement_id = om_snapshots.engagement_id));

-- ===========================================================================
-- Live updates
-- ===========================================================================
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['om_entities', 'om_periods', 'om_adjustments', 'om_properties', 'om_components', 'om_findings', 'om_inputs', 'om_comments'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ===========================================================================
-- Function access
-- ===========================================================================
revoke execute on function public.om_set_input(uuid, numeric, text, text, text) from public, anon;
revoke execute on function public.om_ask_input(uuid, uuid, date) from public, anon;
revoke execute on function public.om_ask_finding(uuid, uuid, date) from public, anon;
grant execute on function public.om_set_input(uuid, numeric, text, text, text) to authenticated;
grant execute on function public.om_ask_input(uuid, uuid, date) to authenticated;
grant execute on function public.om_ask_finding(uuid, uuid, date) to authenticated;
revoke execute on function public.notify_owner_event() from public, anon, authenticated;
