-- Sypher Solutions: diagnostic intake, private proposals and client rooms.
-- Run after 20261001000000_client_portal.sql (SQL editor or `supabase db push`).
--
-- Flow
--   visitor completes the diagnostic on the contact page
--     -> submit-inquiry edge function stores it (service role) and drafts a
--        pre-call brief for Michael (admin-only)
--   Michael starts a proposal from the inquiry -> sends the private link
--     -> the client reads it at /for/?p=<slug>.<token> without signing in
--        (get_proposal) and accepts an option with a typed signature
--        (respond_proposal)
--   Michael opens the engagement -> the client's portal becomes their room:
--     milestones, decision log, next meeting, updates and documents.

-- ---------------------------------------------------------------------------
-- Inquiries (diagnostic submissions). Admin-only; written by the edge function.
-- ---------------------------------------------------------------------------
create table if not exists public.inquiries (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  name          text not null,
  email         text not null,
  company       text,
  role          text,
  phone         text,
  practices     text[] not null default '{}',
  answers       jsonb not null default '[]',   -- [{ key, section, question, answer }]
  status        text not null default 'new'
                check (status in ('new', 'reviewed', 'call_booked', 'proposal', 'closed')),
  brief         jsonb,                          -- Claude's pre-call brief (admin-only)
  brief_status  text not null default 'pending'
                check (brief_status in ('pending', 'ready', 'failed', 'skipped')),
  brief_model   text,
  brief_error   text,
  admin_notes   text
);
create index if not exists inquiries_created_idx on public.inquiries (created_at desc);

-- ---------------------------------------------------------------------------
-- Proposals. Admin-only table; clients reach a sent proposal through the
-- unguessable token in its link, via the two functions below.
-- ---------------------------------------------------------------------------
create table if not exists public.proposals (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- 160 random bits, hex. Never shown in lists; only in the link Michael sends.
  token            text not null unique default substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 40),
  slug             text,                        -- readable part of the link, e.g. juniper-vine
  status           text not null default 'draft'
                   check (status in ('draft', 'sent', 'viewed', 'accepted', 'declined', 'withdrawn')),
  title            text not null,
  client_name      text,
  client_email     text,
  company          text,
  content          jsonb not null default '{}', -- letter, situation, objectives, phases, options, timeline, terms
  valid_until      date,
  inquiry_id       uuid references public.inquiries (id) on delete set null,
  engagement_id    uuid references public.engagements (id) on delete set null,
  sent_at          timestamptz,
  first_viewed_at  timestamptz,
  last_viewed_at   timestamptz,
  view_count       integer not null default 0,
  responded_at     timestamptz,
  accepted_option  text,
  signer_name      text,
  signer_title     text,
  signer_email     text,
  decline_reason   text,
  notified_at      timestamptz                  -- Michael emailed about the response
);
create index if not exists proposals_created_idx on public.proposals (created_at desc);

create or replace function public.touch_proposal()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists touch_proposal on public.proposals;
create trigger touch_proposal before update on public.proposals
  for each row execute function public.touch_proposal();

-- What a client may see of a proposal: everything except internal links and
-- tracking. Drafts and withdrawn proposals are visible only to the admin.
create or replace function public.proposal_public(p public.proposals)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'title', p.title, 'client_name', p.client_name, 'company', p.company,
    'content', p.content, 'status', p.status, 'valid_until', p.valid_until,
    'sent_at', coalesce(p.sent_at, p.created_at),
    'expired', p.valid_until is not null and p.valid_until < current_date and p.status in ('sent', 'viewed'),
    'responded_at', p.responded_at, 'accepted_option', p.accepted_option,
    'signer_name', p.signer_name, 'signer_title', p.signer_title
  );
$$;

-- Read a proposal by its token. Records the view, except when the admin looks.
create or replace function public.get_proposal(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.proposals;
begin
  select * into p from public.proposals where token = p_token;
  if not found then return null; end if;
  if p.status in ('draft', 'withdrawn') and not public.is_admin() then return null; end if;

  if not public.is_admin() then
    update public.proposals
       set status = case when status = 'sent' then 'viewed' else status end,
           first_viewed_at = coalesce(first_viewed_at, now()),
           last_viewed_at = now(),
           view_count = view_count + 1
     where id = p.id
    returning * into p;
  end if;
  return public.proposal_public(p);
end;
$$;

-- Accept (with a typed signature) or decline a proposal.
create or replace function public.respond_proposal(
  p_token text, p_action text, p_option text default null,
  p_name text default null, p_title text default null, p_email text default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.proposals;
begin
  select * into p from public.proposals where token = p_token for update;
  if not found or p.status not in ('sent', 'viewed') then
    raise exception 'This proposal is not open for a response.';
  end if;
  if p.valid_until is not null and p.valid_until < current_date then
    raise exception 'This proposal has expired. Please contact Michael for an updated one.';
  end if;

  if p_action = 'accept' then
    if coalesce(length(trim(p_name)), 0) < 2 then raise exception 'Please type your full name to sign.'; end if;
    if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Please enter a valid email.'; end if;
    if not exists (select 1 from jsonb_array_elements(coalesce(p.content -> 'options', '[]')) o where o ->> 'id' = p_option) then
      raise exception 'Please choose one of the options.';
    end if;
    update public.proposals
       set status = 'accepted', responded_at = now(), accepted_option = p_option,
           signer_name = left(trim(p_name), 200), signer_title = left(trim(p_title), 200),
           signer_email = lower(left(trim(p_email), 320))
     where id = p.id returning * into p;
  elsif p_action = 'decline' then
    update public.proposals
       set status = 'declined', responded_at = now(), decline_reason = left(p_reason, 2000)
     where id = p.id returning * into p;
  else
    raise exception 'Unknown action.';
  end if;

  insert into public.activity (engagement_id, actor, kind, detail)
  values (p.engagement_id, null, 'proposal_' || p.status, jsonb_build_object('proposal_id', p.id, 'title', p.title));
  return public.proposal_public(p);
end;
$$;

revoke all on function public.get_proposal(text) from public;
revoke all on function public.respond_proposal(text, text, text, text, text, text, text) from public;
grant execute on function public.get_proposal(text) to anon, authenticated;
grant execute on function public.respond_proposal(text, text, text, text, text, text, text) to anon, authenticated;
revoke all on function public.proposal_public(public.proposals) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client room: kickoff, next meeting, milestones and a decision log
-- ---------------------------------------------------------------------------
alter table public.engagements add column if not exists kickoff_date      date;
alter table public.engagements add column if not exists next_meeting_at   timestamptz;
alter table public.engagements add column if not exists next_meeting_note text;
alter table public.engagements add column if not exists meeting_link      text;

-- Recreate the client view with the room fields (new columns are appended).
drop view if exists public.client_engagements;
create view public.client_engagements as
  select id, client_id, title, summary, status, created_at,
         kickoff_date, next_meeting_at, next_meeting_note, meeting_link
  from public.engagements
  where client_id = auth.uid() or public.is_admin();
revoke all on public.client_engagements from anon;
grant select on public.client_engagements to authenticated;

create table if not exists public.milestones (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  position       integer not null default 0,
  title          text not null,
  due_label      text,                         -- "Week 3" or a date, as written in the proposal
  due_date       date,
  status         text not null default 'upcoming' check (status in ('done', 'current', 'upcoming')),
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists milestones_eng_idx on public.milestones (engagement_id, position);

create table if not exists public.decisions (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  decided_on     date not null default current_date,
  decision       text not null,
  rationale      text,
  owner          text,
  created_at     timestamptz not null default now()
);
create index if not exists decisions_eng_idx on public.decisions (engagement_id, decided_on desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.inquiries  enable row level security;
alter table public.proposals  enable row level security;
alter table public.milestones enable row level security;
alter table public.decisions  enable row level security;

drop policy if exists "inquiries: admin" on public.inquiries;
create policy "inquiries: admin" on public.inquiries
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "proposals: admin" on public.proposals;
create policy "proposals: admin" on public.proposals
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "milestones: admin" on public.milestones;
create policy "milestones: admin" on public.milestones
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "milestones: client read own" on public.milestones;
create policy "milestones: client read own" on public.milestones
  for select using (public.owns_engagement(engagement_id));

drop policy if exists "decisions: admin" on public.decisions;
create policy "decisions: admin" on public.decisions
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "decisions: client read own" on public.decisions;
create policy "decisions: client read own" on public.decisions
  for select using (public.owns_engagement(engagement_id));
