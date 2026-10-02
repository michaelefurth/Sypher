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
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
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

async function as(user, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
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
  await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false);`);
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

console.log(results.join("\n"));
console.log(results.some((r) => r.startsWith("FAIL")) ? "\nSOME TESTS FAILED" : `\nALL ${results.length} TESTS PASSED`);
