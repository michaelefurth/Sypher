-- Sypher Solutions: requests, notifications and the schedule of values.
-- Run after 20261105000000_security_hardening.sql (the deploy workflow applies it on merge).
--
-- 1. Requests. A to-do becomes a request with a kind (task, document, answer, approval,
--    pricing) and a status (open, submitted, accepted, changes requested). Anyone on an
--    engagement can ask anyone else on it. Files sent in answer to a request are private to
--    the people on that request.
-- 2. Notifications. One row per person per event, written by triggers, and only for things
--    that person is allowed to see. They drive the bell in the portal and its unread counts.
-- 3. Schedule of values. A contractor prices a sheet of lines with autosave; the owner side
--    keeps a budget for each line in a separate table the contractor cannot read.

-- ===========================================================================
-- 1. Requests
-- ===========================================================================
alter table public.action_items add column if not exists kind text not null default 'task';
alter table public.action_items add column if not exists status text not null default 'open';
alter table public.action_items add column if not exists response text;
alter table public.action_items add column if not exists submitted_at timestamptz;
alter table public.action_items add column if not exists submitted_by uuid references public.profiles (id) on delete set null;
alter table public.action_items add column if not exists reviewed_at timestamptz;
alter table public.action_items add column if not exists review_note text;
alter table public.action_items add column if not exists link_ref uuid;   -- e.g. the pricing sheet for kind 'pricing'
do $$ begin
  alter table public.action_items add constraint action_items_kind_check
    check (kind in ('task', 'document', 'answer', 'approval', 'pricing'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.action_items add constraint action_items_status_check
    check (status in ('open', 'submitted', 'accepted', 'changes_requested'));
exception when duplicate_object then null; end $$;
update public.action_items set status = 'accepted' where done_at is not null and status = 'open';
create index if not exists action_items_assignee_idx on public.action_items (assignee_id) where done_at is null;

-- Can the signed-in user see this request? The client and Michael see every request on the
-- engagement; a team member sees the requests they asked or were asked.
create or replace function public.is_request_participant(req uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.action_items a
    where a.id = req and (
      public.is_admin() or public.owns_engagement(a.engagement_id)
      or (public.is_member(a.engagement_id) and (a.assignee_id = auth.uid() or a.created_by = auth.uid()))));
$$;

-- May the signed-in user answer it? The person asked (the client when nobody is named),
-- or Michael on anyone's behalf.
create or replace function public.may_respond(req uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.action_items a
    where a.id = req and (
      public.is_admin()
      or (a.assignee_id is null and public.owns_engagement(a.engagement_id))
      or (a.assignee_id = auth.uid() and (public.owns_engagement(a.engagement_id) or public.is_member(a.engagement_id)))));
$$;

-- May the signed-in user accept it or ask for changes? Michael, whoever asked, or the client
-- for anything asked of someone else on their engagement.
create or replace function public.may_review(req uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.action_items a
    where a.id = req and (
      public.is_admin()
      or (a.created_by = auth.uid() and public.is_request_participant(req))
      or (public.owns_engagement(a.engagement_id) and a.assignee_id is not null and a.assignee_id <> auth.uid())));
$$;

-- May this person be asked for something on this engagement? Nobody named (the client),
-- Michael, or an active team member. Reads tables the asker can't, so it is a definer function.
create or replace function public.may_be_asked(eng uuid, who uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select who is null
      or exists (select 1 from public.profiles p where p.id = who and p.role = 'admin')
      or exists (select 1 from public.engagement_members m
                  where m.engagement_id = eng and m.user_id = who and m.status = 'active'
                    and (m.expires_at is null or m.expires_at > now()));
$$;

-- Answer a request. A plain task is done at once; anything else waits for review.
create or replace function public.submit_request(req uuid, note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a public.action_items;
begin
  if not public.may_respond(req) then raise exception 'not allowed'; end if;
  select * into a from public.action_items where id = req;
  if a.status = 'accepted' then raise exception 'This request is already complete.'; end if;
  if a.kind = 'task' then
    update public.action_items
       set status = 'accepted', done_at = now(), done_by = auth.uid(), submitted_at = now(), submitted_by = auth.uid(),
           response = coalesce(nullif(btrim(note), ''), response)
     where id = req;
    insert into public.activity (engagement_id, kind, detail) values (a.engagement_id, 'action_done', jsonb_build_object('title', a.title));
  else
    update public.action_items
       set status = 'submitted', submitted_at = now(), submitted_by = auth.uid(),
           response = coalesce(nullif(btrim(note), ''), response)
     where id = req;
    insert into public.activity (engagement_id, kind, detail) values (a.engagement_id, 'request_submitted', jsonb_build_object('title', a.title));
  end if;
end;
$$;

-- Accept a submitted request, or send it back with a note.
create or replace function public.review_request(req uuid, accept boolean, note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a public.action_items;
begin
  if not public.may_review(req) then raise exception 'not allowed'; end if;
  select * into a from public.action_items where id = req;
  if a.status <> 'submitted' then raise exception 'There is nothing to review on this request.'; end if;
  if not accept and nullif(btrim(note), '') is null then raise exception 'Say what needs to change.'; end if;
  update public.action_items
     set status = case when accept then 'accepted' else 'changes_requested' end,
         done_at = case when accept then now() else null end,
         done_by = case when accept then auth.uid() else null end,
         reviewed_at = now(), review_note = nullif(btrim(note), '')
   where id = req;
  insert into public.activity (engagement_id, kind, detail)
  values (a.engagement_id, case when accept then 'request_accepted' else 'request_changes' end, jsonb_build_object('title', a.title));
end;
$$;

-- Ticking a plain task keeps its status in step.
create or replace function public.set_action_item_done(item uuid, done boolean)
returns void language plpgsql security definer set search_path = public as $$
declare eng uuid; t text; who uuid;
begin
  select engagement_id, title, assignee_id into eng, t, who from public.action_items where id = item;
  -- coalesce: an unassigned task (who is null) must read as "not yours", never as unknown.
  if eng is null or not (public.owns_engagement(eng) or public.is_admin() or coalesce(who = auth.uid() and public.is_member(eng), false)) then
    raise exception 'not allowed';
  end if;
  update public.action_items
     set done_at = case when done then coalesce(done_at, now()) else null end,
         done_by = case when done then coalesce(done_by, auth.uid()) else null end,
         status  = case when done then 'accepted' else 'open' end
   where id = item;
  if done then
    insert into public.activity (engagement_id, kind, detail)
    values (eng, 'action_done', jsonb_build_object('title', t));
  end if;
end;
$$;

-- Everyone a request can go to, for the "ask someone" picker. Members get names and roles only.
create or replace function public.request_parties(eng uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.owns_engagement(eng) or public.is_member(eng)) then
    raise exception 'not allowed';
  end if;
  return coalesce((
    select jsonb_agg(p order by p->>'order', p->>'name') from (
      select jsonb_build_object('id', e.client_id, 'name', coalesce(pr.full_name, pr.email), 'role', 'Client', 'org', pr.company, 'order', '1') p
        from public.engagements e join public.profiles pr on pr.id = e.client_id where e.id = eng
      union all
      select jsonb_build_object('id', pr.id, 'name', coalesce(pr.full_name, 'Michael Furth'), 'role', 'Sypher Solutions', 'org', null, 'order', '2')
        from public.profiles pr where pr.role = 'admin'
      union all
      select jsonb_build_object('id', m.user_id, 'name', coalesce(m.full_name, split_part(m.email, '@', 1)), 'role', coalesce(m.role_label, 'Team'), 'org', m.organization, 'order', '3')
        from public.engagement_members m
       where m.engagement_id = eng and m.status = 'active' and (m.expires_at is null or m.expires_at > now())
    ) s), '[]'::jsonb);
end;
$$;

-- Files sent in answer to a request: private to the people on it.
create table if not exists public.request_files (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.action_items (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  path           text not null,
  name           text not null,
  size           bigint,
  uploaded_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now()
);
create index if not exists request_files_req_idx on public.request_files (request_id);

-- Storage paths for request files: <engagement>/requests/<request>/<file>.
create or replace function public.request_in_path(name text)
returns uuid language sql stable security definer set search_path = public as $$
  select a.id from public.action_items a
   where name ~ '^[0-9a-fA-F-]{36}/requests/[0-9a-fA-F-]{36}/'
     and a.id = (split_part(name, '/', 3))::uuid
     and a.engagement_id = (split_part(name, '/', 1))::uuid;
$$;

-- ===========================================================================
-- 2. Notifications
-- ===========================================================================
create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  engagement_id  uuid references public.engagements (id) on delete cascade,
  kind           text not null,
  title          text not null,
  body           text,
  link           text,                                   -- where it opens: requests, pricing, messages, documents, plan, files
  actor          uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  read_at        timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- Who on an engagement may see a kind of thing: 'private' (client and Michael), 'team'
-- (plus members who can message), 'files' (plus members who can share files), 'everyone'.
create or replace function public.audience(eng uuid, scope text)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct u), '{}') from (
    select e.client_id u from public.engagements e where e.id = eng
    union select p.id from public.profiles p where p.role = 'admin'
    union select m.user_id from public.engagement_members m join public.engagements e on e.id = m.engagement_id
     where scope <> 'private' and m.engagement_id = eng and m.status = 'active'
       and (m.expires_at is null or m.expires_at > now()) and e.status = 'active'
       and (scope = 'everyone' or (scope = 'team' and m.can_message) or (scope = 'files' and m.can_files))
  ) s where u is not null;
$$;

create or replace function public.display_name(who uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case when p.role = 'admin' then coalesce(p.full_name, 'Michael Furth') else coalesce(p.full_name, split_part(p.email, '@', 1)) end
       from public.profiles p where p.id = who),
    'Someone');
$$;

-- Write one notification per recipient, never to the person who caused it.
create or replace function public.notify(eng uuid, recipients uuid[], p_kind text, p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, engagement_id, kind, title, body, link, actor)
  select distinct r, eng, p_kind, left(p_title, 200), left(p_body, 400), p_link, auth.uid()
    from unnest(recipients) r
   where r is not null and r is distinct from auth.uid();
$$;

create or replace function public.mark_notifications_read(ids uuid[] default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (ids is null or id = any(ids));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ===========================================================================
-- 3. Schedule of values
-- ===========================================================================
create table if not exists public.sov_sheets (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  title          text not null,
  intro          text,                                   -- what we need, shown at the top of the sheet
  contractor_id  uuid references public.profiles (id) on delete set null,
  status         text not null default 'not_started'
                 check (status in ('not_started', 'in_progress', 'submitted', 'changes_requested', 'accepted')),
  building_sf    numeric(12, 2),
  location       text,
  valid_until    date,
  schedule_note  text,
  ohp_pct        numeric(6, 3),                          -- overhead and profit on the subtotal
  ohp_basis      text,
  basis_note     text,
  version        integer not null default 0,
  submitted_at   timestamptz,
  reviewed_at    timestamptz,
  review_note    text,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists sov_sheets_eng_idx on public.sov_sheets (engagement_id);

create table if not exists public.sov_lines (
  id               uuid primary key default gen_random_uuid(),
  sheet_id         uuid not null references public.sov_sheets (id) on delete cascade,
  engagement_id    uuid not null references public.engagements (id) on delete cascade,
  position         integer not null default 0,
  section          text,                                 -- "Building", "Owner items", "Site"
  code             text,                                 -- CSI division, "03"
  description      text not null,
  hint             text,                                 -- what to include, for the contractor
  quantity         numeric(14, 3),
  unit             text,
  unit_cost        numeric(14, 2),
  amount           numeric(14, 2) check (amount is null or abs(amount) < 10000000000),
  line_status      text not null default 'priced' check (line_status in ('priced', 'allowance', 'excluded', 'tbd')),
  note             text,                                 -- the contractor's note
  review_note      text,                                 -- the owner side's question on this line
  previous_amount  numeric(14, 2),                       -- the contractor's earlier figure, for reference
  created_by       uuid references public.profiles (id) on delete set null default auth.uid(),
  updated_by       uuid references public.profiles (id) on delete set null,
  updated_at       timestamptz not null default now()
);
create index if not exists sov_lines_sheet_idx on public.sov_lines (sheet_id, position);

-- The owner side's budget for each line. The contractor never reads this table.
create table if not exists public.sov_budget (
  line_id        uuid primary key references public.sov_lines (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  low            numeric(14, 2),
  base           numeric(14, 2),
  high           numeric(14, 2),
  note           text
);

-- A copy of the sheet each time it is submitted.
create table if not exists public.sov_versions (
  id             uuid primary key default gen_random_uuid(),
  sheet_id       uuid not null references public.sov_sheets (id) on delete cascade,
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  version        integer not null,
  subtotal       numeric(14, 2),
  ohp            numeric(14, 2),
  total          numeric(14, 2),
  snapshot       jsonb not null,
  submitted_by   uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (sheet_id, version)
);

create or replace function public.sov_can_read(sheet uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sov_sheets s
     where s.id = sheet and (
       public.is_admin() or public.owns_engagement(s.engagement_id)
       or (s.contractor_id = auth.uid() and public.is_member(s.engagement_id))));
$$;

-- Edit rights: Michael at any time; the contractor until the sheet is submitted.
create or replace function public.sov_can_edit(sheet uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sov_sheets s
     where s.id = sheet and (
       public.is_admin()
       or (s.contractor_id = auth.uid() and public.is_member(s.engagement_id)
           and s.status in ('not_started', 'in_progress', 'changes_requested'))));
$$;

-- Save one cell (or several) of one line. Called as the contractor types.
create or replace function public.sov_save_line(line uuid, patch jsonb)
returns public.sov_lines language plpgsql security definer set search_path = public as $$
declare l public.sov_lines; s public.sov_sheets; admin boolean := public.is_admin();
begin
  select * into l from public.sov_lines where id = line;
  if not found then raise exception 'That line no longer exists.'; end if;
  if not public.sov_can_edit(l.sheet_id) then raise exception 'This pricing is locked. Ask Michael to reopen it.'; end if;
  if exists (select 1 from jsonb_object_keys(patch) k
              where k not in ('quantity', 'unit', 'unit_cost', 'amount', 'line_status', 'note')
                and not (admin and k in ('description', 'section', 'code', 'position', 'hint'))) then
    raise exception 'That field cannot be changed here.';
  end if;
  if patch ? 'line_status' and patch->>'line_status' not in ('priced', 'allowance', 'excluded', 'tbd') then
    raise exception 'Unknown line status.';
  end if;
  update public.sov_lines set
    quantity    = case when patch ? 'quantity'    then nullif(patch->>'quantity', '')::numeric else quantity end,
    unit        = case when patch ? 'unit'        then nullif(left(btrim(patch->>'unit'), 20), '') else unit end,
    unit_cost   = case when patch ? 'unit_cost'   then nullif(patch->>'unit_cost', '')::numeric else unit_cost end,
    amount      = case when patch ? 'amount'      then nullif(patch->>'amount', '')::numeric else amount end,
    line_status = case when patch ? 'line_status' then patch->>'line_status' else line_status end,
    note        = case when patch ? 'note'        then nullif(left(btrim(patch->>'note'), 1000), '') else note end,
    description = case when patch ? 'description' then coalesce(nullif(btrim(patch->>'description'), ''), description) else description end,
    section     = case when patch ? 'section'     then nullif(btrim(patch->>'section'), '') else section end,
    code        = case when patch ? 'code'        then nullif(btrim(patch->>'code'), '') else code end,
    hint        = case when patch ? 'hint'        then nullif(btrim(patch->>'hint'), '') else hint end,
    position    = case when patch ? 'position'    then (patch->>'position')::integer else position end,
    updated_by  = auth.uid(),
    updated_at  = now()
  where id = line
  returning * into l;
  -- Quantity times unit cost sets the amount when both are given.
  if (patch ? 'quantity' or patch ? 'unit_cost') and l.quantity is not null and l.unit_cost is not null then
    update public.sov_lines set amount = round(l.quantity * l.unit_cost, 2) where id = line returning * into l;
  end if;
  update public.sov_sheets
     set updated_at = now(), status = case when status = 'not_started' then 'in_progress' else status end
   where id = l.sheet_id;
  return l;
end;
$$;

create or replace function public.sov_add_line(sheet uuid, p_section text, p_description text)
returns public.sov_lines language plpgsql security definer set search_path = public as $$
declare l public.sov_lines; eng uuid;
begin
  if not public.sov_can_edit(sheet) then raise exception 'This pricing is locked.'; end if;
  if nullif(btrim(p_description), '') is null then raise exception 'Describe the line.'; end if;
  select engagement_id into eng from public.sov_sheets where id = sheet;
  insert into public.sov_lines (sheet_id, engagement_id, position, section, description, updated_by)
  values (sheet, eng, coalesce((select max(position) from public.sov_lines where sheet_id = sheet), 0) + 1,
          nullif(btrim(p_section), ''), left(btrim(p_description), 300), auth.uid())
  returning * into l;
  update public.sov_sheets set updated_at = now(), status = case when status = 'not_started' then 'in_progress' else status end where id = sheet;
  return l;
end;
$$;

-- The contractor may remove lines they added; Michael may remove any.
create or replace function public.sov_delete_line(line uuid)
returns void language plpgsql security definer set search_path = public as $$
declare l public.sov_lines;
begin
  select * into l from public.sov_lines where id = line;
  if not found then return; end if;
  if not public.sov_can_edit(l.sheet_id) or not (public.is_admin() or l.created_by = auth.uid()) then
    raise exception 'Only lines you added can be removed.';
  end if;
  delete from public.sov_lines where id = line;
end;
$$;

create or replace function public.sov_update_sheet(sheet uuid, patch jsonb)
returns public.sov_sheets language plpgsql security definer set search_path = public as $$
declare s public.sov_sheets;
begin
  if not public.sov_can_edit(sheet) then raise exception 'This pricing is locked.'; end if;
  if exists (select 1 from jsonb_object_keys(patch) k
              where k not in ('building_sf', 'location', 'valid_until', 'schedule_note', 'ohp_pct', 'ohp_basis', 'basis_note')) then
    raise exception 'That field cannot be changed here.';
  end if;
  update public.sov_sheets set
    building_sf   = case when patch ? 'building_sf'   then nullif(patch->>'building_sf', '')::numeric else building_sf end,
    location      = case when patch ? 'location'      then nullif(left(btrim(patch->>'location'), 200), '') else location end,
    valid_until   = case when patch ? 'valid_until'   then nullif(patch->>'valid_until', '')::date else valid_until end,
    schedule_note = case when patch ? 'schedule_note' then nullif(left(btrim(patch->>'schedule_note'), 1000), '') else schedule_note end,
    ohp_pct       = case when patch ? 'ohp_pct'       then nullif(patch->>'ohp_pct', '')::numeric else ohp_pct end,
    ohp_basis     = case when patch ? 'ohp_basis'     then nullif(left(btrim(patch->>'ohp_basis'), 1000), '') else ohp_basis end,
    basis_note    = case when patch ? 'basis_note'    then nullif(left(btrim(patch->>'basis_note'), 2000), '') else basis_note end,
    status        = case when status = 'not_started' then 'in_progress' else status end,
    updated_at    = now()
  where id = sheet
  returning * into s;
  return s;
end;
$$;

-- Submit: every line priced, or marked excluded or to-be-determined with a note; the price's
-- validity date given. Saves a version, locks the sheet and answers the pricing request.
create or replace function public.sov_submit(sheet uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sov_sheets; missing integer; sub numeric; o numeric; v integer;
begin
  if not public.sov_can_edit(sheet) then raise exception 'This pricing is locked.'; end if;
  select * into s from public.sov_sheets where id = sheet;
  select count(*) into missing from public.sov_lines
   where sheet_id = sheet and (
     (line_status in ('priced', 'allowance') and amount is null)
     or (line_status in ('excluded', 'tbd') and note is null));
  if missing > 0 then
    raise exception '% line(s) still need a price, or a note saying why not.', missing;
  end if;
  if s.valid_until is null then raise exception 'Add the date this price is valid until.'; end if;
  select coalesce(sum(amount), 0) into sub from public.sov_lines where sheet_id = sheet and line_status <> 'excluded';
  o := round(sub * coalesce(s.ohp_pct, 0) / 100, 2);
  v := s.version + 1;
  insert into public.sov_versions (sheet_id, engagement_id, version, subtotal, ohp, total, snapshot, submitted_by)
  values (sheet, s.engagement_id, v, sub, o, sub + o, jsonb_build_object(
    'sheet', to_jsonb(s) - 'review_note',
    'lines', (select coalesce(jsonb_agg(to_jsonb(l) - 'review_note' order by l.position), '[]'::jsonb) from public.sov_lines l where l.sheet_id = sheet)),
    auth.uid());
  update public.sov_sheets set status = 'submitted', version = v, submitted_at = now(), updated_at = now() where id = sheet;
  update public.action_items set status = 'submitted', submitted_at = now(), submitted_by = auth.uid()
   where kind = 'pricing' and link_ref = sheet and status <> 'accepted';
  insert into public.activity (engagement_id, kind, detail)
  values (s.engagement_id, 'pricing_submitted', jsonb_build_object('title', s.title, 'version', v, 'total', sub + o));
  return jsonb_build_object('version', v, 'subtotal', sub, 'ohp', o, 'total', sub + o);
end;
$$;

-- Accept the submitted pricing, or send it back with a note.
create or replace function public.sov_review(sheet uuid, accept boolean, note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sov_sheets;
begin
  select * into s from public.sov_sheets where id = sheet;
  if not found or not (public.is_admin() or public.owns_engagement(s.engagement_id)) then raise exception 'not allowed'; end if;
  if s.status <> 'submitted' then raise exception 'This pricing has not been submitted.'; end if;
  if not accept and nullif(btrim(note), '') is null then raise exception 'Say what needs to change.'; end if;
  update public.sov_sheets
     set status = case when accept then 'accepted' else 'changes_requested' end,
         reviewed_at = now(), review_note = nullif(btrim(note), ''), updated_at = now()
   where id = sheet;
  update public.action_items
     set status = case when accept then 'accepted' else 'changes_requested' end,
         done_at = case when accept then now() else null end,
         done_by = case when accept then auth.uid() else null end,
         reviewed_at = now(), review_note = nullif(btrim(note), '')
   where kind = 'pricing' and link_ref = sheet;
  insert into public.activity (engagement_id, kind, detail)
  values (s.engagement_id, case when accept then 'pricing_accepted' else 'pricing_changes' end, jsonb_build_object('title', s.title));
end;
$$;

-- Michael can reopen a submitted or accepted sheet for editing.
create or replace function public.sov_reopen(sheet uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.sov_sheets set status = 'in_progress', updated_at = now() where id = sheet;
  update public.action_items set status = 'open', done_at = null, done_by = null where kind = 'pricing' and link_ref = sheet;
end;
$$;

-- The owner side's question on a line (shown to the contractor).
create or replace function public.sov_line_review(line uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare eng uuid;
begin
  select engagement_id into eng from public.sov_lines where id = line;
  if eng is null or not (public.is_admin() or public.owns_engagement(eng)) then raise exception 'not allowed'; end if;
  update public.sov_lines set review_note = nullif(left(btrim(p_note), 1000), '') where id = line;
end;
$$;

-- ===========================================================================
-- Notification triggers
-- ===========================================================================
create or replace function public.notify_room_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text := public.display_name(auth.uid()); client uuid; a public.action_items; title text;
begin
  if tg_table_name = 'messages' then
    perform public.notify(new.engagement_id,
      public.audience(new.engagement_id, case when new.thread = 'team' then 'team' else 'private' end),
      'message', who || ' sent a message', left(new.body, 160), 'messages');
  elsif tg_table_name = 'deliverables' then
    perform public.notify(new.engagement_id,
      public.audience(new.engagement_id, case when new.shared_with_team then 'files' else 'private' end),
      'document', 'New document: ' || new.title, new.note, 'documents');
  elsif tg_table_name = 'team_files' then
    perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'files'),
      'file', who || ' shared a file', new.name, 'files');
  elsif tg_table_name = 'request_files' then
    select * into a from public.action_items where id = new.request_id;
    select client_id into client from public.engagements where id = new.engagement_id;
    perform public.notify(new.engagement_id,
      array[a.created_by, coalesce(a.assignee_id, client)] || (select coalesce(array_agg(id), '{}') from public.profiles where role = 'admin'),
      'request_file', who || ' added a file to "' || a.title || '"', new.name, 'requests');
  elsif tg_table_name = 'action_items' then
    select client_id into client from public.engagements where id = new.engagement_id;
    if tg_op = 'INSERT' then
      perform public.notify(new.engagement_id, array[coalesce(new.assignee_id, client)],
        'request', case when new.kind = 'task' then 'New to-do: ' else 'New request: ' end || new.title,
        case when new.created_by is not null then 'From ' || public.display_name(new.created_by) else null end, 'requests');
    elsif new.status is distinct from old.status and new.kind <> 'pricing' then  -- pricing alerts come from the sheet
      if new.status = 'submitted' then
        perform public.notify(new.engagement_id,
          array[new.created_by] || (select coalesce(array_agg(id), '{}') from public.profiles where role = 'admin'),
          'request_submitted', who || ' answered "' || new.title || '"', new.response, 'requests');
      elsif new.status = 'accepted' and new.kind <> 'task' then
        perform public.notify(new.engagement_id, array[coalesce(new.assignee_id, client)],
          'request_accepted', 'Accepted: ' || new.title, new.review_note, 'requests');
      elsif new.status = 'changes_requested' then
        perform public.notify(new.engagement_id, array[coalesce(new.assignee_id, client)],
          'request_changes', 'Changes requested: ' || new.title, new.review_note, 'requests');
      end if;
    end if;
  elsif tg_table_name = 'assignments' then
    select client_id into client from public.engagements where id = new.engagement_id;
    select q.title into title from public.questionnaires q where q.id = new.questionnaire_id;
    perform public.notify(new.engagement_id, array[client], 'questionnaire', 'New questions to answer: ' || coalesce(title, 'questionnaire'), new.message, 'home');
  elsif tg_table_name = 'decisions' then
    perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'private'), 'decision', 'Decision recorded', new.decision, 'plan');
  elsif tg_table_name = 'milestones' then
    if new.status is distinct from old.status and new.status in ('current', 'done') then
      perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'private'),
        'milestone', case when new.status = 'done' then 'Milestone complete: ' else 'Now under way: ' end || new.title, null, 'plan');
    end if;
  elsif tg_table_name = 'sov_sheets' then
    if new.status is distinct from old.status then
      if new.status = 'in_progress' and old.status = 'not_started' then
        perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'private'),
          'pricing', who || ' started pricing ' || new.title, null, 'pricing');
      elsif new.status = 'submitted' then
        perform public.notify(new.engagement_id, public.audience(new.engagement_id, 'private'),
          'pricing', 'Pricing submitted: ' || new.title, who || ' submitted version ' || new.version, 'pricing');
      elsif new.status = 'changes_requested' then
        perform public.notify(new.engagement_id, array[new.contractor_id], 'pricing', 'Changes requested on ' || new.title, new.review_note, 'pricing');
      elsif new.status = 'accepted' then
        perform public.notify(new.engagement_id, array[new.contractor_id], 'pricing', 'Pricing accepted: ' || new.title, new.review_note, 'pricing');
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_message on public.messages;
create trigger notify_message after insert on public.messages for each row execute function public.notify_room_event();
drop trigger if exists notify_deliverable on public.deliverables;
create trigger notify_deliverable after insert on public.deliverables for each row execute function public.notify_room_event();
drop trigger if exists notify_team_file on public.team_files;
create trigger notify_team_file after insert on public.team_files for each row execute function public.notify_room_event();
drop trigger if exists notify_request_file on public.request_files;
create trigger notify_request_file after insert on public.request_files for each row execute function public.notify_room_event();
drop trigger if exists notify_request on public.action_items;
create trigger notify_request after insert or update of status on public.action_items for each row execute function public.notify_room_event();
drop trigger if exists notify_assignment on public.assignments;
create trigger notify_assignment after insert on public.assignments for each row execute function public.notify_room_event();
drop trigger if exists notify_decision on public.decisions;
create trigger notify_decision after insert on public.decisions for each row execute function public.notify_room_event();
drop trigger if exists notify_milestone on public.milestones;
create trigger notify_milestone after update of status on public.milestones for each row execute function public.notify_room_event();
drop trigger if exists notify_pricing on public.sov_sheets;
create trigger notify_pricing after update of status on public.sov_sheets for each row execute function public.notify_room_event();

-- ===========================================================================
-- Row level security
-- ===========================================================================
alter table public.request_files enable row level security;
alter table public.notifications enable row level security;
alter table public.sov_sheets    enable row level security;
alter table public.sov_lines     enable row level security;
alter table public.sov_budget    enable row level security;
alter table public.sov_versions  enable row level security;

-- Requests: members see plain team tasks as before, and other requests only when they asked
-- or were asked.
drop policy if exists "action items: member read team tasks" on public.action_items;
create policy "action items: member read team tasks" on public.action_items
  for select using (public.is_member(engagement_id) and (
    (kind = 'task' and assignee_id is not null) or assignee_id = auth.uid() or created_by = auth.uid()));

-- The client can ask Michael or anyone on their team; a member can ask the client, Michael
-- or another member. Pricing requests come only from Michael.
drop policy if exists "action items: client add" on public.action_items;
create policy "action items: client add" on public.action_items
  for insert with check (
    public.owns_engagement(engagement_id) and created_by = auth.uid() and done_at is null and status = 'open' and kind <> 'pricing'
    and public.may_be_asked(engagement_id, assignee_id));
drop policy if exists "action items: member add" on public.action_items;
create policy "action items: member add" on public.action_items
  for insert with check (
    public.is_member(engagement_id) and created_by = auth.uid() and done_at is null and status = 'open' and kind not in ('pricing', 'task')
    and public.may_be_asked(engagement_id, assignee_id));
drop policy if exists "action items: member remove own" on public.action_items;
create policy "action items: member remove own" on public.action_items
  for delete using (public.is_member(engagement_id) and created_by = auth.uid() and status = 'open');

drop policy if exists "request files: admin" on public.request_files;
create policy "request files: admin" on public.request_files
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "request files: read" on public.request_files;
create policy "request files: read" on public.request_files
  for select using (public.is_request_participant(request_id));
drop policy if exists "request files: add" on public.request_files;
create policy "request files: add" on public.request_files
  for insert with check (
    public.may_respond(request_id) and uploaded_by = auth.uid()
    and public.request_in_path(path) = request_id
    and engagement_id = (select a.engagement_id from public.action_items a where a.id = request_id));
drop policy if exists "request files: remove own" on public.request_files;
create policy "request files: remove own" on public.request_files
  for delete using (uploaded_by = auth.uid());

drop policy if exists "portal files: request read" on storage.objects;
create policy "portal files: request read" on storage.objects
  for select using (bucket_id = 'portal' and public.is_request_participant(public.request_in_path(name)));
drop policy if exists "portal files: request upload" on storage.objects;
create policy "portal files: request upload" on storage.objects
  for insert with check (bucket_id = 'portal' and public.may_respond(public.request_in_path(name)));
drop policy if exists "portal files: remove own request file" on storage.objects;
create policy "portal files: remove own request file" on storage.objects
  for delete using (
    bucket_id = 'portal'
    and exists (select 1 from public.request_files f where f.path = storage.objects.name and f.uploaded_by = auth.uid()));

-- Notifications: your own, read only (written by the triggers above).
drop policy if exists "notifications: own" on public.notifications;
create policy "notifications: own" on public.notifications
  for select using (user_id = auth.uid());

-- Pricing: Michael edits tables directly; everyone else goes through the functions above.
drop policy if exists "sov sheets: admin" on public.sov_sheets;
create policy "sov sheets: admin" on public.sov_sheets for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "sov sheets: read" on public.sov_sheets;
create policy "sov sheets: read" on public.sov_sheets for select using (public.sov_can_read(id));
drop policy if exists "sov lines: admin" on public.sov_lines;
create policy "sov lines: admin" on public.sov_lines for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "sov lines: read" on public.sov_lines;
create policy "sov lines: read" on public.sov_lines for select using (public.sov_can_read(sheet_id));
drop policy if exists "sov budget: admin" on public.sov_budget;
create policy "sov budget: admin" on public.sov_budget for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "sov budget: client read" on public.sov_budget;
create policy "sov budget: client read" on public.sov_budget for select using (public.owns_engagement(engagement_id));
drop policy if exists "sov versions: admin" on public.sov_versions;
create policy "sov versions: admin" on public.sov_versions for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "sov versions: read" on public.sov_versions;
create policy "sov versions: read" on public.sov_versions for select using (public.sov_can_read(sheet_id));

-- ===========================================================================
-- Live updates: the portal listens for new notifications and pricing edits.
-- ===========================================================================
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['notifications', 'sov_lines', 'sov_sheets'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ===========================================================================
-- Function access: signed-in users only; internal helpers and triggers for no one.
-- ===========================================================================
revoke execute on function public.is_request_participant(uuid) from public, anon;
revoke execute on function public.may_respond(uuid) from public, anon;
revoke execute on function public.may_review(uuid) from public, anon;
revoke execute on function public.may_be_asked(uuid, uuid) from public, anon;
revoke execute on function public.submit_request(uuid, text) from public, anon;
revoke execute on function public.review_request(uuid, boolean, text) from public, anon;
revoke execute on function public.set_action_item_done(uuid, boolean) from public, anon;
revoke execute on function public.request_parties(uuid) from public, anon;
revoke execute on function public.request_in_path(text) from public, anon;
revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
revoke execute on function public.sov_can_read(uuid) from public, anon;
revoke execute on function public.sov_can_edit(uuid) from public, anon;
revoke execute on function public.sov_save_line(uuid, jsonb) from public, anon;
revoke execute on function public.sov_add_line(uuid, text, text) from public, anon;
revoke execute on function public.sov_delete_line(uuid) from public, anon;
revoke execute on function public.sov_update_sheet(uuid, jsonb) from public, anon;
revoke execute on function public.sov_submit(uuid) from public, anon;
revoke execute on function public.sov_review(uuid, boolean, text) from public, anon;
revoke execute on function public.sov_reopen(uuid) from public, anon;
revoke execute on function public.sov_line_review(uuid, text) from public, anon;
grant execute on function public.is_request_participant(uuid) to authenticated;
grant execute on function public.may_respond(uuid) to authenticated;
grant execute on function public.may_review(uuid) to authenticated;
grant execute on function public.may_be_asked(uuid, uuid) to authenticated;
grant execute on function public.submit_request(uuid, text) to authenticated;
grant execute on function public.review_request(uuid, boolean, text) to authenticated;
grant execute on function public.set_action_item_done(uuid, boolean) to authenticated;
grant execute on function public.request_parties(uuid) to authenticated;
grant execute on function public.request_in_path(text) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.sov_can_read(uuid) to authenticated;
grant execute on function public.sov_can_edit(uuid) to authenticated;
grant execute on function public.sov_save_line(uuid, jsonb) to authenticated;
grant execute on function public.sov_add_line(uuid, text, text) to authenticated;
grant execute on function public.sov_delete_line(uuid) to authenticated;
grant execute on function public.sov_update_sheet(uuid, jsonb) to authenticated;
grant execute on function public.sov_submit(uuid) to authenticated;
grant execute on function public.sov_review(uuid, boolean, text) to authenticated;
grant execute on function public.sov_reopen(uuid) to authenticated;
grant execute on function public.sov_line_review(uuid, text) to authenticated;
-- Internal: used only inside other functions and triggers.
revoke execute on function public.audience(uuid, text) from public, anon, authenticated;
revoke execute on function public.display_name(uuid) from public, anon, authenticated;
revoke execute on function public.notify(uuid, uuid[], text, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_room_event() from public, anon, authenticated;
