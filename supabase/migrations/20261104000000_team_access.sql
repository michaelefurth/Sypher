-- Sypher Solutions: team access for outside advisers.
-- Run after 20261103000000_client_room.sql (SQL editor or `supabase db push`).
--
-- A client (or Michael) can add their attorney, CPA, lender or anyone else to an
-- engagement. Members get time-limited access to a team space only:
--   - a team message thread (separate from the client's private thread with Michael)
--   - team files they can upload to, plus deliverables Michael marks "shared with the team"
--   - tasks assigned to them, which they can tick off
-- Members never see the private thread, questionnaires, updates, decisions, the
-- agreement, milestones or the timeline. Access ends automatically at expires_at,
-- when it is revoked, or when the engagement is no longer active.

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------
create table if not exists public.engagement_members (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  email          text not null,
  full_name      text,
  organization   text,
  role_label     text,                         -- "Attorney", "CPA", "Lender" …
  can_message    boolean not null default true,
  can_files      boolean not null default true,
  expires_at     timestamptz,                  -- null: until the engagement ends
  status         text not null default 'active' check (status in ('active', 'revoked')),
  invited_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz,
  unique (engagement_id, user_id)
);
create index if not exists engagement_members_user_idx on public.engagement_members (user_id);

-- Is the signed-in user a current member of this engagement?
create or replace function public.is_member(eng uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.engagement_members m
    join public.engagements e on e.id = m.engagement_id
    where m.engagement_id = eng and m.user_id = auth.uid() and m.status = 'active'
      and (m.expires_at is null or m.expires_at > now()) and e.status = 'active'
  );
$$;

-- … and may they use this part of the team space ('message' or 'files')?
create or replace function public.member_can(eng uuid, what text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.engagement_members m
    join public.engagements e on e.id = m.engagement_id
    where m.engagement_id = eng and m.user_id = auth.uid() and m.status = 'active'
      and (m.expires_at is null or m.expires_at > now()) and e.status = 'active'
      and ((what = 'message' and m.can_message) or (what = 'files' and m.can_files))
  );
$$;

-- Everyone on the team, for the people list and for naming message authors.
-- Members see active members only, and never other people's email addresses.
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
                   'can_message', m.can_message, 'can_files', m.can_files, 'expires_at', m.expires_at,
                   'status', case when m.status = 'revoked' then 'revoked'
                                  when m.expires_at is not null and m.expires_at <= now() then 'expired' else 'active' end,
                   'last_seen_at', m.last_seen_at, 'created_at', m.created_at) order by m.created_at), '[]'::jsonb)
                  from public.engagement_members m
                  where m.engagement_id = eng
                    and (manager or (m.status = 'active' and (m.expires_at is null or m.expires_at > now()))))
  );
end;
$$;

-- The client (or Michael) changes a member's access: permissions, expiry, revoke or restore.
create or replace function public.set_member_access(member uuid, p_can_message boolean, p_can_files boolean, p_expires_at timestamptz, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare eng uuid; who text; before text;
begin
  select engagement_id, coalesce(full_name, email), status into eng, who, before from public.engagement_members where id = member;
  if eng is null or not (public.owns_engagement(eng) or public.is_admin()) then
    raise exception 'not allowed';
  end if;
  if p_status not in ('active', 'revoked') then raise exception 'unknown status'; end if;
  update public.engagement_members
     set can_message = coalesce(p_can_message, can_message),
         can_files   = coalesce(p_can_files, can_files),
         expires_at  = p_expires_at,
         status      = p_status
   where id = member;
  if p_status = 'revoked' and before <> 'revoked' then
    insert into public.activity (engagement_id, kind, detail) values (eng, 'member_revoked', jsonb_build_object('title', who));
  end if;
end;
$$;

-- Members record when they last opened the team space.
create or replace function public.touch_membership(eng uuid)
returns void language sql security definer set search_path = public as $$
  update public.engagement_members set last_seen_at = now()
   where engagement_id = eng and user_id = auth.uid() and status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- Engagements as each person sees them. Members get the title and summary,
-- never meeting details, and an `access` column tells the page which room to show.
-- ---------------------------------------------------------------------------
drop view if exists public.client_engagements;
create view public.client_engagements as
  select id, client_id, title, summary, status, created_at,
         case when client_id = auth.uid() or public.is_admin() then kickoff_date end      as kickoff_date,
         case when client_id = auth.uid() or public.is_admin() then next_meeting_at end   as next_meeting_at,
         case when client_id = auth.uid() or public.is_admin() then next_meeting_note end as next_meeting_note,
         case when client_id = auth.uid() or public.is_admin() then meeting_link end      as meeting_link,
         case when client_id = auth.uid() then 'client' when public.is_admin() then 'admin' else 'member' end as access
  from public.engagements
  where client_id = auth.uid() or public.is_admin() or public.is_member(id);
revoke all on public.client_engagements from anon;
grant select on public.client_engagements to authenticated;

-- ---------------------------------------------------------------------------
-- Messages: a team thread beside the private one
-- ---------------------------------------------------------------------------
alter table public.messages add column if not exists thread text not null default 'private';
do $$ begin
  alter table public.messages add constraint messages_thread_check check (thread in ('private', 'team'));
exception when duplicate_object then null; end $$;
create index if not exists messages_thread_idx on public.messages (engagement_id, thread, created_at);

-- Read receipts stay on the private thread (two people); the team thread keeps a
-- last-read time per person instead.
create or replace function public.mark_messages_read(eng uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not (public.owns_engagement(eng) or public.is_admin()) then
    raise exception 'not allowed';
  end if;
  update public.messages
     set read_at = now()
   where engagement_id = eng and thread = 'private' and read_at is null and author_id is distinct from auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;

create table if not exists public.thread_reads (
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  thread         text not null default 'team',
  last_read_at   timestamptz not null default now(),
  primary key (engagement_id, user_id, thread)
);

create or replace function public.mark_team_read(eng uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.owns_engagement(eng) or public.is_admin() or public.member_can(eng, 'message')) then
    raise exception 'not allowed';
  end if;
  insert into public.thread_reads (engagement_id, user_id, thread, last_read_at)
  values (eng, auth.uid(), 'team', now())
  on conflict (engagement_id, user_id, thread) do update set last_read_at = excluded.last_read_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Files: deliverables Michael chooses to share, and a team folder anyone on the
-- team may add to (stored at <engagement_id>/team/<uuid>-<name>)
-- ---------------------------------------------------------------------------
alter table public.deliverables add column if not exists shared_with_team boolean not null default false;

create table if not exists public.team_files (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  path           text not null unique,
  name           text not null,
  size           bigint,
  note           text,
  uploaded_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now()
);
create index if not exists team_files_eng_idx on public.team_files (engagement_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Tasks: an assignee (null means the client) and who created it
-- ---------------------------------------------------------------------------
alter table public.action_items add column if not exists assignee_id uuid references public.profiles (id) on delete set null;
alter table public.action_items add column if not exists created_by uuid references public.profiles (id) on delete set null default auth.uid();

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
         done_by = case when done then coalesce(done_by, auth.uid()) else null end
   where id = item;
  if done then
    insert into public.activity (engagement_id, kind, detail)
    values (eng, 'action_done', jsonb_build_object('title', t));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Timeline: name who wrote, and log team events (members never read the timeline)
-- ---------------------------------------------------------------------------
create or replace function public.log_room_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'messages' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'message_posted', jsonb_build_object(
      'message_id', new.id, 'thread', new.thread,
      'from', case when public.is_admin() then 'principal' when public.owns_engagement(new.engagement_id) then 'client' else 'member' end));
  elsif tg_table_name = 'deliverables' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'deliverable_shared', jsonb_build_object('deliverable_id', new.id, 'title', new.title));
  elsif tg_table_name = 'action_items' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'action_assigned', jsonb_build_object('title', new.title, 'assignee_id', new.assignee_id));
  elsif tg_table_name = 'decisions' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'decision_recorded', jsonb_build_object('title', new.decision));
  elsif tg_table_name = 'milestones' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('current', 'done') then
      insert into public.activity (engagement_id, kind, detail)
      values (new.engagement_id, 'milestone_' || new.status, jsonb_build_object('title', new.title));
    end if;
  elsif tg_table_name = 'team_files' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'team_file_shared', jsonb_build_object('title', new.name));
  elsif tg_table_name = 'engagement_members' then
    if tg_op = 'INSERT' then
      insert into public.activity (engagement_id, kind, detail)
      values (new.engagement_id, 'member_invited', jsonb_build_object('title',
        coalesce(new.full_name, new.email) || coalesce(' (' || new.role_label || ')', '')));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists log_team_file on public.team_files;
create trigger log_team_file after insert on public.team_files
  for each row execute function public.log_room_event();
drop trigger if exists log_member on public.engagement_members;
create trigger log_member after insert on public.engagement_members
  for each row execute function public.log_room_event();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.engagement_members enable row level security;
alter table public.thread_reads       enable row level security;
alter table public.team_files         enable row level security;

-- Members are added only by the invite-member function (service role).
drop policy if exists "members: admin" on public.engagement_members;
create policy "members: admin" on public.engagement_members
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "members: client and self read" on public.engagement_members;
create policy "members: client and self read" on public.engagement_members
  for select using (public.owns_engagement(engagement_id) or user_id = auth.uid());

drop policy if exists "thread reads: own" on public.thread_reads;
create policy "thread reads: own" on public.thread_reads
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists "messages: member read team" on public.messages;
create policy "messages: member read team" on public.messages
  for select using (thread = 'team' and public.member_can(engagement_id, 'message'));
drop policy if exists "messages: member post team" on public.messages;
create policy "messages: member post team" on public.messages
  for insert with check (
    thread = 'team' and public.member_can(engagement_id, 'message')
    and author_id = auth.uid() and read_at is null and notified_at is null);

drop policy if exists "deliverables: member read shared" on public.deliverables;
create policy "deliverables: member read shared" on public.deliverables
  for select using (shared_with_team and public.member_can(engagement_id, 'files'));

drop policy if exists "team files: admin" on public.team_files;
create policy "team files: admin" on public.team_files
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "team files: read" on public.team_files;
create policy "team files: read" on public.team_files
  for select using (public.owns_engagement(engagement_id) or public.member_can(engagement_id, 'files'));
drop policy if exists "team files: add" on public.team_files;
create policy "team files: add" on public.team_files
  for insert with check (
    (public.owns_engagement(engagement_id) or public.member_can(engagement_id, 'files'))
    and uploaded_by = auth.uid() and path like engagement_id::text || '/team/%');
drop policy if exists "team files: remove own" on public.team_files;
create policy "team files: remove own" on public.team_files
  for delete using (uploaded_by = auth.uid() or public.owns_engagement(engagement_id));

drop policy if exists "action items: member read team tasks" on public.action_items;
create policy "action items: member read team tasks" on public.action_items
  for select using (assignee_id is not null and public.is_member(engagement_id));
drop policy if exists "action items: client add" on public.action_items;
create policy "action items: client add" on public.action_items
  for insert with check (
    public.owns_engagement(engagement_id) and created_by = auth.uid() and done_at is null
    and (assignee_id is null or exists (
      select 1 from public.engagement_members m
      where m.engagement_id = action_items.engagement_id and m.user_id = action_items.assignee_id and m.status = 'active')));
drop policy if exists "action items: client remove own" on public.action_items;
create policy "action items: client remove own" on public.action_items
  for delete using (public.owns_engagement(engagement_id) and created_by = auth.uid());

-- Storage: members read the team folder and shared deliverables, and upload to the team folder.
drop policy if exists "portal files: member read team" on storage.objects;
create policy "portal files: member read team" on storage.objects
  for select using (
    bucket_id = 'portal'
    and public.member_can(((storage.foldername(name))[1])::uuid, 'files')
    and ((storage.foldername(name))[2] = 'team'
         or exists (select 1 from public.deliverables d where d.path = storage.objects.name and d.shared_with_team)));
drop policy if exists "portal files: member upload team" on storage.objects;
create policy "portal files: member upload team" on storage.objects
  for insert with check (
    bucket_id = 'portal'
    and (storage.foldername(name))[2] = 'team'
    and public.member_can(((storage.foldername(name))[1])::uuid, 'files'));
drop policy if exists "portal files: remove own team file" on storage.objects;
create policy "portal files: remove own team file" on storage.objects
  for delete using (
    bucket_id = 'portal'
    and exists (select 1 from public.team_files f where f.path = storage.objects.name
                and (f.uploaded_by = auth.uid() or public.owns_engagement(f.engagement_id))));

-- Functions: signed-in users only.
revoke all on function public.is_member(uuid) from public, anon;
revoke all on function public.member_can(uuid, text) from public, anon;
revoke all on function public.team_roster(uuid) from public, anon;
revoke all on function public.set_member_access(uuid, boolean, boolean, timestamptz, text) from public, anon;
revoke all on function public.touch_membership(uuid) from public, anon;
revoke all on function public.mark_team_read(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.member_can(uuid, text) to authenticated;
grant execute on function public.team_roster(uuid) to authenticated;
grant execute on function public.set_member_access(uuid, boolean, boolean, timestamptz, text) to authenticated;
grant execute on function public.touch_membership(uuid) to authenticated;
grant execute on function public.mark_team_read(uuid) to authenticated;
