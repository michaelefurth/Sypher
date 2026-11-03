-- Sypher Solutions: a fuller client room.
-- Run after 20261002000000_bespoke_flow.sql (SQL editor or `supabase db push`).
--
--   messages      a private thread per engagement between the client and Michael
--   deliverables  reports, models and documents Michael shares, optionally by milestone
--   action_items  small to-dos for the client, which they tick off
--   agreement     the accepted proposal, readable by the client from their room
--   timeline      milestones, decisions, messages, deliverables and to-dos are
--                 written to public.activity automatically
--
-- Clients read only their own engagement's rows. They can post messages and
-- tick their to-dos (through set_action_item_done), and nothing else.

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  author_id      uuid references public.profiles (id) on delete set null default auth.uid(),
  body           text not null check (length(btrim(body)) between 1 and 8000),
  created_at     timestamptz not null default now(),
  read_at        timestamptz,                 -- when the other side opened the thread
  notified_at    timestamptz                  -- email alert sent (set by the room-notify function)
);
create index if not exists messages_eng_idx on public.messages (engagement_id, created_at);

-- Mark the other side's messages in a thread as read.
create or replace function public.mark_messages_read(eng uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not (public.owns_engagement(eng) or public.is_admin()) then
    raise exception 'not allowed';
  end if;
  update public.messages
     set read_at = now()
   where engagement_id = eng and read_at is null and author_id is distinct from auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deliverables (files live in the private 'portal' bucket at
-- <engagement_id>/deliverables/<uuid>-<name>, so the existing storage rules apply)
-- ---------------------------------------------------------------------------
create table if not exists public.deliverables (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  milestone_id   uuid references public.milestones (id) on delete set null,
  title          text not null,
  note           text,
  path           text not null unique,
  name           text not null,
  size           bigint,
  uploaded_by    uuid references public.profiles (id) default auth.uid(),
  created_at     timestamptz not null default now()
);
create index if not exists deliverables_eng_idx on public.deliverables (engagement_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Action items for the client
-- ---------------------------------------------------------------------------
create table if not exists public.action_items (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  title          text not null,
  detail         text,
  due_date       date,
  position       integer not null default 0,
  done_at        timestamptz,
  done_by        uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists action_items_eng_idx on public.action_items (engagement_id, position);

-- The client's only write: tick or untick one of their own items.
create or replace function public.set_action_item_done(item uuid, done boolean)
returns void language plpgsql security definer set search_path = public as $$
declare eng uuid; t text;
begin
  select engagement_id, title into eng, t from public.action_items where id = item;
  if eng is null or not (public.owns_engagement(eng) or public.is_admin()) then
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
-- The signed agreement: the accepted proposal behind an engagement
-- ---------------------------------------------------------------------------
create or replace function public.engagement_agreement(eng uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p public.proposals;
begin
  if not (public.owns_engagement(eng) or public.is_admin()) then
    return null;
  end if;
  select * into p from public.proposals
   where engagement_id = eng and status = 'accepted'
   order by responded_at desc nulls last limit 1;
  if not found then return null; end if;
  return public.proposal_public(p);
end;
$$;

-- ---------------------------------------------------------------------------
-- Timeline: write room events to public.activity
-- ---------------------------------------------------------------------------
create or replace function public.log_room_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'messages' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'message_posted',
            jsonb_build_object('message_id', new.id, 'from', case when public.is_admin() then 'principal' else 'client' end));
  elsif tg_table_name = 'deliverables' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'deliverable_shared', jsonb_build_object('deliverable_id', new.id, 'title', new.title));
  elsif tg_table_name = 'action_items' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'action_assigned', jsonb_build_object('title', new.title));
  elsif tg_table_name = 'decisions' then
    insert into public.activity (engagement_id, kind, detail)
    values (new.engagement_id, 'decision_recorded', jsonb_build_object('title', new.decision));
  elsif tg_table_name = 'milestones' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('current', 'done') then
      insert into public.activity (engagement_id, kind, detail)
      values (new.engagement_id, 'milestone_' || new.status, jsonb_build_object('title', new.title));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists log_message on public.messages;
create trigger log_message after insert on public.messages
  for each row execute function public.log_room_event();
drop trigger if exists log_deliverable on public.deliverables;
create trigger log_deliverable after insert on public.deliverables
  for each row execute function public.log_room_event();
drop trigger if exists log_action_item on public.action_items;
create trigger log_action_item after insert on public.action_items
  for each row execute function public.log_room_event();
drop trigger if exists log_decision on public.decisions;
create trigger log_decision after insert on public.decisions
  for each row execute function public.log_room_event();
drop trigger if exists log_milestone on public.milestones;
create trigger log_milestone after update on public.milestones
  for each row execute function public.log_room_event();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.messages     enable row level security;
alter table public.deliverables enable row level security;
alter table public.action_items enable row level security;

drop policy if exists "messages: admin" on public.messages;
create policy "messages: admin" on public.messages
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "messages: client read own" on public.messages;
create policy "messages: client read own" on public.messages
  for select using (public.owns_engagement(engagement_id));
drop policy if exists "messages: client post own" on public.messages;
create policy "messages: client post own" on public.messages
  for insert with check (
    public.owns_engagement(engagement_id)
    and author_id = auth.uid() and read_at is null and notified_at is null);

drop policy if exists "deliverables: admin" on public.deliverables;
create policy "deliverables: admin" on public.deliverables
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "deliverables: client read own" on public.deliverables;
create policy "deliverables: client read own" on public.deliverables
  for select using (public.owns_engagement(engagement_id));

drop policy if exists "action items: admin" on public.action_items;
create policy "action items: admin" on public.action_items
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "action items: client read own" on public.action_items;
create policy "action items: client read own" on public.action_items
  for select using (public.owns_engagement(engagement_id));

-- Functions: signed-in users only. The trigger function is never called directly.
revoke all on function public.mark_messages_read(uuid) from public, anon;
revoke all on function public.set_action_item_done(uuid, boolean) from public, anon;
revoke all on function public.engagement_agreement(uuid) from public, anon;
revoke all on function public.log_room_event() from public, anon, authenticated;
grant execute on function public.mark_messages_read(uuid) to authenticated;
grant execute on function public.set_action_item_done(uuid, boolean) to authenticated;
grant execute on function public.engagement_agreement(uuid) to authenticated;
