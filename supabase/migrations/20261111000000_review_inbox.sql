-- A review inbox: documents an assistant prepares (for example, Claude in a cloud session)
-- wait here for Michael before any client or team member can see them.
--
-- The assistant reaches the portal only through the agent-upload function, with its own key.
-- That function can add files here and read engagement and milestone titles, nothing else.
-- Files live in a separate private bucket, "inbox", that only the admin can open. Clients'
-- storage rules all name the "portal" bucket, so nothing here is visible to them. In admin →
-- engagement → Documents, Michael opens each one and either shares it (it moves into the client's
-- Documents like any upload) or discards it.
-- Idempotent: safe to re-run; no drops.

-- 1. The private bucket, with the same size limit and file types as the portal's ---------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select 'inbox', 'inbox', false, 52428800, b.allowed_mime_types from storage.buckets b where b.id = 'portal'
on conflict (id) do nothing;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'inbox files: admin') then
    create policy "inbox files: admin" on storage.objects for all
      using (bucket_id = 'inbox' and public.is_admin()) with check (bucket_id = 'inbox' and public.is_admin());
  end if;
end $$;

-- 2. What's waiting -----------------------------------------------------------------------
create table if not exists public.inbox_documents (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references public.engagements (id) on delete cascade,
  milestone_id  uuid references public.milestones (id) on delete set null,
  title         text not null,
  note          text,
  path          text not null unique,     -- in the "inbox" bucket: <engagement_id>/<uuid>-<file name>
  name          text not null,
  size          bigint,
  content_type  text,
  suggest_team  boolean not null default false,  -- the assistant's suggestion; Michael decides
  source        text not null default 'assistant',
  created_at    timestamptz not null default now()
);
create index if not exists inbox_documents_eng_idx on public.inbox_documents (engagement_id, created_at);
alter table public.inbox_documents enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'inbox_documents' and policyname = 'inbox documents: admin') then
    create policy "inbox documents: admin" on public.inbox_documents for all using (public.is_admin()) with check (public.is_admin());
  end if;
end $$;
