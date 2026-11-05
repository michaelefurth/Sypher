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
const rows = async (s) => (await db.query(s).catch((e) => { e.message += ` [in: ${s.slice(0, 140)}]`; throw e; })).rows;

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
const q = (s, p) => db.query(s, p).catch((e) => { e.message += ` [in: ${s.slice(0, 120)}]`; throw e; });
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
  ["handle_new_user", "protect_profile_fields", "touch_answer", "touch_proposal", "log_room_event", "notify_room_event", "notify", "audience"].every((n) => fn(n).anon === false && fn(n).auth === false));
ok("proposal links still work for signed-out readers", fn("get_proposal").anon === true && fn("respond_proposal").anon === true);
ok("every function has a fixed search_path", priv.every((r) => /search_path/.test(r.cfg)), priv.filter((r) => !/search_path/.test(r.cfg)).map((r) => r.proname).join(","));
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'new@client.example')`);
ok("new sign-ups still get a profile with the trigger locked down", (await rows(`select count(*)::int c from public.profiles where email = 'new@client.example'`))[0].c === 1);
await as(A, async () => {
  await q(`insert into public.messages (engagement_id, author_id, body) values ('${ENG_A}', '${A}', 'after hardening')`);
  ok("timeline triggers still fire for clients", (await q(`select * from public.messages where body = 'after hardening'`)).rows.length === 1);
});

// --- Requests, notifications and the schedule of values (20261106000000_action_center) ---
const CT = "00000000-0000-0000-0000-0000000000c4";
await db.exec(`
  insert into auth.users (id, email) values ('${CT}', 'est@ctbuild.example');
  insert into public.engagement_members (id, engagement_id, user_id, email, full_name, role_label, can_message, can_files, status) values
   ('90000000-0000-0000-0000-000000000004', '${ENG_A}', '${CT}', 'est@ctbuild.example', 'Casey Estimator', 'Contractor', true, true, 'active');
  -- Known memberships for this section (earlier tests revoke the CPA and change the attorney's access).
  update public.engagement_members set status = 'active', can_message = true, can_files = true, expires_at = null where id = '90000000-0000-0000-0000-000000000001';
  update public.engagement_members set status = 'active', can_message = false, can_files = true, expires_at = null where id = '90000000-0000-0000-0000-000000000002';
  update public.engagements set status = 'active' where id = '${ENG_A}';
`);
let REQ;
await as(A, async () => {
  REQ = (await rows(`insert into public.action_items (engagement_id, title, kind, assignee_id, created_by) values ('${ENG_A}', 'Send the title commitment', 'document', '${LAW}', '${A}') returning id`))[0].id;
  ok("client can ask a team member for a document", !!REQ);
  ok("client can ask Michael directly", !(await fails(`insert into public.action_items (engagement_id, title, kind, assignee_id, created_by) values ('${ENG_A}', 'Confirm the survey scope', 'answer', '${ADMIN}', '${A}')`)));
  ok("client cannot create a pricing request", await fails(`insert into public.action_items (engagement_id, title, kind, created_by) values ('${ENG_A}', 'Price it', 'pricing', '${A}')`));
  ok("client cannot ask someone outside the engagement", await fails(`insert into public.action_items (engagement_id, title, kind, assignee_id, created_by) values ('${ENG_A}', 'x', 'document', '${B}', '${A}')`));
});
ok("the person asked is notified", (await rows(`select * from public.notifications where user_id = '${LAW}' and title = 'New request: Send the title commitment'`)).length === 1);
await as(CPA, async () => {
  ok("other members don't see a request between two people", !(await rows(`select id from public.action_items`)).some((r) => r.id === REQ));
  ok("a member can't answer someone else's request", await fails(`select public.submit_request('${REQ}', 'here')`));
  ok("a member can't send files into someone else's request", await fails(`insert into storage.objects (bucket_id, name) values ('portal', '${ENG_A}/requests/${REQ}/sneaky.pdf')`));
});
await as(LAW, async () => {
  ok("the person asked sees the request", (await rows(`select id from public.action_items where id = '${REQ}'`)).length === 1);
  ok("they can upload a file into the request", !(await fails(`insert into storage.objects (bucket_id, name) values ('portal', '${ENG_A}/requests/${REQ}/commitment.pdf')`)));
  ok("…and record it on the request", !(await fails(`insert into public.request_files (request_id, engagement_id, path, name) values ('${REQ}', '${ENG_A}', '${ENG_A}/requests/${REQ}/commitment.pdf', 'commitment.pdf')`)));
  ok("a request file must sit in the request's own folder", await fails(`insert into public.request_files (request_id, engagement_id, path, name) values ('${REQ}', '${ENG_A}', '${ENG_A}/team/x.pdf', 'x.pdf')`));
  await q(`select public.submit_request('${REQ}', 'Attached, with all exceptions')`);
  ok("answering a request marks it submitted", (await rows(`select status from public.action_items where id = '${REQ}'`))[0].status === "submitted");
  ok("the person asked can't accept their own answer", await fails(`select public.review_request('${REQ}', true, null)`));
});
ok("whoever asked is told it was answered", (await rows(`select * from public.notifications where user_id = '${A}' and kind = 'request_submitted'`)).length === 1);
await as(CPA, async () => {
  ok("other members can't open the request's files", (await rows(`select * from public.request_files`)).length === 0
    && !(await rows(`select name from storage.objects`)).some((r) => r.name.includes("/requests/")));
});
await as(B, async () => {
  ok("another client can't see the request or its files", (await rows(`select * from public.request_files`)).length === 0 && (await rows(`select * from public.action_items where id = '${REQ}'`)).length === 0);
});
await as(A, async () => {
  ok("the client sees the request's file", (await rows(`select * from public.request_files where request_id = '${REQ}'`)).length === 1);
  ok("sending a request back needs a note", await fails(`select public.review_request('${REQ}', false, '')`));
  await q(`select public.review_request('${REQ}', false, 'Please include the Schedule B exceptions')`);
  ok("changes can be requested", (await rows(`select status from public.action_items where id = '${REQ}'`))[0].status === "changes_requested");
});
await as(LAW, async () => { await q(`select public.submit_request('${REQ}', 'Now with Schedule B')`); });
await as(A, async () => {
  await q(`select public.review_request('${REQ}', true, null)`);
  const r = (await rows(`select status, done_at from public.action_items where id = '${REQ}'`))[0];
  ok("accepting completes the request", r.status === "accepted" && r.done_at !== null);
  const parties = (await rows(`select public.request_parties('${ENG_A}') p`))[0].p;
  ok("the client can list everyone a request can go to", parties.some((x) => x.role === "Sypher Solutions") && parties.some((x) => x.name === "Lee Law"));
});
ok("the person asked hears it was accepted", (await rows(`select * from public.notifications where user_id = '${LAW}' and kind = 'request_accepted'`)).length === 1);
await as(CPA, async () => {
  ok("a member can ask the client for something", !(await fails(`insert into public.action_items (engagement_id, title, kind, created_by) values ('${ENG_A}', 'Sign the engagement letter', 'approval', '${CPA}')`)));
  const parties = (await rows(`select public.request_parties('${ENG_A}') p`))[0].p;
  ok("members see names and roles, never emails", !JSON.stringify(parties).includes("@"));
});

// Notifications go only to people who may see the thing.
await as(A, async () => { await q(`insert into public.messages (engagement_id, author_id, body) values ('${ENG_A}', '${A}', 'Private note to Michael')`); });
ok("a private message notifies Michael", (await rows(`select * from public.notifications where user_id = '${ADMIN}' and body = 'Private note to Michael'`)).length === 1);
ok("…and no team member", (await rows(`select * from public.notifications where body = 'Private note to Michael' and user_id in ('${CPA}', '${LAW}', '${CT}')`)).length === 0);
ok("the author isn't notified of their own message", (await rows(`select * from public.notifications where user_id = '${A}' and body = 'Private note to Michael'`)).length === 0);
await as(CPA, async () => { await q(`insert into public.messages (engagement_id, author_id, body, thread) values ('${ENG_A}', '${CPA}', 'Team update', 'team')`); });
ok("a team message reaches members who can message", (await rows(`select * from public.notifications where body = 'Team update' and user_id = '${CT}'`)).length === 1);
ok("…but not members without messaging", (await rows(`select * from public.notifications where body = 'Team update' and user_id = '${LAW}'`)).length === 0);
await as(LAW, async () => {
  const mine = await rows(`select user_id from public.notifications`);
  ok("people read only their own notifications", mine.length > 0 && mine.every((r) => r.user_id === LAW));
  ok("notifications can't be written directly", await fails(`insert into public.notifications (user_id, kind, title) values ('${A}', 'x', 'spoof')`));
  const n = (await rows(`select public.mark_notifications_read() n`))[0].n;
  ok("marking notifications read", n > 0 && (await rows(`select * from public.notifications where read_at is null`)).length === 0);
});

// Schedule of values.
const SHEET = "a0000000-0000-0000-0000-000000000001", L1 = "a1000000-0000-0000-0000-000000000001", L2 = "a1000000-0000-0000-0000-000000000002", L3 = "a1000000-0000-0000-0000-000000000003";
await as(ADMIN, async () => {
  await q(`insert into public.sov_sheets (id, engagement_id, title, contractor_id) values ('${SHEET}', '${ENG_A}', 'Phase 1 restaurant', '${CT}')`);
  await q(`insert into public.sov_lines (id, sheet_id, engagement_id, position, code, description) values
    ('${L1}', '${SHEET}', '${ENG_A}', 1, '03', 'Concrete'), ('${L2}', '${SHEET}', '${ENG_A}', 2, '09', 'Finishes'), ('${L3}', '${SHEET}', '${ENG_A}', 3, '11', 'Kitchen equipment')`);
  await q(`insert into public.sov_budget (line_id, engagement_id, low, base, high) values ('${L1}', '${ENG_A}', 200000, 236228, 260000)`);
  await q(`insert into public.action_items (engagement_id, title, kind, assignee_id, link_ref) values ('${ENG_A}', 'Price the schedule of values', 'pricing', '${CT}', '${SHEET}')`);
});
await as(CT, async () => {
  ok("the contractor sees their pricing sheet", (await rows(`select * from public.sov_sheets`)).length === 1 && (await rows(`select * from public.sov_lines`)).length === 3);
  ok("the contractor never sees the budget", (await rows(`select * from public.sov_budget`)).length === 0);
  ok("the contractor can't edit lines directly", (await rows(`update public.sov_lines set amount = 1 where id = '${L1}' returning id`)).length === 0);
  const saved = (await rows(`select (public.sov_save_line('${L1}', '{"amount": "240000"}'::jsonb)).amount a`))[0].a;
  ok("autosave stores a price", Number(saved) === 240000);
  const calc = (await rows(`select (public.sov_save_line('${L2}', '{"quantity": "6500", "unit": "SF", "unit_cost": "62.5"}'::jsonb)).amount a`))[0].a;
  ok("quantity times unit cost sets the amount", Number(calc) === 406250);
  ok("the contractor can't rename a line", await fails(`select public.sov_save_line('${L1}', '{"description": "Cheaper concrete"}'::jsonb)`));
  ok("submitting with an unpriced line is refused", await fails(`select public.sov_submit('${SHEET}')`));
  await q(`select public.sov_save_line('${L3}', '{"line_status": "excluded", "note": "Owner-furnished per contract"}'::jsonb)`);
  ok("submitting without a validity date is refused", await fails(`select public.sov_submit('${SHEET}')`));
  await q(`select public.sov_update_sheet('${SHEET}', '{"valid_until": "2027-01-31", "ohp_pct": "6", "building_sf": "6500"}'::jsonb)`);
  const sub = (await rows(`select public.sov_submit('${SHEET}') r`))[0].r;
  ok("submit totals the sheet with overhead and profit", Number(sub.subtotal) === 646250 && Number(sub.total) === 685025);
  ok("a submitted sheet is locked", await fails(`select public.sov_save_line('${L1}', '{"amount": "1"}'::jsonb)`));
});
ok("starting to price notifies the client", (await rows(`select * from public.notifications where user_id = '${A}' and kind = 'pricing' and title like '%started pricing%'`)).length === 1);
ok("submitting notifies the client and Michael", (await rows(`select * from public.notifications where kind = 'pricing' and title like 'Pricing submitted%' and user_id in ('${A}', '${ADMIN}')`)).length === 2);
ok("submitting answers the pricing request", (await rows(`select status from public.action_items where kind = 'pricing'`))[0].status === "submitted");
ok("each submission is kept as a version", (await rows(`select * from public.sov_versions where sheet_id = '${SHEET}'`)).length === 1);
await as(LAW, async () => {
  ok("other team members don't see pricing", (await rows(`select * from public.sov_sheets`)).length === 0 && (await rows(`select * from public.sov_lines`)).length === 0);
  ok("other team members can't price", await fails(`select public.sov_save_line('${L1}', '{"amount": "1"}'::jsonb)`));
});
await as(B, async () => { ok("another client can't see the pricing", (await rows(`select * from public.sov_sheets`)).length === 0); });
await as(A, async () => {
  ok("the client sees the budget beside the price", (await rows(`select * from public.sov_budget`)).length === 1);
  ok("the client can't price lines", await fails(`select public.sov_save_line('${L1}', '{"amount": "1"}'::jsonb)`));
  await q(`select public.sov_line_review('${L2}', 'Does this include the patio?')`);
  await q(`select public.sov_review('${SHEET}', false, 'Break finishes out by room')`);
  ok("the client can send pricing back", (await rows(`select status from public.sov_sheets`))[0].status === "changes_requested");
});
await as(CT, async () => {
  ok("the contractor sees the question on the line", (await rows(`select review_note from public.sov_lines where id = '${L2}'`))[0].review_note === "Does this include the patio?");
  ok("sent-back pricing can be edited again", !(await fails(`select public.sov_save_line('${L2}', '{"note": "Patio included"}'::jsonb)`)));
  await q(`select public.sov_submit('${SHEET}')`);
});
await as(A, async () => { await q(`select public.sov_review('${SHEET}', true, null)`); });
ok("accepting the pricing completes the request", (await rows(`select status from public.action_items where kind = 'pricing'`))[0].status === "accepted"
  && (await rows(`select * from public.sov_versions where sheet_id = '${SHEET}'`)).length === 2);
ok("the contractor hears it was accepted", (await rows(`select * from public.notifications where user_id = '${CT}' and title like 'Pricing accepted%'`)).length === 1);
await asAnon(async () => {
  ok("signed-out visitors can't reach pricing or requests", await fails(`select public.sov_save_line('${L1}', '{"amount": "1"}'::jsonb)`)
    && await fails(`select public.submit_request('${REQ}', 'x')`) && await fails(`select public.mark_notifications_read()`));
});

// --- The project model (20261107000000_project_model) ---
const PM = "b0000000-0000-0000-0000-000000000001", PL = "b1000000-0000-0000-0000-000000000001";
const IN_CF = "b2000000-0000-0000-0000-000000000001", IN_RATE = "b2000000-0000-0000-0000-000000000002";
await db.exec(`update public.engagement_members set status = 'active', can_message = true, can_files = true, expires_at = null where id in ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000002')`);
await as(ADMIN, async () => {
  await q(`insert into public.pm_models (id, engagement_id, title, sov_sheet_id, building_sf) values ('${PM}', '${ENG_A}', 'Phase 1', '${SHEET}', 6500)`);
  await q(`insert into public.pm_lines (id, model_id, engagement_id, grp, label, base, timing) values ('${PL}', '${PM}', '${ENG_A}', 'land', 'Land', 1033000, 'closing')`);
  await q(`insert into public.pm_inputs (id, model_id, engagement_id, key, section, label, unit) values
    ('${IN_CF}', '${PM}', '${ENG_A}', 'existing_cash_flow', 'Existing businesses', 'Normalized cash flow', 'usd'),
    ('${IN_RATE}', '${PM}', '${ENG_A}', 'loan_rate', 'Financing', 'Interest rate', 'pct')`);
});
await as(A, async () => {
  ok("the client sees the project model", (await rows(`select * from public.pm_models`)).length === 1 && (await rows(`select * from public.pm_lines`)).length === 1);
  ok("the client can't change budget lines", (await rows(`update public.pm_lines set base = 1 where id = '${PL}' returning id`)).length === 0);
  ok("the client can't set an assumption they weren't asked to confirm", await fails(`select public.pm_set_input('${IN_RATE}', 9, null, 'confirmed', null)`));
  ok("the client can't give the contractor model access", await fails(`select public.set_member_model('90000000-0000-0000-0000-000000000004', true)`));
  await q(`select public.set_member_model('90000000-0000-0000-0000-000000000001', true)`);
  ok("the client can give their CPA model access", (await rows(`select (public.team_roster('${ENG_A}')->'members') m`))[0].m.some((x) => x.user_id === CPA && x.can_model));
});
await as(LAW, async () => {
  ok("advisers without model access don't see it", (await rows(`select * from public.pm_models`)).length === 0 && (await rows(`select * from public.pm_inputs`)).length === 0);
  ok("advisers without model access don't see the budget", (await rows(`select * from public.sov_budget`)).length === 0);
  ok("advisers without model access can't comment", await fails(`insert into public.pm_comments (model_id, engagement_id, target_kind, author_id, body) values ('${PM}', '${ENG_A}', 'model', '${LAW}', 'hi')`));
});
await as(CT, async () => {
  ok("the contractor never sees the model", (await rows(`select * from public.pm_models`)).length === 0 && (await rows(`select * from public.pm_lines`)).length === 0);
  ok("the contractor still never sees the budget", (await rows(`select * from public.sov_budget`)).length === 0);
});
await as(ADMIN, async () => {
  ok("someone who can see the budget can't be made the contractor", await fails(`update public.sov_sheets set contractor_id = '${CPA}' where id = '${SHEET}'`));
  ok("Michael can't ask someone without model access to confirm", await fails(`select public.pm_ask_input('${IN_CF}', '${LAW}', null)`));
  await q(`select public.pm_ask_input('${IN_CF}', '${CPA}', '2026-12-01')`);
  await q(`select public.pm_set_input('${IN_RATE}', 8.5, null, 'estimate', 'From the lender term sheet')`);
});
ok("asking creates a request for the accountant", (await rows(`select * from public.action_items where link_kind = 'pm_input' and assignee_id = '${CPA}'`)).length === 1);
await as(CPA, async () => {
  ok("the accountant with access sees the model and the budget", (await rows(`select * from public.pm_inputs`)).length === 2 && (await rows(`select * from public.sov_budget`)).length === 1);
  ok("the accountant sees the pricing sheet behind the model", (await rows(`select * from public.sov_lines`)).length === 3);
  ok("the accountant can't change an assumption not assigned to them", await fails(`select public.pm_set_input('${IN_RATE}', 12, null, 'confirmed', null)`));
  const v = (await rows(`select (public.pm_set_input('${IN_CF}', 412000, null, 'estimate', 'From 2025 returns, before owner draws')).value v`))[0].v;
  ok("the accountant sets the assumption they were asked about", Number(v) === 412000);
  ok("the accountant can't edit cost lines", (await rows(`update public.pm_lines set base = 1 returning id`)).length === 0);
  await q(`insert into public.pm_comments (model_id, engagement_id, target_kind, target_id, target_label, author_id, body) values ('${PM}', '${ENG_A}', 'input', '${IN_RATE}', 'Interest rate', '${CPA}', 'SBA 7(a) is variable; use prime + 2.75')`);
  ok("the accountant can comment on any item", (await rows(`select * from public.pm_comments`)).length === 1);
  ok("the accountant sees the change log", (await rows(`select * from public.pm_input_log where input_id = '${IN_CF}'`)).length === 1);
});
ok("the accountant's answer moves their request to review", (await rows(`select status, response from public.action_items where link_kind = 'pm_input'`))[0].status === "submitted"
  && /412,000/.test((await rows(`select response from public.action_items where link_kind = 'pm_input'`))[0].response));
ok("each change is logged with who and why", (await rows(`select * from public.pm_input_log where note like 'From 2025%' and changed_by = '${CPA}'`)).length === 1);
ok("comments alert the client and Michael, not the commenter", (await rows(`select user_id from public.notifications where kind = 'comment'`)).map((r) => r.user_id).sort().join() === [A, ADMIN].sort().join());
ok("model alerts never reach the contractor or advisers without access", (await rows(`select * from public.notifications where kind in ('comment', 'model') and user_id in ('${CT}', '${LAW}')`)).length === 0);
await as(B, async () => { ok("another client can't see the model", (await rows(`select * from public.pm_models`)).length === 0 && (await rows(`select * from public.pm_comments`)).length === 0); });
await asAnon(async () => { ok("signed-out visitors can't reach the model", await fails(`select public.pm_set_input('${IN_CF}', 1, null, 'confirmed', null)`) && await fails(`select * from public.pm_models`)); });

// --- The owner model (20261108000000_owner_model) ---
const OM = "c0000000-0000-0000-0000-000000000001", OE = "c1000000-0000-0000-0000-000000000001", OP = "c2000000-0000-0000-0000-000000000001";
const OF = "c3000000-0000-0000-0000-000000000001", OI_DRAWS = "c4000000-0000-0000-0000-000000000001", OI_FS = "c4000000-0000-0000-0000-000000000002";
await as(ADMIN, async () => {
  await q(`insert into public.om_models (id, engagement_id, title, owner_name, pm_model_id) values ('${OM}', '${ENG_A}', 'Owner model', 'Client A', '${PM}')`);
  await q(`insert into public.om_entities (id, model_id, engagement_id, name, kind) values ('${OE}', '${OM}', '${ENG_A}', 'Trade A', 'smllc')`);
  await q(`insert into public.om_periods (model_id, engagement_id, entity_id, period, revenue, net_income, tax_net) values ('${OM}', '${ENG_A}', '${OE}', '2025', 1000000, 100000, 104000)`);
  await q(`insert into public.om_adjustments (model_id, engagement_id, entity_id, period, kind, label, amount) values ('${OM}', '${ENG_A}', '${OE}', '2025', 'book_tax', 'Meals at 50%', 4000)`);
  await q(`insert into public.om_properties (id, model_id, engagement_id, label, use, used_by_entity_id, rent_source, se_business, cost_basis, land_pct, placed_in_service) values ('${OP}', '${OM}', '${ENG_A}', '1 Main St', 'restaurant', '${OE}', 'self', true, 475000, 20, '2020-07-01')`);
  await q(`insert into public.om_components (model_id, engagement_id, property_id, category, pct) values ('${OM}', '${ENG_A}', '${OP}', 'p5', 27)`);
  await q(`insert into public.om_findings (id, model_id, engagement_id, ref, severity, area, observation) values ('${OF}', '${OM}', '${ENG_A}', 'F01', 'critical', 'Books', 'Book net differs from the return')`);
  await q(`insert into public.om_inputs (id, model_id, engagement_id, key, section, label, unit) values
    ('${OI_DRAWS}', '${OM}', '${ENG_A}', 'living_draws', 'Owner', 'Living draws', 'usd'),
    ('${OI_FS}', '${OM}', '${ENG_A}', 'filing_status', 'Taxes', 'Filing status', 'text')`);
  ok("a component must use a known recovery class", await fails(`insert into public.om_components (model_id, engagement_id, property_id, category, pct) values ('${OM}', '${ENG_A}', '${OP}', 'p9', 1)`));
  ok("a period is unique per entity", await fails(`insert into public.om_periods (model_id, engagement_id, entity_id, period) values ('${OM}', '${ENG_A}', '${OE}', '2025')`));
});
await as(A, async () => {
  ok("the client sees the owner model, its books, properties and findings", (await rows(`select * from public.om_models`)).length === 1 && (await rows(`select * from public.om_periods`)).length === 1
    && (await rows(`select * from public.om_properties`)).length === 1 && (await rows(`select * from public.om_components`)).length === 1 && (await rows(`select * from public.om_findings`)).length === 1);
  ok("the client can't change the books, properties or findings", (await rows(`update public.om_periods set net_income = 1 returning id`)).length === 0
    && (await rows(`update public.om_properties set cost_basis = 1 returning id`)).length === 0 && (await rows(`update public.om_findings set status = 'resolved' returning id`)).length === 0);
  ok("the client can't set an owner-model assumption they weren't asked to confirm", await fails(`select public.om_set_input('${OI_DRAWS}', 1, null, 'confirmed', null)`));
  await q(`insert into public.om_comments (model_id, engagement_id, target_kind, target_id, target_label, author_id, body) values ('${OM}', '${ENG_A}', 'finding', '${OF}', 'F01', '${A}', 'The bookkeeper has the ledger')`);
  ok("the client can comment on a finding", (await rows(`select * from public.om_comments`)).length === 1);
  await q(`insert into public.om_snapshots (model_id, engagement_id, label, data, created_by) values ('${OM}', '${ENG_A}', 'Nov', '{}', '${A}')`);
  ok("the client can save a version", (await rows(`select * from public.om_snapshots`)).length === 1);
});
await as(LAW, async () => {
  ok("advisers without model access don't see the owner model", (await rows(`select * from public.om_models`)).length === 0 && (await rows(`select * from public.om_properties`)).length === 0 && (await rows(`select * from public.om_findings`)).length === 0);
  ok("advisers without model access can't comment on it", await fails(`insert into public.om_comments (model_id, engagement_id, target_kind, author_id, body) values ('${OM}', '${ENG_A}', 'model', '${LAW}', 'hi')`));
});
await as(CT, async () => {
  ok("the contractor never sees the owner model", (await rows(`select * from public.om_models`)).length === 0 && (await rows(`select * from public.om_periods`)).length === 0 && (await rows(`select * from public.om_inputs`)).length === 0);
});
await as(ADMIN, async () => {
  ok("Michael can't ask someone without model access to confirm an owner-model item", await fails(`select public.om_ask_input('${OI_DRAWS}', '${LAW}', null)`));
  await q(`select public.om_ask_input('${OI_DRAWS}', '${CPA}', '2026-12-01')`);
  await q(`select public.om_ask_finding('${OF}', '${CPA}', null)`);
  ok("a text assumption rejects long values", await fails(`select public.om_set_input('${OI_FS}', null, repeat('x', 81), 'confirmed', null)`));
  await q(`select public.om_set_input('${OI_FS}', null, 'single', 'confirmed', 'From the 2025 return')`);
});
ok("asking creates requests for the accountant", (await rows(`select * from public.action_items where link_kind in ('om_input', 'om_finding') and assignee_id = '${CPA}'`)).length === 2);
ok("assigning a finding moves it to in progress", (await rows(`select status, owner_id from public.om_findings`))[0].status === "in_progress");
await as(CPA, async () => {
  ok("the accountant with access sees the owner model", (await rows(`select * from public.om_inputs`)).length === 2 && (await rows(`select * from public.om_adjustments`)).length === 1);
  ok("the accountant can't change an assumption not assigned to them", await fails(`select public.om_set_input('${OI_FS}', null, 'mfj', 'confirmed', null)`));
  const v = (await rows(`select (public.om_set_input('${OI_DRAWS}', 90000, null, 'estimate', 'From the owner')).value v`))[0].v;
  ok("the accountant sets the owner-model assumption they were asked about", Number(v) === 90000);
  ok("the accountant can't edit the books or findings", (await rows(`update public.om_periods set net_income = 1 returning id`)).length === 0 && (await rows(`update public.om_findings set status = 'resolved' returning id`)).length === 0);
  ok("the accountant sees the owner-model change log", (await rows(`select * from public.om_input_log where input_id = '${OI_DRAWS}'`)).length === 1);
});
ok("the accountant's owner-model answer moves their request to review", (await rows(`select status from public.action_items where link_kind = 'om_input'`))[0].status === "submitted");
ok("the client's owner-model comment alerts Michael and the accountant with access, nobody else", (await rows(`select user_id from public.notifications where kind = 'comment' and link = 'owner'`)).map((r) => r.user_id).sort().join() === [ADMIN, CPA].sort().join());
// --- Personal items (20261109000000_owner_personal) ---
await as(ADMIN, async () => {
  await q(`insert into public.om_personal (model_id, engagement_id, category, label, amount, liability, status) values ('${OM}', '${ENG_A}', 'agreement', 'Partition agreement', null, null, 'needed')`);
  ok("a personal item must use a known category", await fails(`insert into public.om_personal (model_id, engagement_id, category, label) values ('${OM}', '${ENG_A}', 'horses', 'x')`));
});
await as(A, async () => {
  ok("the client sees the owner's personal items", (await rows(`select * from public.om_personal`)).length === 1);
  ok("the client can't change them", (await rows(`update public.om_personal set status = 'resolved' returning id`)).length === 0);
});
await as(CPA, async () => { ok("the accountant with access sees the personal items", (await rows(`select * from public.om_personal`)).length === 1); });
await as(LAW, async () => { ok("advisers without model access don't see the personal items", (await rows(`select * from public.om_personal`)).length === 0); });
await as(CT, async () => { ok("the contractor never sees the personal items", (await rows(`select * from public.om_personal`)).length === 0); });
await as(B, async () => { ok("another client can't see the owner model", (await rows(`select * from public.om_models`)).length === 0 && (await rows(`select * from public.om_comments`)).length === 0 && (await rows(`select * from public.om_personal`)).length === 0); });
await asAnon(async () => { ok("signed-out visitors can't reach the owner model", await fails(`select public.om_set_input('${OI_DRAWS}', 1, null, 'confirmed', null)`) && await fails(`select * from public.om_models`)); });

// --- Billing with Stripe (20261110000000_billing) ---
await as(ADMIN, async () => {
  await q(`insert into public.billing_profiles (client_id, stripe_customer_id, billing_name, line1, city, state, postal_code) values ('${A}', 'cus_test_a', 'Client A LLC', '1 Main St', 'El Paso', 'TX', '79901')`);
  await q(`insert into public.invoices (engagement_id, client_id, stripe_invoice_id, kind, description, status, total, tax) values ('${ENG_A}', '${A}', 'in_test_open', 'deposit', 'Deposit', 'open', 541250, 41250), ('${ENG_A}', '${A}', 'in_test_draft', 'milestone', 'Milestone 2', 'draft', 100000, 0), ('${ENG_B}', '${B}', 'in_test_b', 'one_off', 'B fee', 'open', 5000, 0)`);
  ok("an invoice kind must be a known one", await fails(`insert into public.invoices (engagement_id, stripe_invoice_id, kind) values ('${ENG_A}', 'in_bad', 'gift')`));
  ok("an invoice status must be a Stripe status", await fails(`insert into public.invoices (engagement_id, stripe_invoice_id, status) values ('${ENG_A}', 'in_bad2', 'pending')`));
  ok("a Stripe invoice is mirrored once", await fails(`insert into public.invoices (engagement_id, stripe_invoice_id) values ('${ENG_A}', 'in_test_open')`));
  ok("Michael sees every invoice, drafts included", (await rows(`select * from public.invoices`)).length === 3);
  ok("Michael can't read or write the processed webhook events (server only)", (await rows(`select * from public.stripe_events`)).length === 0 && await fails(`insert into public.stripe_events (id, type) values ('evt_x', 'invoice.paid')`));
});
await as(A, async () => {
  const inv = await rows(`select stripe_invoice_id from public.invoices`);
  ok("the client sees their engagement's sent invoices, not drafts or other clients'", inv.length === 1 && inv[0].stripe_invoice_id === "in_test_open");
  ok("the client sees their own billing profile", (await rows(`select * from public.billing_profiles`)).length === 1);
  ok("the client can't create, change or delete invoices", await fails(`insert into public.invoices (engagement_id, stripe_invoice_id) values ('${ENG_A}', 'in_forged')`) && (await rows(`update public.invoices set status = 'paid' returning id`)).length === 0 && (await rows(`delete from public.invoices returning id`)).length === 0);
  ok("the client can't write their billing profile or Stripe customer id directly", (await rows(`update public.billing_profiles set stripe_customer_id = 'cus_forged' returning client_id`)).length === 0 && await fails(`insert into public.billing_profiles (client_id) values ('${B}')`));
  ok("the client can't read processed webhook events", (await rows(`select * from public.stripe_events`)).length === 0);
});
await as(B, async () => {
  const inv = await rows(`select stripe_invoice_id from public.invoices`);
  ok("another client sees only their own invoices and no one else's billing profile", inv.length === 1 && inv[0].stripe_invoice_id === "in_test_b" && (await rows(`select * from public.billing_profiles`)).length === 0);
});
await as(CPA, async () => { ok("an accountant on the team never sees billing", (await rows(`select * from public.invoices`)).length === 0 && (await rows(`select * from public.billing_profiles`)).length === 0); });
await as(CT, async () => { ok("the contractor never sees billing", (await rows(`select * from public.invoices`)).length === 0 && (await rows(`select * from public.billing_profiles`)).length === 0); });
await asAnon(async () => { ok("signed-out visitors can't reach billing", await fails(`select * from public.invoices`) || (await rows(`select * from public.invoices`)).length === 0); });

// --- Review inbox for documents an assistant files (20261111000000_review_inbox) ---
ok("the inbox bucket exists, private, with the portal's file types", (await rows(`select 1 from storage.buckets where id = 'inbox' and not public and allowed_mime_types = (select allowed_mime_types from storage.buckets where id = 'portal')`)).length === 1);
await as(ADMIN, async () => {
  await q(`insert into public.inbox_documents (engagement_id, title, path, name) values ('${ENG_A}', 'Forensic review', '${ENG_A}/11111111-1111-1111-1111-111111111111-review.pdf', 'review.pdf')`);
  await q(`insert into storage.objects (bucket_id, name) values ('inbox', '${ENG_A}/11111111-1111-1111-1111-111111111111-review.pdf')`);
  ok("Michael sees what's waiting and its file", (await rows(`select * from public.inbox_documents`)).length === 1 && (await rows(`select * from storage.objects where bucket_id = 'inbox'`)).length === 1);
  ok("a waiting document belongs to an engagement", await fails(`insert into public.inbox_documents (title, path, name) values ('x', 'p', 'n')`));
});
await as(A, async () => {
  ok("the client can't see documents waiting for review, even in their own engagement", (await rows(`select * from public.inbox_documents`)).length === 0);
  ok("the client can't open or list waiting files in storage", (await rows(`select * from storage.objects where bucket_id = 'inbox'`)).length === 0);
  ok("the client can't put files in the inbox", await fails(`insert into storage.objects (bucket_id, name) values ('inbox', '${ENG_A}/22222222-2222-2222-2222-222222222222-x.pdf')`));
  ok("the client can't file or clear waiting documents", await fails(`insert into public.inbox_documents (engagement_id, title, path, name) values ('${ENG_A}', 'x', 'p2', 'n')`) && (await rows(`delete from public.inbox_documents returning id`)).length === 0);
});
await as(CPA, async () => { ok("an accountant on the team can't see waiting documents or files", (await rows(`select * from public.inbox_documents`)).length === 0 && (await rows(`select * from storage.objects where bucket_id = 'inbox'`)).length === 0); });
await as(ADMIN, async () => { ok("an admin session without a verified code sees nothing waiting", (await rows(`select * from public.inbox_documents`)).length === 0 && (await rows(`select * from storage.objects where bucket_id = 'inbox'`)).length === 0); }, "aal1");
await asAnon(async () => { ok("signed-out visitors can't reach the inbox", await fails(`select * from public.inbox_documents`) || (await rows(`select * from public.inbox_documents`)).length === 0); });

console.log(results.join("\n"));
const failed = results.some((r) => r.startsWith("FAIL"));
console.log(failed ? "\nSOME TESTS FAILED" : `\nALL ${results.length} TESTS PASSED`);
if (failed) process.exitCode = 1;
