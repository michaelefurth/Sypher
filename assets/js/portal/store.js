// Client Portal data layer.
// One API, two back ends:
//   - Supabase (live): auth by magic link, Postgres with row level security,
//     private file storage, and edge functions for invites, AI drafts and publishing.
//   - Demo: fictional data kept in this browser's localStorage, so the portal
//     can be explored before Supabase is connected.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { demoSeed, demoDraft, demoBrief, DEMO_IDS, DEFAULT_TERMS } from "./demo-data.js";

export const isDemo = !(SUPABASE_URL && SUPABASE_ANON_KEY);
export { DEFAULT_TERMS };

/** The private link a client opens to read a proposal. */
export function proposalLink(p, base = location.href) {
  return `${siteRoot(base)}for/?p=${encodeURIComponent((p.slug ? `${p.slug}.` : "") + p.token)}`;
}
// The site may be served from a sub-path (previews); resolve /for/ relative to the site root.
function siteRoot(base) {
  const u = new URL(base);
  const i = u.pathname.search(/\/(portal|for)\//);
  return u.origin + (i >= 0 ? u.pathname.slice(0, i + 1) : "/");
}
export function slugify(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\(sample\)/g, "")
    .replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 3).join("-");
}
/** Token from a /for/?p=<slug>.<token> link. */
export function tokenFromParam(param) {
  const v = String(param || "");
  return v.includes(".") ? v.slice(v.lastIndexOf(".") + 1) : v;
}

/* ------------------------------------------------------------------------ */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------ */
function progressOf(questions, answers) {
  const byQ = new Map(answers.map((a) => [a.question_id, a]));
  let answered = 0, unknown = 0;
  for (const q of questions) {
    const a = byQ.get(q.id);
    if (!a) continue;
    if (a.state === "unknown") unknown++;
    else if ((a.value || "").trim()) answered++;
  }
  return { total: questions.length, answered, unknown, open: questions.length - answered - unknown };
}

/** Validate an imported questionnaire template (see docs/client-portal.md). */
export function validateTemplate(t) {
  if (!t || typeof t !== "object") throw new Error("The file is not a questionnaire template.");
  if (!t.title || typeof t.title !== "string") throw new Error("The template needs a title.");
  if (!Array.isArray(t.questions) || !t.questions.length) throw new Error("The template needs at least one question.");
  const types = ["long_text", "short_text", "number", "currency", "date", "yes_no"];
  return {
    title: t.title.trim(),
    description: t.description || null,
    intro: t.intro || null,
    questions: t.questions.map((q, i) => {
      if (!q.prompt) throw new Error(`Question ${i + 1} has no prompt.`);
      return {
        position: i + 1,
        number: q.number != null ? String(q.number) : String(i + 1),
        section_code: q.section_code || null,
        section_title: q.section_title || null,
        prompt: String(q.prompt),
        why: q.why || null,
        priority: q.priority === "rerun" || q.priority === "critical" ? q.priority : null,
        answer_type: types.includes(q.answer_type) ? q.answer_type : "long_text",
        required: !!q.required,
      };
    }),
  };
}

/* ------------------------------------------------------------------------ */
/* Demo back end                                                             */
/* ------------------------------------------------------------------------ */
const DEMO_KEY = "sypher-portal-demo-v2";
const SESSION_KEY = "sypher-portal-demo-session";

// The demo's simulated "AI pass" completes any draft older than a few seconds,
// whichever page happens to read the data next.
function settleDemoDrafts(db) {
  let changed = false;
  for (const dr of db.report_drafts) {
    if (dr.status !== "drafting" || Date.now() - new Date(dr.created_at).getTime() < 2500) continue;
    const a = db.assignments.find((x) => x.id === dr.assignment_id);
    const qs = db.questions.filter((q) => q.questionnaire_id === a.questionnaire_id).sort((x, y) => x.position - y.position);
    dr.draft = demoDraft(qs, db.answers.filter((x) => x.assignment_id === a.id));
    dr.status = "awaiting_review"; dr.model = "demo (sample output)";
    db.activity.push({ id: uid(), engagement_id: a.engagement_id, kind: "draft_ready", detail: { draft_id: dr.id }, created_at: now() });
    changed = true;
  }
  for (const inq of db.inquiries || []) {
    if (inq.brief_status !== "pending" || Date.now() - new Date(inq.created_at).getTime() < 2500) continue;
    inq.brief = demoBrief(inq); inq.brief_status = "ready"; inq.brief_model = "demo (sample output)";
    changed = true;
  }
  if (changed) demoSave(db);
  return db;
}

function demoLoad() {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) return settleDemoDrafts(JSON.parse(raw));
  } catch (_) { /* storage unavailable: fall through to a fresh seed */ }
  const seed = demoSeed();
  demoSave(seed);
  return seed;
}
function demoSave(db) {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(db)); } catch (_) { /* best effort */ }
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const now = () => new Date().toISOString();

/** What a client may see of a proposal (mirrors public.proposal_public in SQL). */
function publicProposal(p) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    title: p.title, client_name: p.client_name, company: p.company, content: p.content, status: p.status,
    valid_until: p.valid_until, sent_at: p.sent_at || p.created_at,
    expired: !!p.valid_until && p.valid_until < today && ["sent", "viewed"].includes(p.status),
    responded_at: p.responded_at, accepted_option: p.accepted_option, signer_name: p.signer_name, signer_title: p.signer_title,
  };
}

let memorySession = null;
function demoSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || memorySession; } catch (_) { return memorySession; }
}

const demo = {
  async session() {
    const s = demoSession();
    if (!s) return null;
    const db = demoLoad();
    const profile = db.profiles.find((p) => p.id === s.userId);
    return profile ? { user: { id: profile.id, email: profile.email }, profile } : null;
  },
  async signIn(role) {
    memorySession = { userId: role === "admin" ? DEMO_IDS.ADMIN_ID : DEMO_IDS.CLIENT_ID };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(memorySession)); } catch (_) { /* ignore */ }
    return this.session();
  },
  async signOut() {
    memorySession = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
  },
  async resetDemo() {
    try { localStorage.removeItem(DEMO_KEY); } catch (_) { /* ignore */ }
  },

  // ---- client ----
  async myEngagements() {
    const s = await this.session();
    const db = demoLoad();
    return db.engagements.filter((e) => e.client_id === s.user.id).map(({ report_context, ...e }) => e);
  },
  async assignmentsFor(engagementId) {
    const db = demoLoad();
    return db.assignments.filter((a) => a.engagement_id === engagementId).map((a) => {
      const q = db.questionnaires.find((x) => x.id === a.questionnaire_id);
      const qs = db.questions.filter((x) => x.questionnaire_id === a.questionnaire_id);
      return { ...a, questionnaire: q, progress: progressOf(qs, db.answers.filter((x) => x.assignment_id === a.id)) };
    });
  },
  async assignment(id) {
    const db = demoLoad();
    const a = db.assignments.find((x) => x.id === id);
    if (!a) throw new Error("Questionnaire not found.");
    const engagement = db.engagements.find((e) => e.id === a.engagement_id);
    return {
      assignment: a,
      engagement,
      questionnaire: db.questionnaires.find((x) => x.id === a.questionnaire_id),
      questions: db.questions.filter((x) => x.questionnaire_id === a.questionnaire_id).sort((x, y) => x.position - y.position),
      answers: db.answers.filter((x) => x.assignment_id === id),
      files: db.files.filter((x) => x.assignment_id === id),
    };
  },
  async saveAnswer(assignmentId, questionId, fields) {
    const db = demoLoad();
    const a = db.assignments.find((x) => x.id === assignmentId);
    if (!a || !["open", "reopened"].includes(a.status)) throw new Error("This questionnaire is locked.");
    let row = db.answers.find((x) => x.assignment_id === assignmentId && x.question_id === questionId);
    if (!row) { row = { id: uid(), assignment_id: assignmentId, question_id: questionId }; db.answers.push(row); }
    Object.assign(row, fields, { updated_at: now() });
    demoSave(db);
    return row;
  },
  async uploadFile(engagementId, assignmentId, questionId, file) {
    const db = demoLoad();
    const row = { id: uid(), engagement_id: engagementId, assignment_id: assignmentId, question_id: questionId, path: `demo/${uid()}`, name: file.name, size: file.size, created_at: now(), demo: true };
    db.files.push(row);
    demoSave(db);
    return row;
  },
  async fileUrl() { return null; },
  async engagementFiles(engagementId) {
    return demoLoad().files.filter((f) => f.engagement_id === engagementId);
  },
  async submit(assignmentId) {
    const db = demoLoad();
    const a = db.assignments.find((x) => x.id === assignmentId);
    a.status = "submitted"; a.submitted_at = now();
    db.activity.push({ id: uid(), engagement_id: a.engagement_id, kind: "assignment_submitted", detail: { assignment_id: a.id }, created_at: now() });
    const draftId = uid();
    db.report_drafts.push({ id: draftId, engagement_id: a.engagement_id, assignment_id: a.id, status: "drafting", draft: null, model: null, created_at: now() });
    demoSave(db); // settleDemoDrafts() completes the simulated AI pass on a later read
  },
  async publications(engagementId) {
    return demoLoad().publications.filter((p) => p.engagement_id === engagementId).sort((a, b) => b.published_at.localeCompare(a.published_at));
  },

  // ---- admin ----
  async clients() {
    const db = demoLoad();
    return db.profiles.filter((p) => p.role === "client").map((p) => ({
      ...p, engagements: db.engagements.filter((e) => e.client_id === p.id),
    }));
  },
  async engagement(id) {
    const db = demoLoad();
    const e = db.engagements.find((x) => x.id === id);
    if (!e) throw new Error("Engagement not found.");
    return { ...e, client: db.profiles.find((p) => p.id === e.client_id) };
  },
  async updateEngagement(id, fields) {
    const db = demoLoad();
    Object.assign(db.engagements.find((x) => x.id === id), fields);
    demoSave(db);
  },
  async inviteClient({ email, full_name, company, engagement_title, engagement_summary }) {
    const db = demoLoad();
    let p = db.profiles.find((x) => x.email === email.toLowerCase());
    if (!p) { p = { id: uid(), email: email.toLowerCase(), full_name, company, role: "client", created_at: now() }; db.profiles.push(p); }
    const e = { id: uid(), client_id: p.id, title: engagement_title, summary: engagement_summary || null, report_context: null, status: "active", created_at: now() };
    db.engagements.push(e);
    db.activity.push({ id: uid(), engagement_id: e.id, kind: "client_invited", detail: { email }, created_at: now() });
    demoSave(db);
    return { engagement_id: e.id, invited: true };
  },
  async questionnaires() {
    const db = demoLoad();
    return db.questionnaires.map((q) => ({ ...q, count: db.questions.filter((x) => x.questionnaire_id === q.id).length }));
  },
  async questionnaireWithQuestions(id) {
    const db = demoLoad();
    return { ...db.questionnaires.find((q) => q.id === id), questions: db.questions.filter((x) => x.questionnaire_id === id).sort((a, b) => a.position - b.position) };
  },
  async importQuestionnaire(template) {
    const t = validateTemplate(template);
    const db = demoLoad();
    const id = uid();
    db.questionnaires.push({ id, title: t.title, description: t.description, intro: t.intro, created_at: now() });
    t.questions.forEach((q) => db.questions.push({ ...q, id: uid(), questionnaire_id: id }));
    demoSave(db);
    return id;
  },
  async assign(engagementId, questionnaireId, dueDate, message) {
    const db = demoLoad();
    const a = { id: uid(), engagement_id: engagementId, questionnaire_id: questionnaireId, status: "open", due_date: dueDate || null, message: message || null, submitted_at: null, created_at: now() };
    db.assignments.push(a);
    db.activity.push({ id: uid(), engagement_id: engagementId, kind: "assignment_created", detail: { assignment_id: a.id }, created_at: now() });
    demoSave(db);
    return a.id;
  },
  async setAssignmentStatus(id, status) {
    const db = demoLoad();
    db.assignments.find((x) => x.id === id).status = status;
    demoSave(db);
  },
  async drafts(engagementId) {
    const db = demoLoad();
    return db.report_drafts.filter((d) => !engagementId || d.engagement_id === engagementId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async draft(id) {
    const db = demoLoad();
    const d = db.report_drafts.find((x) => x.id === id);
    if (!d) throw new Error("Draft not found.");
    return { ...d, engagement: db.engagements.find((e) => e.id === d.engagement_id) };
  },
  async regenerateDraft(assignmentId) {
    const db = demoLoad();
    const a = db.assignments.find((x) => x.id === assignmentId);
    const qs = db.questions.filter((q) => q.questionnaire_id === a.questionnaire_id).sort((x, y) => x.position - y.position);
    const d = { id: uid(), engagement_id: a.engagement_id, assignment_id: a.id, status: "awaiting_review", model: "demo (sample output)", created_at: now(), draft: demoDraft(qs, db.answers.filter((x) => x.assignment_id === a.id)) };
    db.report_drafts.push(d);
    demoSave(db);
    return d.id;
  },
  async dismissDraft(id) {
    const db = demoLoad();
    db.report_drafts.find((x) => x.id === id).status = "dismissed";
    demoSave(db);
  },
  async publish({ engagement_id, title, body, draft_id }) {
    const db = demoLoad();
    db.publications.push({ id: uid(), engagement_id, title, body, draft_id: draft_id || null, published_at: now() });
    if (draft_id) { const d = db.report_drafts.find((x) => x.id === draft_id); if (d) { d.status = "published"; d.reviewed_at = now(); } }
    db.activity.push({ id: uid(), engagement_id, kind: "update_published", detail: { title }, created_at: now() });
    demoSave(db);
  },
  // ---- diagnostic (public) ----
  async submitInquiry(payload) {
    const db = demoLoad();
    const row = {
      id: uid(), created_at: now(), name: payload.name, email: payload.email, company: payload.company || null,
      role: payload.role || null, phone: payload.phone || null, practices: payload.practices, answers: payload.answers,
      status: "new", brief: null, brief_status: "pending", brief_model: null, brief_error: null, admin_notes: null,
    };
    db.inquiries.unshift(row);
    db.activity.push({ id: uid(), engagement_id: null, kind: "inquiry_received", detail: { inquiry_id: row.id }, created_at: now() });
    demoSave(db);
    return { ok: true, id: row.id, demo: true };
  },
  async inquiries() { return demoLoad().inquiries.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)); },
  async inquiry(id) {
    const db = demoLoad();
    const i = db.inquiries.find((x) => x.id === id);
    if (!i) throw new Error("Inquiry not found.");
    return { ...i, proposals: db.proposals.filter((p) => p.inquiry_id === id) };
  },
  async updateInquiry(id, fields) {
    const db = demoLoad();
    Object.assign(db.inquiries.find((x) => x.id === id), fields);
    demoSave(db);
  },

  // ---- proposals ----
  async proposals() { return demoLoad().proposals.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)); },
  async proposal(id) {
    const p = demoLoad().proposals.find((x) => x.id === id);
    if (!p) throw new Error("Proposal not found.");
    return p;
  },
  async createProposal(fields) {
    const db = demoLoad();
    const p = {
      id: uid(), created_at: now(), updated_at: now(), token: (uid() + uid()).replace(/-/g, "").slice(0, 40), status: "draft",
      title: "", client_name: null, client_email: null, company: null, slug: null, content: {}, valid_until: null,
      inquiry_id: null, engagement_id: null, sent_at: null, first_viewed_at: null, last_viewed_at: null, view_count: 0,
      responded_at: null, accepted_option: null, signer_name: null, signer_title: null, signer_email: null, decline_reason: null,
      ...fields,
    };
    db.proposals.unshift(p);
    demoSave(db);
    return p.id;
  },
  async updateProposal(id, fields) {
    const db = demoLoad();
    Object.assign(db.proposals.find((x) => x.id === id), fields, { updated_at: now() });
    demoSave(db);
  },
  async proposalByToken(token) {
    const db = demoLoad();
    const p = db.proposals.find((x) => x.token === token);
    if (!p) return null;
    const admin = demoSession()?.userId === DEMO_IDS.ADMIN_ID;
    if (["draft", "withdrawn"].includes(p.status) && !admin) return null;
    if (!admin) {
      if (p.status === "sent") p.status = "viewed";
      p.first_viewed_at = p.first_viewed_at || now(); p.last_viewed_at = now(); p.view_count += 1;
      demoSave(db);
    }
    return publicProposal(p);
  },
  async respondProposal(token, action, f = {}) {
    const db = demoLoad();
    const p = db.proposals.find((x) => x.token === token);
    if (!p || !["sent", "viewed"].includes(p.status)) throw new Error("This proposal is not open for a response.");
    if (p.valid_until && p.valid_until < new Date().toISOString().slice(0, 10)) throw new Error("This proposal has expired. Please contact Michael for an updated one.");
    if (action === "accept") {
      if ((f.name || "").trim().length < 2) throw new Error("Please type your full name to sign.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email || "")) throw new Error("Please enter a valid email.");
      if (!(p.content.options || []).some((o) => o.id === f.option)) throw new Error("Please choose one of the options.");
      Object.assign(p, { status: "accepted", responded_at: now(), accepted_option: f.option, signer_name: f.name.trim(), signer_title: (f.title || "").trim(), signer_email: f.email.trim().toLowerCase() });
    } else {
      Object.assign(p, { status: "declined", responded_at: now(), decline_reason: f.reason || null });
    }
    db.activity.push({ id: uid(), engagement_id: p.engagement_id, kind: `proposal_${p.status}`, detail: { proposal_id: p.id, title: p.title }, created_at: now() });
    demoSave(db);
    return publicProposal(p);
  },

  // ---- client room ----
  async milestones(engagementId) {
    return demoLoad().milestones.filter((m) => m.engagement_id === engagementId).sort((a, b) => a.position - b.position);
  },
  async saveMilestone(row) {
    const db = demoLoad();
    if (row.id) Object.assign(db.milestones.find((m) => m.id === row.id), row);
    else db.milestones.push({ status: "upcoming", note: null, due_label: null, due_date: null, created_at: now(), ...row, id: uid() });
    demoSave(db);
  },
  async deleteMilestone(id) {
    const db = demoLoad();
    db.milestones = db.milestones.filter((m) => m.id !== id);
    demoSave(db);
  },
  async decisions(engagementId) {
    return demoLoad().decisions.filter((d) => d.engagement_id === engagementId).sort((a, b) => b.decided_on.localeCompare(a.decided_on));
  },
  async addDecision(row) {
    const db = demoLoad();
    db.decisions.push({ id: uid(), created_at: now(), decided_on: new Date().toISOString().slice(0, 10), rationale: null, owner: null, ...row });
    demoSave(db);
  },
  async deleteDecision(id) {
    const db = demoLoad();
    db.decisions = db.decisions.filter((d) => d.id !== id);
    demoSave(db);
  },

  async activity(engagementId) {
    const db = demoLoad();
    return db.activity.filter((a) => !engagementId || a.engagement_id === engagementId).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 40);
  },
};

/* ------------------------------------------------------------------------ */
/* Supabase back end                                                         */
/* ------------------------------------------------------------------------ */
let sbPromise = null;
function sb() {
  if (!sbPromise) {
    sbPromise = new Promise((resolve, reject) => {
      const make = () => resolve(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      }));
      if (window.supabase) return make();
      const s = document.createElement("script");
      s.src = new URL("../../vendor/supabase.min.js", import.meta.url).href;
      s.onload = make;
      s.onerror = () => reject(new Error("Could not load the Supabase client."));
      document.head.appendChild(s);
    });
  }
  return sbPromise;
}
function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}
async function invoke(name, body) {
  const client = await sb();
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    try { const ctx = await error.context?.json(); if (ctx?.error) message = ctx.error; } catch (_) { /* keep default */ }
    throw new Error(message);
  }
  return data;
}

const live = {
  async session() {
    const client = await sb();
    const { data } = await client.auth.getSession();
    if (!data.session) return null;
    const user = data.session.user;
    const profile = check(await client.from("profiles").select("*").eq("id", user.id).single());
    return { user: { id: user.id, email: user.email }, profile };
  },
  async sendMagicLink(email, next) {
    const client = await sb();
    check(await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: new URL(next || "dashboard.html", location.href).href },
    }));
  },
  async signOut() { const client = await sb(); await client.auth.signOut(); },

  // ---- client ----
  async myEngagements() {
    const client = await sb();
    return check(await client.from("client_engagements").select("*").order("created_at", { ascending: false }));
  },
  async assignmentsFor(engagementId) {
    const client = await sb();
    const rows = check(await client.from("assignments").select("*, questionnaire:questionnaires(id, title, description)").eq("engagement_id", engagementId).order("created_at", { ascending: false }));
    return Promise.all(rows.map(async (a) => {
      const qs = check(await client.from("questions").select("id").eq("questionnaire_id", a.questionnaire_id));
      const ans = check(await client.from("answers").select("question_id, value, state").eq("assignment_id", a.id));
      return { ...a, progress: progressOf(qs, ans) };
    }));
  },
  async assignment(id) {
    const client = await sb();
    const a = check(await client.from("assignments").select("*").eq("id", id).single());
    const [engagement, questionnaire, questions, answers, files] = await Promise.all([
      client.from("client_engagements").select("*").eq("id", a.engagement_id).single().then(check),
      client.from("questionnaires").select("*").eq("id", a.questionnaire_id).single().then(check),
      client.from("questions").select("*").eq("questionnaire_id", a.questionnaire_id).order("position").then(check),
      client.from("answers").select("*").eq("assignment_id", id).then(check),
      client.from("files").select("*").eq("assignment_id", id).order("created_at").then(check),
    ]);
    return { assignment: a, engagement, questionnaire, questions, answers, files };
  },
  async saveAnswer(assignmentId, questionId, fields) {
    const client = await sb();
    return check(await client.from("answers").upsert(
      { assignment_id: assignmentId, question_id: questionId, ...fields },
      { onConflict: "assignment_id,question_id" },
    ).select().single());
  },
  async uploadFile(engagementId, assignmentId, questionId, file) {
    const client = await sb();
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-120);
    const path = `${engagementId}/${crypto.randomUUID()}-${safe}`;
    check(await client.storage.from("portal").upload(path, file, { upsert: false }));
    return check(await client.from("files").insert({ engagement_id: engagementId, assignment_id: assignmentId, question_id: questionId, path, name: file.name, size: file.size }).select().single());
  },
  async fileUrl(path) {
    const client = await sb();
    const { data, error } = await client.storage.from("portal").createSignedUrl(path, 300);
    if (error) throw new Error(error.message);
    return data.signedUrl;
  },
  async engagementFiles(engagementId) {
    const client = await sb();
    return check(await client.from("files").select("*").eq("engagement_id", engagementId).order("created_at", { ascending: false }));
  },
  async submit(assignmentId) {
    const client = await sb();
    check(await client.rpc("submit_assignment", { asg: assignmentId }));
    // Start the AI draft; it finishes in the background and emails Michael.
    try { await invoke("process-submission", { assignment_id: assignmentId }); } catch (err) { console.warn("Draft not started:", err.message); }
  },
  async publications(engagementId) {
    const client = await sb();
    return check(await client.from("publications").select("*").eq("engagement_id", engagementId).order("published_at", { ascending: false }));
  },

  // ---- admin ----
  async clients() {
    const client = await sb();
    return check(await client.from("profiles").select("*, engagements(*)").eq("role", "client").order("created_at", { ascending: false }));
  },
  async engagement(id) {
    const client = await sb();
    return check(await client.from("engagements").select("*, client:profiles(*)").eq("id", id).single());
  },
  async updateEngagement(id, fields) {
    const client = await sb();
    check(await client.from("engagements").update(fields).eq("id", id));
  },
  async inviteClient(payload) { return invoke("invite-client", payload); },
  async questionnaires() {
    const client = await sb();
    const rows = check(await client.from("questionnaires").select("*, questions(count)").order("created_at", { ascending: false }));
    return rows.map((q) => ({ ...q, count: q.questions?.[0]?.count ?? 0 }));
  },
  async questionnaireWithQuestions(id) {
    const client = await sb();
    return check(await client.from("questionnaires").select("*, questions(*)").eq("id", id).order("position", { referencedTable: "questions" }).single());
  },
  async importQuestionnaire(template) {
    const t = validateTemplate(template);
    const client = await sb();
    const q = check(await client.from("questionnaires").insert({ title: t.title, description: t.description, intro: t.intro }).select().single());
    check(await client.from("questions").insert(t.questions.map((x) => ({ ...x, questionnaire_id: q.id }))));
    return q.id;
  },
  async assign(engagementId, questionnaireId, dueDate, message) {
    const client = await sb();
    const a = check(await client.from("assignments").insert({ engagement_id: engagementId, questionnaire_id: questionnaireId, due_date: dueDate || null, message: message || null }).select().single());
    await client.from("activity").insert({ engagement_id: engagementId, kind: "assignment_created", detail: { assignment_id: a.id } });
    return a.id;
  },
  async setAssignmentStatus(id, status) {
    const client = await sb();
    check(await client.from("assignments").update({ status }).eq("id", id));
  },
  async drafts(engagementId) {
    const client = await sb();
    let q = client.from("report_drafts").select("id, engagement_id, assignment_id, status, model, error, created_at, reviewed_at").order("created_at", { ascending: false });
    if (engagementId) q = q.eq("engagement_id", engagementId);
    return check(await q);
  },
  async draft(id) {
    const client = await sb();
    return check(await client.from("report_drafts").select("*, engagement:engagements(id, title, client_id)").eq("id", id).single());
  },
  async regenerateDraft(assignmentId) {
    const data = await invoke("process-submission", { assignment_id: assignmentId });
    return data.draft_id;
  },
  async dismissDraft(id) {
    const client = await sb();
    check(await client.from("report_drafts").update({ status: "dismissed", reviewed_at: new Date().toISOString() }).eq("id", id));
  },
  async publish(payload) { return invoke("publish-update", payload); },
  // ---- diagnostic (public; plain fetch so the contact page needn't load the Supabase client) ----
  async submitInquiry(payload) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/submit-inquiry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please email michael@sypher.solutions.");
    return data;
  },
  async inquiries() {
    const client = await sb();
    return check(await client.from("inquiries").select("*").order("created_at", { ascending: false }));
  },
  async inquiry(id) {
    const client = await sb();
    const [i, proposals] = await Promise.all([
      client.from("inquiries").select("*").eq("id", id).single().then(check),
      client.from("proposals").select("id, title, status, created_at").eq("inquiry_id", id).then(check),
    ]);
    return { ...i, proposals };
  },
  async updateInquiry(id, fields) {
    const client = await sb();
    check(await client.from("inquiries").update(fields).eq("id", id));
  },

  // ---- proposals ----
  async proposals() {
    const client = await sb();
    return check(await client.from("proposals").select("*").order("created_at", { ascending: false }));
  },
  async proposal(id) {
    const client = await sb();
    return check(await client.from("proposals").select("*").eq("id", id).single());
  },
  async createProposal(fields) {
    const client = await sb();
    return check(await client.from("proposals").insert(fields).select("id").single()).id;
  },
  async updateProposal(id, fields) {
    const client = await sb();
    check(await client.from("proposals").update(fields).eq("id", id));
  },
  async proposalByToken(token) {
    const client = await sb();
    return check(await client.rpc("get_proposal", { p_token: token }));
  },
  async respondProposal(token, action, f = {}) {
    const client = await sb();
    const p = check(await client.rpc("respond_proposal", {
      p_token: token, p_action: action, p_option: f.option ?? null, p_name: f.name ?? null,
      p_title: f.title ?? null, p_email: f.email ?? null, p_reason: f.reason ?? null,
    }));
    try { await invoke("proposal-response", { token }); } catch (err) { console.warn("Notification not sent:", err.message); }
    return p;
  },

  // ---- client room ----
  async milestones(engagementId) {
    const client = await sb();
    return check(await client.from("milestones").select("*").eq("engagement_id", engagementId).order("position"));
  },
  async saveMilestone(row) {
    const client = await sb();
    if (row.id) { const { id, ...fields } = row; check(await client.from("milestones").update(fields).eq("id", id)); }
    else check(await client.from("milestones").insert(row));
  },
  async deleteMilestone(id) {
    const client = await sb();
    check(await client.from("milestones").delete().eq("id", id));
  },
  async decisions(engagementId) {
    const client = await sb();
    return check(await client.from("decisions").select("*").eq("engagement_id", engagementId).order("decided_on", { ascending: false }));
  },
  async addDecision(row) {
    const client = await sb();
    check(await client.from("decisions").insert(row));
  },
  async deleteDecision(id) {
    const client = await sb();
    check(await client.from("decisions").delete().eq("id", id));
  },

  async activity(engagementId) {
    const client = await sb();
    let q = client.from("activity").select("*").order("created_at", { ascending: false }).limit(40);
    if (engagementId) q = q.eq("engagement_id", engagementId);
    return check(await q);
  },
};

export const store = isDemo ? demo : live;
export { progressOf };
