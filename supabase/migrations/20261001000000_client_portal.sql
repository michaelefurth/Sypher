-- Sypher Solutions — Client Portal schema
-- Run once in the Supabase SQL editor (or `supabase db push`).
--
-- Roles
--   admin  : the Managing Principal. Sees and manages everything.
--   client : sees only their own engagements, assignments, answers, files and
--            *published* updates. AI drafts are never visible to clients.
--
-- Flow
--   invite client -> engagement -> assign questionnaire -> client answers (autosave)
--   -> client submits (locks answers) -> AI draft (admin-only) -> admin reviews/edits
--   -> admin publishes an update -> client is notified.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  company     text,
  role        text not null default 'client' check (role in ('admin', 'client')),
  created_at  timestamptz not null default now()
);

-- Every new auth user gets a profile (role defaults to client).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, company)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'company'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Clients may edit their name/company but never their role or email.
create or replace function public.protect_profile_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Applies to signed-in end users only; the SQL editor and the service role
  -- (no auth.uid()) can still set roles, e.g. for the one-time admin setup.
  if auth.uid() is not null and not public.is_admin() then
    new.role  := old.role;
    new.email := old.email;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ---------------------------------------------------------------------------
-- Engagements
-- ---------------------------------------------------------------------------
create table if not exists public.engagements (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.profiles (id) on delete cascade,
  title           text not null,
  summary         text,                -- shown to the client
  report_context  text,                -- admin-only: key assumptions/findings fed to the AI draft
  status          text not null default 'active' check (status in ('active', 'complete', 'archived')),
  created_at      timestamptz not null default now()
);
create index if not exists engagements_client_idx on public.engagements (client_id);

-- report_context is admin-only. The base table is admin-only under RLS;
-- clients read their engagements through this view, which omits report_context
-- and filters to the signed-in user (it runs with the view owner's rights).
create or replace view public.client_engagements as
  select id, client_id, title, summary, status, created_at
  from public.engagements
  where client_id = auth.uid() or public.is_admin();
revoke all on public.client_engagements from anon;
grant select on public.client_engagements to authenticated;

-- ---------------------------------------------------------------------------
-- Questionnaire templates
-- ---------------------------------------------------------------------------
create table if not exists public.questionnaires (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  intro        text,
  created_at   timestamptz not null default now()
);

create table if not exists public.questions (
  id                uuid primary key default gen_random_uuid(),
  questionnaire_id  uuid not null references public.questionnaires (id) on delete cascade,
  position          integer not null,
  number            text,
  section_code      text,
  section_title     text,
  prompt            text not null,
  why               text,             -- "what the answer changes"
  priority          text check (priority in ('rerun', 'critical')),
  answer_type       text not null default 'long_text'
                    check (answer_type in ('long_text', 'short_text', 'number', 'currency', 'date', 'yes_no')),
  required          boolean not null default false
);
create index if not exists questions_q_idx on public.questions (questionnaire_id, position);

-- ---------------------------------------------------------------------------
-- Assignments (a questionnaire given to an engagement)
-- ---------------------------------------------------------------------------
create table if not exists public.assignments (
  id                uuid primary key default gen_random_uuid(),
  engagement_id     uuid not null references public.engagements (id) on delete cascade,
  questionnaire_id  uuid not null references public.questionnaires (id) on delete restrict,
  status            text not null default 'open'
                    check (status in ('open', 'submitted', 'reopened', 'complete')),
  due_date          date,
  message           text,             -- note from Michael shown above the questionnaire
  submitted_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists assignments_eng_idx on public.assignments (engagement_id);

create table if not exists public.answers (
  id             uuid primary key default gen_random_uuid(),
  assignment_id  uuid not null references public.assignments (id) on delete cascade,
  question_id    uuid not null references public.questions (id) on delete cascade,
  value          text,
  state          text not null default 'answered' check (state in ('answered', 'unknown')),
  note           text,                -- e.g. "will confirm with our lender by Friday"
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles (id),
  unique (assignment_id, question_id)
);

create or replace function public.touch_answer()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger if exists touch_answer on public.answers;
create trigger touch_answer before insert or update on public.answers
  for each row execute function public.touch_answer();

-- ---------------------------------------------------------------------------
-- Files (stored in the private 'portal' bucket at <engagement_id>/<uuid>-<name>)
-- ---------------------------------------------------------------------------
create table if not exists public.files (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  assignment_id  uuid references public.assignments (id) on delete set null,
  question_id    uuid references public.questions (id) on delete set null,
  path           text not null unique,
  name           text not null,
  size           bigint,
  uploaded_by    uuid references public.profiles (id) default auth.uid(),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- AI drafts (admin-only) and published updates (client-visible)
-- ---------------------------------------------------------------------------
create table if not exists public.report_drafts (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  assignment_id  uuid references public.assignments (id) on delete set null,
  status         text not null default 'drafting'
                 check (status in ('drafting', 'awaiting_review', 'published', 'dismissed', 'failed')),
  draft          jsonb,              -- structured output from Claude
  model          text,
  error          text,
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz
);

create table if not exists public.publications (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  draft_id       uuid references public.report_drafts (id) on delete set null,
  title          text not null,
  body           text not null,      -- plain text / light markdown, approved by Michael
  published_at   timestamptz not null default now()
);

create table if not exists public.activity (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid references public.engagements (id) on delete cascade,
  actor          uuid references public.profiles (id) default auth.uid(),
  kind           text not null,
  detail         jsonb,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helper predicates
-- ---------------------------------------------------------------------------
create or replace function public.owns_engagement(eng uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.engagements e where e.id = eng and e.client_id = auth.uid());
$$;

create or replace function public.owns_assignment(asg uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.assignments a
    join public.engagements e on e.id = a.engagement_id
    where a.id = asg and e.client_id = auth.uid()
  );
$$;

create or replace function public.questionnaire_assigned_to_me(qid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.assignments a
    join public.engagements e on e.id = a.engagement_id
    where a.questionnaire_id = qid and e.client_id = auth.uid()
  );
$$;

create or replace function public.assignment_is_open(asg uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.assignments a where a.id = asg and a.status in ('open', 'reopened'));
$$;

-- Client action: submit a questionnaire (locks answers until Michael reopens it).
create or replace function public.submit_assignment(asg uuid)
returns void language plpgsql security definer set search_path = public as $$
declare eng uuid;
begin
  if not (public.owns_assignment(asg) or public.is_admin()) then
    raise exception 'not allowed';
  end if;
  update public.assignments
     set status = 'submitted', submitted_at = now()
   where id = asg and status in ('open', 'reopened')
  returning engagement_id into eng;
  if eng is null then
    raise exception 'questionnaire is not open';
  end if;
  insert into public.activity (engagement_id, kind, detail)
  values (eng, 'assignment_submitted', jsonb_build_object('assignment_id', asg));
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.engagements    enable row level security;
alter table public.questionnaires enable row level security;
alter table public.questions      enable row level security;
alter table public.assignments    enable row level security;
alter table public.answers        enable row level security;
alter table public.files          enable row level security;
alter table public.report_drafts  enable row level security;
alter table public.publications   enable row level security;
alter table public.activity       enable row level security;

-- profiles
drop policy if exists "profiles: self or admin read" on public.profiles;
create policy "profiles: self or admin read" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles: self or admin update" on public.profiles;
create policy "profiles: self or admin update" on public.profiles
  for update using (id = auth.uid() or public.is_admin());

-- engagements: admin only on the base table (it holds report_context)
drop policy if exists "engagements: admin" on public.engagements;
create policy "engagements: admin" on public.engagements
  for all using (public.is_admin()) with check (public.is_admin());
-- Clients have no direct access to the base table (it holds report_context);
-- they read public.client_engagements instead.

-- questionnaires & questions: admin manages; clients read the ones assigned to them
drop policy if exists "questionnaires: admin" on public.questionnaires;
create policy "questionnaires: admin" on public.questionnaires
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "questionnaires: assigned read" on public.questionnaires;
create policy "questionnaires: assigned read" on public.questionnaires
  for select using (public.questionnaire_assigned_to_me(id));

drop policy if exists "questions: admin" on public.questions;
create policy "questions: admin" on public.questions
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "questions: assigned read" on public.questions;
create policy "questions: assigned read" on public.questions
  for select using (public.questionnaire_assigned_to_me(questionnaire_id));

-- assignments: clients read their own; status changes go through submit_assignment()
drop policy if exists "assignments: admin" on public.assignments;
create policy "assignments: admin" on public.assignments
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "assignments: client read own" on public.assignments;
create policy "assignments: client read own" on public.assignments
  for select using (public.owns_engagement(engagement_id));

-- answers: clients read theirs; write only while the questionnaire is open
drop policy if exists "answers: admin" on public.answers;
create policy "answers: admin" on public.answers
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "answers: client read own" on public.answers;
create policy "answers: client read own" on public.answers
  for select using (public.owns_assignment(assignment_id));
drop policy if exists "answers: client insert while open" on public.answers;
create policy "answers: client insert while open" on public.answers
  for insert with check (public.owns_assignment(assignment_id) and public.assignment_is_open(assignment_id));
drop policy if exists "answers: client update while open" on public.answers;
create policy "answers: client update while open" on public.answers
  for update using (public.owns_assignment(assignment_id) and public.assignment_is_open(assignment_id))
  with check (public.owns_assignment(assignment_id) and public.assignment_is_open(assignment_id));

-- files
drop policy if exists "files: admin" on public.files;
create policy "files: admin" on public.files
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "files: client read own" on public.files;
create policy "files: client read own" on public.files
  for select using (public.owns_engagement(engagement_id));
drop policy if exists "files: client add own" on public.files;
create policy "files: client add own" on public.files
  for insert with check (public.owns_engagement(engagement_id));

-- report drafts: admin only (clients never see unreviewed AI output)
drop policy if exists "drafts: admin" on public.report_drafts;
create policy "drafts: admin" on public.report_drafts
  for all using (public.is_admin()) with check (public.is_admin());

-- publications: clients read their own
drop policy if exists "publications: admin" on public.publications;
create policy "publications: admin" on public.publications
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "publications: client read own" on public.publications;
create policy "publications: client read own" on public.publications
  for select using (public.owns_engagement(engagement_id));

-- activity
drop policy if exists "activity: admin" on public.activity;
create policy "activity: admin" on public.activity
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "activity: client read own" on public.activity;
create policy "activity: client read own" on public.activity
  for select using (public.owns_engagement(engagement_id));

grant execute on function public.submit_assignment(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket; objects live under <engagement_id>/...
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('portal', 'portal', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "portal files: admin" on storage.objects;
create policy "portal files: admin" on storage.objects
  for all using (bucket_id = 'portal' and public.is_admin())
  with check (bucket_id = 'portal' and public.is_admin());

drop policy if exists "portal files: client read own" on storage.objects;
create policy "portal files: client read own" on storage.objects
  for select using (
    bucket_id = 'portal'
    and public.owns_engagement(((storage.foldername(name))[1])::uuid));

drop policy if exists "portal files: client upload own" on storage.objects;
create policy "portal files: client upload own" on storage.objects
  for insert with check (
    bucket_id = 'portal'
    and public.owns_engagement(((storage.foldername(name))[1])::uuid));

-- ---------------------------------------------------------------------------
-- After running this file, make yourself the admin (one time):
--   update public.profiles set role = 'admin' where email = 'michael@sypher.solutions';
-- (Sign in to the portal once first so your profile exists.)
-- ---------------------------------------------------------------------------
