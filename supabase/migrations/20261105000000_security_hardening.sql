-- Sypher Solutions: security hardening.
-- Run after 20261104000000_team_access.sql (SQL editor or `supabase db push`).
--
-- 1. Admin access needs a two-step sign-in. public.is_admin() is true only for an admin
--    whose session is at assurance level aal2 (an authenticator-app code was verified).
--    A stolen sign-in link alone no longer opens anything admin-only. The admin page
--    walks Michael through setting up the authenticator app the first time.
-- 2. The private file bucket accepts documents, spreadsheets, slides, text and images only.
-- 3. Supabase security advisor items: fixed search_path on three functions, and helper and
--    trigger functions no longer callable by signed-out visitors (or, for triggers, by anyone).

-- 1. Two-step sign-in for admin access ------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 2. Allowed file types ----------------------------------------------------------------
update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/rtf',
     'text/csv',
     'text/plain',
     'image/png',
     'image/jpeg',
     'image/gif',
     'image/webp',
     'image/heic',
     'image/heif'
   ]
 where id = 'portal';

-- 3. Advisor items -------------------------------------------------------------------------
alter function public.touch_answer() set search_path = public;
alter function public.touch_proposal() set search_path = public;
alter function public.proposal_public(public.proposals) set search_path = public;

-- Helpers used inside access rules: signed-in users need them, signed-out visitors don't.
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.owns_engagement(uuid) from public, anon;
revoke execute on function public.owns_assignment(uuid) from public, anon;
revoke execute on function public.questionnaire_assigned_to_me(uuid) from public, anon;
revoke execute on function public.assignment_is_open(uuid) from public, anon;
revoke execute on function public.submit_assignment(uuid) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.owns_engagement(uuid) to authenticated;
grant execute on function public.owns_assignment(uuid) to authenticated;
grant execute on function public.questionnaire_assigned_to_me(uuid) to authenticated;
grant execute on function public.assignment_is_open(uuid) to authenticated;
grant execute on function public.submit_assignment(uuid) to authenticated;

-- Trigger functions run only as triggers; nobody needs to call them directly.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.protect_profile_fields() from public, anon, authenticated;
revoke execute on function public.touch_answer() from public, anon, authenticated;
revoke execute on function public.touch_proposal() from public, anon, authenticated;
