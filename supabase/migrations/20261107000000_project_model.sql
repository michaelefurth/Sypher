-- Sypher Solutions: the project model. Total project cost, sources and uses, cash flow and
-- coverage, linked to the contractor's pricing sheet. Run after 20261106000000_action_center.sql.
--
-- A model belongs to an engagement and (optionally) one pricing sheet, whose lines are the
-- hard costs. Around them sit the other cost lines (land, allowances, soft and opening costs,
-- financing), and the assumptions (inputs) the calculations use: loan terms, timing, operating
-- figures, the existing businesses' cash flow. Each input has a status and a person who should
-- confirm it; that person may set it (every change is logged) and anyone who can see the model
-- may comment on any line or input.
--
-- Who can see it: Michael, the client, and team members the client or Michael tick ("can see
-- the project model"). Never the contractor on a pricing sheet: the database refuses to give a
-- sheet's contractor model access, and refuses to make someone with model access a contractor.

-- ===========================================================================
-- Access
-- ===========================================================================
alter table public.engagement_members add column if not exists can_model boolean not null default false;
alter table public.action_items add column if not exists link_kind text;   -- 'sov_sheet' | 'pm_input'

create or replace function public.is_contractor(eng uuid, who uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sov_sheets s where s.engagement_id = eng and s.contractor_id = who);
$$;

-- May the signed-in user see the project model (and the budget behind the pricing sheet)?
create or replace function public.can_see_model(eng uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.owns_engagement(eng)
      or (public.is_member(eng)
          and exists (select 1 from public.engagement_members m
                       where m.engagement_id = eng and m.user_id = auth.uid() and m.can_model)
          and not public.is_contractor(eng, auth.uid()));
$$;

-- The client or Michael ticks (or unticks) model access for a team member.
create or replace function public.set_member_model(member uuid, allow boolean)
returns void language plpgsql security definer set search_path = public as $$
declare m public.engagement_members;
begin
  select * into m from public.engagement_members where id = member;
  if not found or not (public.owns_engagement(m.engagement_id) or public.is_admin()) then raise exception 'not allowed'; end if;
  if allow and public.is_contractor(m.engagement_id, m.user_id) then
    raise exception 'The contractor on a pricing sheet can''t see the project model or the budget.';
  end if;
  update public.engagement_members set can_model = allow where id = member;
end;
$$;

-- Never make someone who can see the budget the contractor who prices against it.
create or replace function public.sov_contractor_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.contractor_id is not null
     and exists (select 1 from public.engagement_members m
                  where m.engagement_id = new.engagement_id and m.user_id = new.contractor_id and m.can_model) then
    raise exception 'This person can see the project budget. Turn off their model access before making them the contractor.';
  end if;
  return new;
end;
$$;
drop trigger if exists sov_contractor_guard on public.sov_sheets;
create trigger sov_contractor_guard before insert or update of contractor_id on public.sov_sheets
  for each row execute function public.sov_contractor_guard();

-- Model viewers (an accountant, a lender) read the pricing sheet and its budget too.
create or replace function public.sov_can_read(sheet uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sov_sheets s
     where s.id = sheet and (
       public.is_admin() or public.owns_engagement(s.engagement_id)
       or (s.contractor_id = auth.uid() and public.is_member(s.engagement_id))
       or public.can_see_model(s.engagement_id)));
$$;
drop policy if exists "sov budget: client read" on public.sov_budget;
drop policy if exists "sov budget: model read" on public.sov_budget;
create policy "sov budget: model read" on public.sov_budget for select using (public.can_see_model(engagement_id));

-- The roster now says who can see the model.
create or replace function public.team_roster(eng uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare manager boolean := public.owns_engagement(eng) or public.is_admin();
begin
  if not (manager or public.is_member(eng)) then return null; end if;
  return jsonb_build_object(
    'client', (select jsonb_build_object('user_id', p.id, 'name', coalesce(p.full_name, p.email), 'organization', p.company)
                 from public.engagements e join public.profiles p on p.id = e.client_id where e.id = eng),
    'principals', (select coalesce(jsonb_agg(jsonb_build_object('user_id', p.id, 'name', coalesce(p.full_name, p.email))), '[]'::jsonb)
                     from public.profiles p where p.role = 'admin'),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', m.id, 'user_id', m.user_id, 'name', coalesce(m.full_name, m.email),
                   'email', case when manager then m.email end,
                   'organization', m.organization, 'role_label', m.role_label,
                   'can_message', m.can_message, 'can_files', m.can_files, 'can_model', m.can_model, 'expires_at', m.expires_at,
                   'status', case when m.status = 'revoked' then 'revoked'
                                  when m.expires_at is not null and m.expires_at <= now() then 'expired' else 'active' end,
                   'last_seen_at', m.last_seen_at, 'created_at', m.created_at) order by m.created_at), '[]'::jsonb)
                  from public.engagement_members m
                  where m.engagement_id = eng
                    and (manager or (m.status = 'active' and (m.expires_at is null or m.expires_at > now()))))
  );
end;
$$;

-- Alert audiences gain 'model': the client, Michael and members who can see the model.
create or replace function public.audience(eng uuid, scope text)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct u), '{}') from (
    select e.client_id u from public.engagements e where e.id = eng
    union select p.id from public.profiles p where p.role = 'admin'
    union select m.user_id from public.engagement_members m join public.engagements e on e.id = m.engagement_id
     where scope <> 'private' and m.engagement_id = eng and m.status = 'active'
       and (m.expires_at is null or m.expires_at > now()) and e.status = 'active'
       and (scope = 'everyone' or (scope = 'team' and m.can_message) or (scope = 'files' and m.can_files)
            or (scope = 'model' and m.can_model and not public.is_contractor(eng, m.user_id)))
  ) s where u is not null;
$$;

-- ===========================================================================
-- The model
-- ===========================================================================
create table if not exists public.pm_models (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  title          text not null,
  sov_sheet_id   uuid references public.sov_sheets (id) on delete set null,
  building_sf    numeric(12, 2),
  notes          text,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists pm_models_eng_idx on public.pm_models (engagement_id);

-- Cost lines other than the pricing sheet's: land, allowances, soft and opening, financing.
create table if not exists public.pm_lines (
  id              uuid primary key default gen_random_uuid(),
  model_id        uuid not null references public.pm_models (id) on delete cascade,
  engagement_id   uuid not null references public.engagements (id) on delete cascade,
  grp             text not null check (grp in ('land', 'hard', 'allowance', 'soft', 'financing')),
  position        integer not null default 0,
  label           text not null,
  low             numeric(14, 2),
  base            numeric(14, 2),
  high            numeric(14, 2),
  committed       numeric(14, 2),                        -- signed contract or accepted quote
  paid            numeric(14, 2),                        -- paid to date
  -- Calculated lines: a percent of hard cost, the contractor's overhead and profit, the loan
  -- fee (a percent of the loan) or interest during construction (worked out from the draws).
  calc            text check (calc is null or calc in ('pct_hard', 'ohp', 'loan_fee', 'interest')),
  pct_low         numeric(7, 3),
  pct_base        numeric(7, 3),
  pct_high        numeric(7, 3),
  confidence      text not null default 'estimate' check (confidence in ('firm', 'estimate', 'unknown')),
  responsible_id  uuid references public.profiles (id) on delete set null,
  -- When the money goes out: at closing, over design and permitting, over construction (an
  -- S-curve), at opening, or from a month after closing for some months.
  timing          text not null default 'construction' check (timing in ('closing', 'design', 'construction', 'opening', 'custom')),
  timing_start    integer,
  timing_months   integer,
  note            text,
  updated_by      uuid references public.profiles (id) on delete set null,
  updated_at      timestamptz not null default now()
);
create index if not exists pm_lines_model_idx on public.pm_lines (model_id, grp, position);

-- Assumptions. Each has a value, a status and the person who should confirm it.
create table if not exists public.pm_inputs (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.pm_models (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  key            text not null,
  section        text not null,
  label          text not null,
  hint           text,
  unit           text not null default 'usd' check (unit in ('usd', 'pct', 'months', 'years', 'x', 'date', 'count', 'sf')),
  value          numeric(16, 4),
  text_value     text,                                   -- dates as YYYY-MM
  status         text not null default 'unknown' check (status in ('confirmed', 'estimate', 'unknown')),
  owner_id       uuid references public.profiles (id) on delete set null,
  position       integer not null default 0,
  updated_by     uuid references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now(),
  unique (model_id, key)
);

create table if not exists public.pm_input_log (
  id             uuid primary key default gen_random_uuid(),
  input_id       uuid not null references public.pm_inputs (id) on delete cascade,
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
create index if not exists pm_input_log_idx on public.pm_input_log (input_id, changed_at desc);

create table if not exists public.pm_comments (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.pm_models (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  target_kind    text not null check (target_kind in ('model', 'line', 'input', 'sov_line')),
  target_id      uuid,
  target_label   text,
  author_id      uuid references public.profiles (id) on delete set null default auth.uid(),
  body           text not null check (length(body) between 1 and 4000),
  created_at     timestamptz not null default now()
);
create index if not exists pm_comments_model_idx on public.pm_comments (model_id, created_at);

-- A dated copy of the figures (e.g. the version sent to the lender).
create table if not exists public.pm_snapshots (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.pm_models (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  label          text not null,
  data           jsonb not null,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now()
);

-- Set an assumption. Michael may set any; anyone else who can see the model, the ones they're
-- asked to confirm. Logged, and it answers the matching request.
create or replace function public.pm_set_input(input uuid, p_value numeric, p_text text, p_status text, p_note text default null)
returns public.pm_inputs language plpgsql security definer set search_path = public as $$
declare i public.pm_inputs; before public.pm_inputs; shown text;
begin
  select * into before from public.pm_inputs where id = input;
  if not found then raise exception 'That item no longer exists.'; end if;
  -- coalesce: an unassigned item (owner_id null) must read as 'not yours', never as unknown.
  if not (public.is_admin() or coalesce(public.can_see_model(before.engagement_id) and before.owner_id = auth.uid(), false)) then
    raise exception 'Only the person asked to confirm this can change it.';
  end if;
  if p_status not in ('confirmed', 'estimate', 'unknown') then raise exception 'Unknown status.'; end if;
  if p_text is not null and before.unit = 'date' and p_text !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Use a month like 2027-03.'; end if;
  update public.pm_inputs
     set value = p_value, text_value = nullif(btrim(p_text), ''), status = p_status, updated_by = auth.uid(), updated_at = now()
   where id = input returning * into i;
  if i.value is distinct from before.value or i.text_value is distinct from before.text_value or i.status is distinct from before.status or nullif(btrim(p_note), '') is not null then
    insert into public.pm_input_log (input_id, engagement_id, old_value, new_value, old_text, new_text, old_status, new_status, note, changed_by)
    values (i.id, i.engagement_id, before.value, i.value, before.text_value, i.text_value, before.status, i.status, nullif(btrim(p_note), ''), auth.uid());
  end if;
  -- The person asked has answered: the request moves to review.
  if not public.is_admin() and i.status <> 'unknown' then
    shown := coalesce(i.text_value, case when i.value is null then 'blank' else trim(to_char(i.value, 'FM999,999,999,990.##')) end);
    update public.action_items
       set status = 'submitted', submitted_at = now(), submitted_by = auth.uid(),
           response = 'Set to ' || shown || case when i.status = 'estimate' then ' (estimate)' else '' end
                      || coalesce('. ' || nullif(btrim(p_note), ''), '')
     where link_kind = 'pm_input' and link_ref = i.id and status in ('open', 'changes_requested');
  end if;
  update public.pm_models set updated_at = now() where id = i.model_id;
  return i;
end;
$$;

-- Michael asks someone to confirm an assumption: they become its owner and get a request.
create or replace function public.pm_ask_input(input uuid, who uuid, p_due date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare i public.pm_inputs; req uuid; client uuid;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into i from public.pm_inputs where id = input;
  if not found then raise exception 'That item no longer exists.'; end if;
  select client_id into client from public.engagements where id = i.engagement_id;
  if who is distinct from client and not exists (
       select 1 from public.engagement_members m where m.engagement_id = i.engagement_id and m.user_id = who
          and m.status = 'active' and m.can_model and (m.expires_at is null or m.expires_at > now())) then
    raise exception 'Give them access to the project model first.';
  end if;
  update public.pm_inputs set owner_id = who where id = input;
  insert into public.action_items (engagement_id, kind, link_kind, link_ref, assignee_id, created_by, position, title, detail, due_date)
  values (i.engagement_id, 'answer', 'pm_input', i.id, case when who = client then null else who end, auth.uid(), 0,
          'Confirm: ' || i.label, coalesce(i.hint, 'Set it in the Project tab; it updates the whole model.'), p_due)
  returning id into req;
  return req;
end;
$$;

create or replace function public.notify_model_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text := public.display_name(auth.uid());
begin
  if tg_table_name = 'pm_comments' then
    perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'model'), 'comment',
      who || ' commented' || coalesce(' on ' || new.target_label, ''), left(new.body, 160), 'project');
  elsif tg_table_name = 'pm_inputs' then
    if not public.is_admin() and (new.value is distinct from old.value or new.text_value is distinct from old.text_value or new.status is distinct from old.status) then
      perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'private'), 'model',
        who || ' updated ' || new.label, case when new.status = 'confirmed' then 'Confirmed' else 'Marked ' || new.status end, 'project');
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists notify_model_comment on public.pm_comments;
create trigger notify_model_comment after insert on public.pm_comments for each row execute function public.notify_model_event();
drop trigger if exists notify_model_input on public.pm_inputs;
create trigger notify_model_input after update on public.pm_inputs for each row execute function public.notify_model_event();

-- ===========================================================================
-- Row level security
-- ===========================================================================
alter table public.pm_models    enable row level security;
alter table public.pm_lines     enable row level security;
alter table public.pm_inputs    enable row level security;
alter table public.pm_input_log enable row level security;
alter table public.pm_comments  enable row level security;
alter table public.pm_snapshots enable row level security;

drop policy if exists "pm models: admin" on public.pm_models;
create policy "pm models: admin" on public.pm_models for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "pm models: read" on public.pm_models;
create policy "pm models: read" on public.pm_models for select using (public.can_see_model(engagement_id));

drop policy if exists "pm lines: admin" on public.pm_lines;
create policy "pm lines: admin" on public.pm_lines for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "pm lines: read" on public.pm_lines;
create policy "pm lines: read" on public.pm_lines for select using (public.can_see_model(engagement_id));

drop policy if exists "pm inputs: admin" on public.pm_inputs;
create policy "pm inputs: admin" on public.pm_inputs for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "pm inputs: read" on public.pm_inputs;
create policy "pm inputs: read" on public.pm_inputs for select using (public.can_see_model(engagement_id));

drop policy if exists "pm input log: read" on public.pm_input_log;
create policy "pm input log: read" on public.pm_input_log for select using (public.can_see_model(engagement_id));

drop policy if exists "pm comments: admin" on public.pm_comments;
create policy "pm comments: admin" on public.pm_comments for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "pm comments: read" on public.pm_comments;
create policy "pm comments: read" on public.pm_comments for select using (public.can_see_model(engagement_id));
drop policy if exists "pm comments: add" on public.pm_comments;
create policy "pm comments: add" on public.pm_comments for insert with check (
  public.can_see_model(engagement_id) and author_id = auth.uid()
  and model_id in (select m.id from public.pm_models m where m.engagement_id = pm_comments.engagement_id));
drop policy if exists "pm comments: remove own" on public.pm_comments;
create policy "pm comments: remove own" on public.pm_comments for delete using (author_id = auth.uid());

drop policy if exists "pm snapshots: admin" on public.pm_snapshots;
create policy "pm snapshots: admin" on public.pm_snapshots for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "pm snapshots: read" on public.pm_snapshots;
create policy "pm snapshots: read" on public.pm_snapshots for select using (public.can_see_model(engagement_id));
drop policy if exists "pm snapshots: client add" on public.pm_snapshots;
create policy "pm snapshots: client add" on public.pm_snapshots for insert with check (
  public.owns_engagement(engagement_id) and created_by = auth.uid()
  and model_id in (select m.id from public.pm_models m where m.engagement_id = pm_snapshots.engagement_id));

-- ===========================================================================
-- Live updates
-- ===========================================================================
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['pm_lines', 'pm_inputs', 'pm_comments', 'sov_budget'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ===========================================================================
-- Function access
-- ===========================================================================
revoke execute on function public.is_contractor(uuid, uuid) from public, anon;
revoke execute on function public.can_see_model(uuid) from public, anon;
revoke execute on function public.set_member_model(uuid, boolean) from public, anon;
revoke execute on function public.pm_set_input(uuid, numeric, text, text, text) from public, anon;
revoke execute on function public.pm_ask_input(uuid, uuid, date) from public, anon;
grant execute on function public.is_contractor(uuid, uuid) to authenticated;
grant execute on function public.can_see_model(uuid) to authenticated;
grant execute on function public.set_member_model(uuid, boolean) to authenticated;
grant execute on function public.pm_set_input(uuid, numeric, text, text, text) to authenticated;
grant execute on function public.pm_ask_input(uuid, uuid, date) to authenticated;
revoke execute on function public.sov_contractor_guard() from public, anon, authenticated;
revoke execute on function public.notify_model_event() from public, anon, authenticated;
revoke execute on function public.audience(uuid, text) from public, anon, authenticated;
