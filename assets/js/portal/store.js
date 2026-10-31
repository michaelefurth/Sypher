// Client Portal data layer, backed by Supabase: auth by magic link, Postgres
// with row level security, private file storage, and edge functions for
// invites, AI drafts and publishing.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

/** Starting terms for a new proposal. Michael edits these to match his engagement letter. */
export const DEFAULT_TERMS = [
  "Fees. Fixed-fee work is invoiced half at signing and half on delivery. Retainers are invoiced monthly in advance. Expenses only with your prior approval, at cost.",
  "Confidentiality. Everything you share stays confidential and is used only for this engagement. Your name is never used publicly without written permission.",
  "Ownership. Everything built for you is yours on payment: models, documents, accounts and code.",
  "Changes. If the scope changes, a short written change order is agreed before any extra work begins.",
  "Ending early. Either side may end the engagement with 14 days' written notice. Work completed to that date is invoiced.",
  "Licensed advice. Sypher Solutions is not a CPA or law firm. Where tax, legal or regulatory sign-off is needed, it comes from licensed professionals.",
].join("\n\n");

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
/* Supabase back end                                                         */
/* ------------------------------------------------------------------------ */
let sbPromise = null;
function sb() {
  if (!(SUPABASE_URL && SUPABASE_ANON_KEY)) {
    return Promise.reject(new Error("The portal isn't connected to its database. Set SUPABASE_URL and SUPABASE_ANON_KEY in assets/js/portal/config.js."));
  }
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

export const store = {
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

export { progressOf };
