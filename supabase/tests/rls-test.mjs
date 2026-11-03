// Row level security tests for the Client Portal schema.
// Runs the migration in PGlite (Postgres compiled to WASM) with minimal
// stand-ins for Supabase's auth and storage schemas, then acts as each user.
//
//   cd supabase/tests && npm i @electric-sql/pglite && node rls-test.mjs
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";

const db = new PGlite({ extensions: { pgcrypto } });
const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
const rows = async (s) => (await db.query(s)).rows;

// --- Minimal stand-ins for Supabase's auth + storage schemas and roles ---
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant execute on function auth.jwt() to anon, authenticated;
  grant all on storage.objects to authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`);

// Every migration, in order (or one file passed on the command line).
const migDir = new URL("../migrations/", import.meta.url);
const sql = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(new URL(f, migDir), "utf8")).join("\n");
try { await db.exec(sql); ok("migration runs", true); }
catch (e) { ok("migration runs", false, e.message); console.log(results.join("\n")); process.exit(1); }
// run twice: must be idempotent
try { await db.exec(sql); ok("migration is re-runnable", true); } catch (e) { ok("migration is re-runnable", false, e.message); }

const ADMIN = "00000000-0000-0000-0000-00000000000a", A = "00000000-0000-0000-0000-0000000000a1", B = "00000000-0000-0000-0000-0000000000b1";
await db.exec(`
  insert into auth.users (id, email, raw_user_meta_data) values
   ('${ADMIN}', 'michael@sypher.solutions', '{}'),
   ('${A}', 'a@client.example', '{"full_name":"Client A","company":"A Co"}'),
   ('${B}', 'b@client.example', '{}');
  update public.profiles set role = 'admin' where email = 'michael@sypher.solutions';
  insert into public.engagements (id, client_id, title, report_context) values
   ('10000000-0000-0000-0000-000000000001', '${A}', 'Eng A', 'SECRET CONTEXT A'),
   ('10000000-0000-0000-0000-000000000002', '${B}', 'Eng B', 'SECRET CONTEXT B');
  insert into public.questionnaires (id, title) values ('20000000-0000-0000-0000-000000000001', 'Q1');
  insert into public.questions (id, questionnaire_id, position, prompt) values
   ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1, 'one'),
   ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 2, 'two');
  insert into public.assignments (id, engagement_id, questionnaire_id) values
   ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
  insert into public.report_drafts (engagement_id, status, draft) values ('10000000-0000-0000-0000-000000000001', 'awaiting_review', '{"summary":"x"}');
  insert into public.publications (engagement_id, title, body) values ('10000000-0000-0000-0000-000000000001', 'Pub A', 'Body');
`);

// Sessions: the admin signs in with a verified authenticator code (aal2) unless a test says
// otherwise; everyone else signs in with an email link (aal1).
async function as(user, fn, aal = user === ADMIN ? "aal2" : "aal1") {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, aal })}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
const q = (s, p) => db.query(s, p);
const fails = async (s) => { try { await q(s); return false; } catch { return true; } };

ok("profiles auto-created by trigger", (await q(`select count(*)::int n from public.profiles`)).rows[0].n === 3);

await as(A, async () => {
  const ce = await q(`select * from public.client_engagements`);
  ok("client sees only own engagement via view", ce.rows.length === 1 && ce.rows[0].title === "Eng A");
  ok("view does not expose report_context", !("report_context" in ce.rows[0]));
  ok("client cannot read base engagements table", (await q(`select * from public.engagements`)).rows.length === 0);
  ok("client sees assigned questions", (await q(`select * from public.questions`)).rows.length === 2);
  ok("client sees assigned questionnaire", (await q(`select * from public.questionnaires`)).rows.length === 1);
  ok("client sees own assignment", (await q(`select * from public.assignments`)).rows.length === 1);
  ok("client cannot see AI drafts", (await q(`select * from public.report_drafts`)).rows.length === 0);
  ok("client sees own publication", (await q(`select * from public.publications`)).rows.length === 1);
  await q(`insert into public.answers (assignment_id, question_id, value) values ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','hello')`);
  ok("client can answer while open", (await q(`select * from public.answers`)).rows.length === 1);
  const upd = await q(`update public.assignments set status = 'complete' returning id`);
  ok("client cannot change assignment status directly", upd.rows.length === 0);
  await q(`update public.profiles set role = 'admin' where id = '${A}'`);
  ok("client cannot promote themselves", (await q(`select role from public.profiles where id = '${A}'`)).rows[0].role === "client");
  ok("client can upload to own engagement folder", !(await fails(`insert into storage.objects (bucket_id, name) values ('portal', '10000000-0000-0000-0000-000000000001/x.pdf')`)));
  ok("client cannot upload to another engagement", await fails(`insert into storage.objects (bucket_id, name) values ('portal', '10000000-0000-0000-0000-000000000002/x.pdf')`));
  await q(`select public.submit_assignment('40000000-0000-0000-0000-000000000001')`);
  ok("submit locks the questionnaire", (await q(`select status from public.assignments`)).rows[0].status === "submitted");
  ok("answers are read-only after submit", await fails(`insert into public.answers (assignment_id, question_id, value) values ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','late')`));
  const u2 = await q(`update public.answers set value = 'changed' returning id`);
  ok("existing answers cannot be edited after submit", u2.rows.length === 0);
});

await as(B, async () => {
  ok("other client sees none of A's engagement", (await q(`select * from public.client_engagements`)).rows.every((r) => r.title === "Eng B"));
  ok("other client cannot see A's questions", (await q(`select * from public.questions`)).rows.length === 0);
  ok("other client cannot see A's answers", (await q(`select * from public.answers`)).rows.length === 0);
  ok("other client cannot see A's publications", (await q(`select * from public.publications`)).rows.length === 0);
  ok("other client cannot submit A's questionnaire", await fails(`select public.submit_assignment('40000000-0000-0000-0000-000000000001')`));
  ok("other client cannot write to A's assignment", await fails(`insert into public.answers (assignment_id, question_id, value) values ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','x')`));
});

await as(ADMIN, async () => {
  const e = await q(`select title, report_context from public.engagements order by title`);
  ok("admin reads all engagements with report_context", e.rows.length === 2 && e.rows[0].report_context === "SECRET CONTEXT A");
  ok("admin sees drafts", (await q(`select * from public.report_drafts`)).rows.length === 1);
  const all = await rows(`select id, status from public.assignments`);
  ok("admin sees assignments", all.length === 1, JSON.stringify(all) + " is_admin=" + JSON.stringify(await rows(`select public.is_admin() a, auth.uid() u`)));
  await q(`update public.assignments set status = 'reopened'`);
  const after = await rows(`select status from public.assignments`);
  ok("admin can reopen a questionnaire", after[0]?.status === "reopened");
  ok("admin sees all clients' profiles", (await q(`select * from public.profiles`)).rows.length === 3);
});

await as(A, async () => {
  const u3 = await q(`update public.answers set value = 'edited after reopen' returning id`);
  ok("client can edit again once reopened", u3.rows.length === 1);
});

// --- Diagnostic inquiries, proposals and client rooms ---
const ENG_A = "10000000-0000-0000-0000-000000000001";
await db.exec(`
  insert into public.inquiries (id, name, email, practices, answers) values
   ('50000000-0000-0000-0000-000000000001', 'Prospect', 'p@example.com', '{Launch}', '[{"key":"x","question":"q","answer":"a"}]');
  insert into public.proposals (id, token, status, title, content, valid_until) values
   ('60000000-0000-0000-0000-000000000001', 'tok-sent', 'sent', 'Prop Sent', '{"options":[{"id":"build","name":"Build"}]}', current_date + 30),
   ('60000000-0000-0000-0000-000000000002', 'tok-draft', 'draft', 'Prop Draft', '{}', null),
   ('60000000-0000-0000-0000-000000000003', 'tok-old', 'sent', 'Prop Expired', '{"options":[{"id":"build"}]}', current_date - 1),
   ('60000000-0000-0000-0000-000000000004', 'tok-decline', 'sent', 'Prop Decline', '{"options":[]}', null);
  insert into public.milestones (engagement_id, position, title, status) values ('${ENG_A}', 1, 'Kickoff', 'done');
  insert into public.decisions (engagement_id, decision) values ('${ENG_A}', 'Go with option B');
`);

async function asAnon(fn) {
  await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

await asAnon(async () => {
  ok("anon cannot read inquiries", await fails(`select * from public.inquiries`) || (await q(`select * from public.inquiries`)).rows.length === 0);
  ok("anon cannot insert inquiries directly", await fails(`insert into public.inquiries (name, email) values ('x', 'x@x.co')`));
  ok("anon cannot list proposals", await fails(`select * from public.proposals`) || (await q(`select * from public.proposals`)).rows.length === 0);
  const p = (await q(`select public.get_proposal('tok-sent') p`)).rows[0].p;
  ok("anon reads a sent proposal by token", p?.title === "Prop Sent" && p.status === "viewed");
  ok("public proposal hides the token and internal ids", p && !("token" in p) && !("inquiry_id" in p) && !("engagement_id" in p));
  ok("anon cannot read a draft proposal", (await q(`select public.get_proposal('tok-draft') p`)).rows[0].p === null);
  ok("unknown token returns nothing", (await q(`select public.get_proposal('nope') p`)).rows[0].p === null);
  ok("accept needs a valid option", await fails(`select public.respond_proposal('tok-sent', 'accept', 'nope', 'Avery Morgan', 'Owner', 'avery@example.com')`));
  ok("accept needs a signature", await fails(`select public.respond_proposal('tok-sent', 'accept', 'build', '', 'Owner', 'avery@example.com')`));
  const r = (await q(`select public.respond_proposal('tok-sent', 'accept', 'build', 'Avery Morgan', 'Owner', 'Avery@Example.com') r`)).rows[0].r;
  ok("anon can accept a sent proposal", r?.status === "accepted" && r.signer_name === "Avery Morgan");
  ok("a proposal can't be answered twice", await fails(`select public.respond_proposal('tok-sent', 'decline')`));
  ok("an expired proposal can't be accepted", await fails(`select public.respond_proposal('tok-old', 'accept', 'build', 'Avery Morgan', '', 'a@example.com')`));
  ok("expired proposal is flagged", (await q(`select public.get_proposal('tok-old') p`)).rows[0].p.expired === true);
  const d = (await q(`select public.respond_proposal('tok-decline', 'decline', null, null, null, null, 'Timing') r`)).rows[0].r;
  ok("anon can decline", d?.status === "declined");
  ok("anon cannot update proposals directly", (await q(`update public.proposals set status = 'accepted' returning id`).catch(() => ({ rows: [] }))).rows.length === 0);
  ok("anon cannot read milestones", await fails(`select * from public.milestones`) || (await q(`select * from public.milestones`)).rows.length === 0);
});

await as(A, async () => {
  ok("client sees own milestones", (await q(`select * from public.milestones`)).rows.length === 1);
  ok("client sees own decisions", (await q(`select * from public.decisions`)).rows.length === 1);
  ok("client cannot add a decision", await fails(`insert into public.decisions (engagement_id, decision) values ('${ENG_A}', 'x')`));
  ok("client cannot read inquiries", (await q(`select * from public.inquiries`)).rows.length === 0);
  ok("client cannot read proposals table", (await q(`select * from public.proposals`)).rows.length === 0);
  const ce = await q(`select * from public.client_engagements`);
  ok("room fields reach the client view", "next_meeting_at" in ce.rows[0] && !("report_context" in ce.rows[0]));
});

await as(B, async () => {
  ok("other client cannot see A's milestones", (await q(`select * from public.milestones`)).rows.length === 0);
  ok("other client cannot see A's decisions", (await q(`select * from public.decisions`)).rows.length === 0);
});

await as(ADMIN, async () => {
  ok("admin reads inquiries", (await q(`select * from public.inquiries`)).rows.length === 1);
  const pr = await rows(`select status, signer_email, view_count from public.proposals where token = 'tok-sent'`);
  ok("acceptance recorded with tracking", pr[0]?.status === "accepted" && pr[0].signer_email === "avery@example.com" && pr[0].view_count === 1);
  const before = (await rows(`select view_count from public.proposals where token = 'tok-draft'`))[0].view_count;
  const prev = (await q(`select public.get_proposal('tok-draft') p`)).rows[0].p;
  const after = (await rows(`select view_count from public.proposals where token = 'tok-draft'`))[0].view_count;
  ok("admin can preview a draft without counting a view", prev?.title === "Prop Draft" && before === after);
  ok("acceptance logged to activity", (await q(`select * from public.activity where kind = 'proposal_accepted'`)).rows.length === 1);
});

// --- Client room: messages, deliverables, action items, agreement, timeline ---
const ENG_B = "10000000-0000-0000-0000-000000000002";
await db.exec(`
  update public.proposals set engagement_id = '${ENG_A}' where token = 'tok-sent';
  insert into public.deliverables (id, engagement_id, title, path, name) values
   ('70000000-0000-0000-0000-000000000001', '${ENG_A}', 'Cash model', '${ENG_A}/deliverables/m.xlsx', 'm.xlsx'),
   ('70000000-0000-0000-0000-000000000002', '${ENG_B}', 'B report', '${ENG_B}/deliverables/b.pdf', 'b.pdf');
  insert into public.action_items (id, engagement_id, title) values
   ('80000000-0000-0000-0000-000000000001', '${ENG_A}', 'Send bank statements'),
   ('80000000-0000-0000-0000-000000000002', '${ENG_B}', 'B task');
`);

await as(ADMIN, async () => {
  await q(`insert into public.messages (engagement_id, body) values ('${ENG_A}', 'Hello from Michael')`);
  ok("admin can post a message", (await q(`select * from public.messages`)).rows.length === 1);
});

await as(A, async () => {
  ok("client reads own thread", (await q(`select * from public.messages`)).rows.length === 1);
  await q(`insert into public.messages (engagement_id, author_id, body) values ('${ENG_A}', '${A}', 'Hi Michael')`);
  ok("client can post in own thread", (await q(`select * from public.messages`)).rows.length === 2);
  ok("client cannot post as someone else", await fails(`insert into public.messages (engagement_id, author_id, body) values ('${ENG_A}', '${ADMIN}', 'spoof')`));
  ok("client cannot post in another thread", await fails(`insert into public.messages (engagement_id, author_id, body) values ('${ENG_B}', '${A}', 'x')`));
  ok("client cannot pre-mark a message read", await fails(`insert into public.messages (engagement_id, author_id, body, read_at) values ('${ENG_A}', '${A}', 'x', now())`));
  ok("empty messages are rejected", await fails(`insert into public.messages (engagement_id, author_id, body) values ('${ENG_A}', '${A}', '   ')`));
  ok("client cannot edit messages", (await q(`update public.messages set body = 'edited' returning id`)).rows.length === 0);
  ok("client cannot delete messages", (await q(`delete from public.messages returning id`)).rows.length === 0);
  const n = (await q(`select public.mark_messages_read('${ENG_A}') n`)).rows[0].n;
  ok("client marks Michael's messages read, not their own", n === 1 && (await rows(`select count(*)::int c from public.messages where read_at is null`))[0].c === 1);
  ok("client cannot mark another thread read", await fails(`select public.mark_messages_read('${ENG_B}')`));

  ok("client sees own deliverables only", (await rows(`select title from public.deliverables`)).map((r) => r.title).join() === "Cash model");
  ok("client cannot add a deliverable", await fails(`insert into public.deliverables (engagement_id, title, path, name) values ('${ENG_A}', 'x', '${ENG_A}/deliverables/x', 'x')`));

  ok("client sees own action items only", (await rows(`select title from public.action_items`)).map((r) => r.title).join() === "Send bank statements");
  ok("client cannot edit action items directly", (await q(`update public.action_items set title = 'x' returning id`)).rows.length === 0);
  ok("client can add a to-do for themselves", !(await fails(`insert into public.action_items (engagement_id, title) values ('${ENG_A}', 'Call the bank')`)));
  await q(`select public.set_action_item_done('80000000-0000-0000-0000-000000000001', true)`);
  const done = await rows(`select done_at, done_by from public.action_items where id = '80000000-0000-0000-0000-000000000001'`);
  ok("client can tick their own action item", done[0].done_at !== null && done[0].done_by === A);
  ok("client cannot tick another client's item", await fails(`select public.set_action_item_done('80000000-0000-0000-0000-000000000002', true)`));

  const ag = (await q(`select public.engagement_agreement('${ENG_A}') a`)).rows[0].a;
  ok("client reads their signed agreement", ag?.status === "accepted" && ag.signer_name === "Avery Morgan" && !("token" in ag));
  ok("client cannot read another engagement's agreement", (await q(`select public.engagement_agreement('${ENG_B}') a`)).rows[0].a === null);

  const kinds = (await rows(`select kind from public.activity where engagement_id = '${ENG_A}'`)).map((r) => r.kind);
  ok("timeline records messages, deliverables, to-dos and decisions",
    ["message_posted", "deliverable_shared", "action_assigned", "action_done", "decision_recorded"].every((k) => kinds.includes(k)), kinds.join(","));
  ok("client cannot write to the timeline directly", await fails(`insert into public.activity (engagement_id, kind) values ('${ENG_A}', 'fake')`));
});

await as(B, async () => {
  ok("other client cannot read A's messages", (await q(`select * from public.messages`)).rows.length === 0);
  ok("other client cannot read A's deliverables", (await rows(`select title from public.deliverables`)).every((r) => r.title === "B report"));
  ok("other client cannot read A's timeline", (await q(`select * from public.activity where engagement_id = '${ENG_A}'`)).rows.length === 0);
});

await asAnon(async () => {
  ok("anon cannot read messages", await fails(`select * from public.messages`) || (await q(`select * from public.messages`)).rows.length === 0);
  ok("anon cannot call room functions", await fails(`select public.engagement_agreement('${ENG_A}')`) && await fails(`select public.mark_messages_read('${ENG_A}')`));
});

await as(ADMIN, async () => {
  await q(`update public.milestones set status = 'current' where engagement_id = '${ENG_A}'`);
  ok("milestone progress reaches the timeline", (await q(`select * from public.activity where kind = 'milestone_current'`)).rows.length === 1);
  const n = (await q(`select public.mark_messages_read('${ENG_A}') n`)).rows[0].n;
  ok("admin marks the client's message read", n === 1);
});

// --- Team access: outside advisers on an engagement ---
const CPA = "00000000-0000-0000-0000-0000000000c1", LAW = "00000000-0000-0000-0000-0000000000c2", OLD = "00000000-0000-0000-0000-0000000000c3";
await db.exec(`
  insert into auth.users (id, email) values ('${CPA}', 'cpa@firm.example'), ('${LAW}', 'law@firm.example'), ('${OLD}', 'old@firm.example');
  insert into public.engagement_members (id, engagement_id, user_id, email, full_name, role_label, can_message, can_files, expires_at, status) values
   ('90000000-0000-0000-0000-000000000001', '${ENG_A}', '${CPA}', 'cpa@firm.example', 'Pat CPA', 'CPA', true, true, now() + interval '30 days', 'active'),
   ('90000000-0000-0000-0000-000000000002', '${ENG_A}', '${LAW}', 'law@firm.example', 'Lee Law', 'Attorney', false, true, null, 'active'),
   ('90000000-0000-0000-0000-000000000003', '${ENG_A}', '${OLD}', 'old@firm.example', 'Old Adviser', 'Lender', true, true, now() - interval '1 day', 'active');
  insert into public.messages (engagement_id, author_id, body, thread) values ('${ENG_A}', '${ADMIN}', 'Welcome to the team thread', 'team');
  update public.deliverables set shared_with_team = true where id = '70000000-0000-0000-0000-000000000001';
  insert into storage.objects (bucket_id, name) values ('portal', '${ENG_A}/deliverables/m.xlsx'), ('portal', '${ENG_A}/deliverables/private.pdf'), ('portal', '${ENG_A}/answers/q.pdf');
  insert into public.deliverables (id, engagement_id, title, path, name) values
   ('70000000-0000-0000-0000-000000000003', '${ENG_A}', 'Private memo', '${ENG_A}/deliverables/private.pdf', 'private.pdf');
  insert into public.action_items (id, engagement_id, title, assignee_id) values
   ('80000000-0000-0000-0000-000000000003', '${ENG_A}', 'Review the 2025 return', '${CPA}');
`);

ok("adding a member is logged to the timeline", (await rows(`select count(*)::int c from public.activity where kind = 'member_invited'`))[0].c === 3);

await as(CPA, async () => {
  const ce = await rows(`select title, access, next_meeting_at, meeting_link from public.client_engagements`);
  ok("member sees the engagement as a member", ce.length === 1 && ce[0].access === "member" && ce[0].title === "Eng A");
  ok("member never sees meeting details", ce[0].next_meeting_at === null && ce[0].meeting_link === null);
  ok("member reads the team thread only", (await rows(`select thread from public.messages`)).every((r) => r.thread === "team") && (await rows(`select * from public.messages`)).length === 1);
  await q(`insert into public.messages (engagement_id, author_id, body, thread) values ('${ENG_A}', '${CPA}', 'Return attached', 'team')`);
  ok("member can post in the team thread", (await rows(`select * from public.messages`)).length === 2);
  ok("member cannot post in the private thread", await fails(`insert into public.messages (engagement_id, author_id, body, thread) values ('${ENG_A}', '${CPA}', 'psst', 'private')`));
  ok("member cannot post on another engagement", await fails(`insert into public.messages (engagement_id, author_id, body, thread) values ('${ENG_B}', '${CPA}', 'x', 'team')`));
  ok("member sees shared deliverables only", (await rows(`select title from public.deliverables`)).map((r) => r.title).join() === "Cash model");
  const objs = (await rows(`select name from storage.objects where bucket_id = 'portal' order by name`)).map((r) => r.name);
  ok("member can open the shared deliverable file", objs.includes(`${ENG_A}/deliverables/m.xlsx`));
  ok("member cannot open private files in storage", !objs.includes(`${ENG_A}/deliverables/private.pdf`) && !objs.includes(`${ENG_A}/answers/q.pdf`), objs.join(","));
  ok("member can upload to the team folder", !(await fails(`insert into storage.objects (bucket_id, name) values ('portal', '${ENG_A}/team/return.pdf')`)));
  ok("member cannot upload outside the team folder", await fails(`insert into storage.objects (bucket_id, name) values ('portal', '${ENG_A}/deliverables/fake.pdf')`));
  await q(`insert into public.team_files (engagement_id, path, name) values ('${ENG_A}', '${ENG_A}/team/return.pdf', 'return.pdf')`);
  ok("member can list a team file", (await rows(`select * from public.team_files`)).length === 1);
  ok("member cannot file outside the team folder", await fails(`insert into public.team_files (engagement_id, path, name) values ('${ENG_A}', '${ENG_A}/x.pdf', 'x.pdf')`));
  ok("member sees team tasks, not the client's own", (await rows(`select title from public.action_items`)).map((r) => r.title).join() === "Review the 2025 return");
  await q(`select public.set_action_item_done('80000000-0000-0000-0000-000000000003', true)`);
  ok("member ticks off their own task", (await rows(`select done_by from public.action_items`))[0].done_by === CPA);
  ok("member cannot tick the client's task", await fails(`select public.set_action_item_done('80000000-0000-0000-0000-000000000001', false)`));
  ok("member cannot add tasks", await fails(`insert into public.action_items (engagement_id, title, assignee_id) values ('${ENG_A}', 'x', '${CPA}')`));
  for (const [what, sql] of [["questionnaires", "assignments"], ["answers", "answers"], ["updates", "publications"], ["decisions", "decisions"], ["milestones", "milestones"], ["timeline", "activity"], ["AI drafts", "report_drafts"]]) {
    ok(`member cannot see ${what}`, (await rows(`select * from public.${sql}`)).length === 0);
  }
  ok("member cannot read the agreement", (await q(`select public.engagement_agreement('${ENG_A}') a`)).rows[0].a === null);
  ok("member cannot read the base engagement (report context)", (await rows(`select * from public.engagements`)).length === 0);
  const roster = (await q(`select public.team_roster('${ENG_A}') r`)).rows[0].r;
  ok("member sees active teammates without their emails", roster.members.length === 2 && roster.members.every((m) => m.email === null) && roster.client.name);
  ok("member cannot change anyone's access", await fails(`select public.set_member_access('90000000-0000-0000-0000-000000000001', true, true, null, 'active')`));
  ok("member cannot add members", await fails(`insert into public.engagement_members (engagement_id, user_id, email) values ('${ENG_A}', '${B}', 'b@client.example')`));
  await q(`select public.mark_team_read('${ENG_A}')`);
  ok("member keeps a last-read mark on the team thread", (await rows(`select * from public.thread_reads`)).length === 1);
});

await as(LAW, async () => {
  ok("member without messaging can't read the team thread", (await rows(`select * from public.messages`)).length === 0);
  ok("member without messaging can't post", await fails(`insert into public.messages (engagement_id, author_id, body, thread) values ('${ENG_A}', '${LAW}', 'x', 'team')`));
  ok("member with files sees team files", (await rows(`select * from public.team_files`)).length === 1);
});

await as(OLD, async () => {
  ok("expired member sees no engagement", (await rows(`select * from public.client_engagements`)).length === 0);
  ok("expired member reads nothing", (await rows(`select * from public.messages`)).length === 0 && (await rows(`select * from public.team_files`)).length === 0);
  ok("expired member cannot post", await fails(`insert into public.messages (engagement_id, author_id, body, thread) values ('${ENG_A}', '${OLD}', 'x', 'team')`));
  ok("expired member gets no roster", (await q(`select public.team_roster('${ENG_A}') r`)).rows[0].r === null);
});

await as(A, async () => {
  ok("client sees both threads", (await rows(`select distinct thread from public.messages order by thread`)).map((r) => r.thread).join() === "private,team");
  ok("client sees the team's files", (await rows(`select * from public.team_files`)).length === 1);
  const roster = (await q(`select public.team_roster('${ENG_A}') r`)).rows[0].r;
  ok("client sees every member with status and email", roster.members.length === 3 && roster.members.find((m) => m.name === "Old Adviser").status === "expired" && roster.members[0].email);
  await q(`insert into public.action_items (engagement_id, title, assignee_id) values ('${ENG_A}', 'Draft the lease rider', '${LAW}')`);
  ok("client can assign a task to a team member", (await rows(`select * from public.action_items where assignee_id = '${LAW}'`)).length === 1);
  ok("client cannot assign to someone outside the team", await fails(`insert into public.action_items (engagement_id, title, assignee_id) values ('${ENG_A}', 'x', '${B}')`));
  ok("client cannot add tasks to another engagement", await fails(`insert into public.action_items (engagement_id, title) values ('${ENG_B}', 'x')`));
  await q(`select public.set_member_access('90000000-0000-0000-0000-000000000002', true, true, now() + interval '7 days', 'active')`);
  ok("client can change a member's access", (await rows(`select can_message from public.engagement_members where id = '90000000-0000-0000-0000-000000000002'`))[0].can_message === true);
  await q(`select public.set_member_access('90000000-0000-0000-0000-000000000001', true, true, null, 'revoked')`);
  ok("client can revoke a member", (await rows(`select status from public.engagement_members where id = '90000000-0000-0000-0000-000000000001'`))[0].status === "revoked");
  ok("client marks Michael's private messages read, never team ones", (await q(`select public.mark_messages_read('${ENG_A}') n`)).rows[0].n === 0);
});

await as(CPA, async () => {
  ok("revoked member loses access at once", (await rows(`select * from public.client_engagements`)).length === 0 && (await rows(`select * from public.messages`)).length === 0);
  ok("revoked member cannot post", await fails(`insert into public.messages (engagement_id, author_id, body, thread) values ('${ENG_A}', '${CPA}', 'x', 'team')`));
});

await as(B, async () => {
  ok("other client cannot see A's team", (await rows(`select * from public.engagement_members`)).length === 0 && (await q(`select public.team_roster('${ENG_A}') r`)).rows[0].r === null);
  ok("other client cannot change A's team", await fails(`select public.set_member_access('90000000-0000-0000-0000-000000000002', true, true, null, 'revoked')`));
  ok("other client cannot see A's team files", (await rows(`select * from public.team_files`)).length === 0);
});

await as(ADMIN, async () => {
  await q(`update public.engagements set status = 'complete' where id = '${ENG_A}'`);
});
await as(LAW, async () => {
  ok("member access ends when the engagement is no longer active", (await rows(`select * from public.client_engagements`)).length === 0);
});
await as(ADMIN, async () => { await q(`update public.engagements set status = 'active' where id = '${ENG_A}'`); });

await asAnon(async () => {
  ok("anon cannot call team functions", await fails(`select public.team_roster('${ENG_A}')`) && await fails(`select public.is_member('${ENG_A}')`));
  ok("anon cannot read team files", await fails(`select * from public.team_files`) || (await q(`select * from public.team_files`)).rows.length === 0);
});

// --- Security hardening: two-step admin sign-in, file types, function privileges ---
await as(ADMIN, async () => {
  ok("admin with an email link only (aal1) is not treated as admin", (await q(`select public.is_admin() a`)).rows[0].a === false);
  ok("aal1 admin sees no engagements", (await q(`select * from public.engagements`)).rows.length === 0);
  ok("aal1 admin sees no inquiries or AI drafts", (await q(`select * from public.inquiries`)).rows.length === 0 && (await q(`select * from public.report_drafts`)).rows.length === 0);
  ok("aal1 admin cannot change engagements", (await q(`update public.engagements set title = 'x' returning id`)).rows.length === 0);
  ok("aal1 admin cannot promote anyone", (await q(`update public.profiles set role = 'admin' where id = '${A}' returning id`)).rows.length === 0);
}, "aal1");
await as(ADMIN, async () => {
  ok("admin with a verified code (aal2) is admin", (await q(`select public.is_admin() a`)).rows[0].a === true);
  ok("aal2 admin reads every engagement", (await q(`select * from public.engagements`)).rows.length === 2);
});
await as(A, async () => {
  ok("a client claiming aal2 is still not admin", (await q(`select public.is_admin() a`)).rows[0].a === false);
}, "aal2");

const mimes = (await rows(`select allowed_mime_types m from storage.buckets where id = 'portal'`))[0].m || [];
ok("file bucket allows PDFs and spreadsheets", mimes.includes("application/pdf") && mimes.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
ok("file bucket blocks scripts and web pages", !mimes.some((m) => /html|javascript|x-sh|octet-stream|svg/.test(m)), mimes.join(","));

const priv = await rows(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth,
  coalesce(array_to_string(p.proconfig, ','), '') cfg from pg_proc p where p.pronamespace = 'public'::regnamespace
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`); // our functions, not extensions'
const fn = (n) => priv.find((r) => r.proname === n) || {};
ok("signed-out visitors cannot call the access helpers",
  ["is_admin", "owns_engagement", "owns_assignment", "questionnaire_assigned_to_me", "assignment_is_open", "submit_assignment"].every((n) => fn(n).anon === false));
ok("signed-in users keep the helpers their access rules need", ["is_admin", "owns_engagement", "owns_assignment"].every((n) => fn(n).auth === true));
ok("trigger functions cannot be called directly by anyone",
  ["handle_new_user", "protect_profile_fields", "touch_answer", "touch_proposal", "log_room_event"].every((n) => fn(n).anon === false && fn(n).auth === false));
ok("proposal links still work for signed-out readers", fn("get_proposal").anon === true && fn("respond_proposal").anon === true);
ok("every function has a fixed search_path", priv.every((r) => /search_path/.test(r.cfg)), priv.filter((r) => !/search_path/.test(r.cfg)).map((r) => r.proname).join(","));
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'new@client.example')`);
ok("new sign-ups still get a profile with the trigger locked down", (await rows(`select count(*)::int c from public.profiles where email = 'new@client.example'`))[0].c === 1);
await as(A, async () => {
  await q(`insert into public.messages (engagement_id, author_id, body) values ('${ENG_A}', '${A}', 'after hardening')`);
  ok("timeline triggers still fire for clients", (await q(`select * from public.messages where body = 'after hardening'`)).rows.length === 1);
});

console.log(results.join("\n"));
const failed = results.some((r) => r.startsWith("FAIL"));
console.log(failed ? "\nSOME TESTS FAILED" : `\nALL ${results.length} TESTS PASSED`);
if (failed) process.exitCode = 1;
