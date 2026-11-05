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

/** File types the portal accepts (the storage bucket enforces the same list server-side). */
export const FILE_TYPES = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  csv: "text/csv",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};
/** For <input type="file" accept>. */
export const FILE_ACCEPT = Object.keys(FILE_TYPES).map((x) => `.${x}`).join(",");
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Check a file before upload; returns the content type to store it with. */
export function checkFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const type = FILE_TYPES[ext];
  if (!type || !file.name.includes(".")) {
    throw new Error("That file type isn't accepted. Use PDF, Word, Excel, PowerPoint, CSV, text or an image (PNG, JPG, HEIC).");
  }
  if (file.size > MAX_FILE_BYTES) throw new Error("Files must be under 50 MB.");
  if (!file.size) throw new Error("That file is empty.");
  return type;
}

/** supabase-js hands back the QR code as "data:image/svg+xml;utf-8,<svg …>", which browsers may not
 *  render as written (";utf-8" isn't a valid parameter and the markup isn't encoded). Re-encode it. */
function svgDataUrl(value) {
  let svg = String(value || "");
  // Strip any "data:image/svg+xml;…," prefixes (supabase-js adds one; some servers add another).
  for (let m; (m = svg.match(/^data:image\/svg\+xml[^,]*,([\s\S]*)$/i));) svg = m[1];
  try { if (/^%3C/i.test(svg)) svg = decodeURIComponent(svg); } catch (_) { /* already plain */ }
  if (!/^\s*<svg[\s>]/i.test(svg)) return value; // not an SVG after all: leave it alone
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The same file, labelled with its checked type. supabase-js sends a File's own type, which some
 *  browsers leave blank (CSV, HEIC), and the storage bucket rejects anything not on its list. */
function typed(file, contentType) {
  return file.type === contentType ? file : new File([file], file.name, { type: contentType, lastModified: file.lastModified });
}

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
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: new URL(next || "dashboard.html", location.href).href },
    });
    // Keep Supabase's code and status so the sign-in page can tell "no account" from "wait" and "not sent".
    if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
  },
  /** Sign in with the 6-digit code from the sign-in email (the fallback when a mail scanner has used the link). */
  async verifyEmailCode(email, code) {
    const client = await sb();
    check(await client.auth.verifyOtp({ email, token: code, type: "email" }));
  },
  async signOut() { const client = await sb(); await client.auth.signOut(); },

  // ---- two-step sign-in (authenticator app); required for admin access ----
  async mfaState() {
    const client = await sb();
    const { data: aal, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw new Error(error.message);
    const { data: factors, error: e2 } = await client.auth.mfa.listFactors();
    if (e2) throw new Error(e2.message);
    return { level: aal.currentLevel, verified: factors.totp || [], all: factors.all || [] };
  },
  async mfaEnroll() {
    const client = await sb();
    const { all } = await this.mfaState();
    // An abandoned setup leaves an unverified factor behind; clear it so setup can restart.
    for (const f of all.filter((x) => x.status !== "verified")) await client.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `Sypher admin ${new Date().toISOString().slice(0, 10)}` });
    if (error) throw new Error(error.message);
    return { factorId: data.id, qr: svgDataUrl(data.totp.qr_code), secret: data.totp.secret };
  },
  async mfaVerify(factorId, code) {
    const client = await sb();
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code: String(code).replace(/\s+/g, "") });
    if (error) throw new Error(/invalid|expired/i.test(error.message) ? "That code didn't match. Codes change every 30 seconds; try the current one." : error.message);
  },

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
    const contentType = checkFile(file);
    const path = `${engagementId}/${crypto.randomUUID()}-${safe}`;
    check(await client.storage.from("portal").upload(path, typed(file, contentType), { upsert: false, contentType }));
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
    return check(await client.from("profiles").select("*, engagements!engagements_client_id_fkey(*)").eq("role", "client").order("created_at", { ascending: false }));
  },
  async engagement(id) {
    const client = await sb();
    return check(await client.from("engagements").select("*, client:profiles!engagements_client_id_fkey(*)").eq("id", id).single());
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

  async activity(engagementId, limit = 40) {
    const client = await sb();
    let q = client.from("activity").select("*").order("created_at", { ascending: false }).limit(limit);
    if (engagementId) q = q.eq("engagement_id", engagementId);
    return check(await q);
  },

  // ---- messages ----
  /** A thread: "private" (client and Michael) or "team" (everyone on the engagement's team). */
  async messages(engagementId, thread = "private") {
    const client = await sb();
    return check(await client.from("messages").select("*").eq("engagement_id", engagementId).eq("thread", thread).order("created_at"));
  },
  async postMessage(engagementId, body, thread = "private") {
    const client = await sb();
    const row = check(await client.from("messages").insert({ engagement_id: engagementId, body, thread }).select().single());
    this.notify("message", row.id);
    return row;
  },
  async markRead(engagementId) {
    const client = await sb();
    return check(await client.rpc("mark_messages_read", { eng: engagementId }));
  },
  /** Unread messages written by the other side, as { engagementId: count }. */
  async unreadCounts(userId) {
    const client = await sb();
    const rows = check(await client.from("messages").select("engagement_id, author_id").eq("thread", "private").is("read_at", null));
    const out = {};
    for (const r of rows) if (r.author_id !== userId) out[r.engagement_id] = (out[r.engagement_id] || 0) + 1;
    return out;
  },

  // ---- the team thread's read marker (one per person) ----
  async markTeamRead(engagementId) {
    const client = await sb();
    check(await client.rpc("mark_team_read", { eng: engagementId }));
  },
  async teamLastRead(engagementId, userId) {
    const client = await sb();
    const rows = check(await client.from("thread_reads").select("last_read_at").eq("engagement_id", engagementId).eq("user_id", userId).eq("thread", "team"));
    return rows[0]?.last_read_at || null;
  },

  // ---- the team: outside advisers on an engagement ----
  /** { client, principals, members } — members include status ("active" | "expired" | "revoked"). */
  async roster(engagementId) {
    const client = await sb();
    return check(await client.rpc("team_roster", { eng: engagementId }));
  },
  async inviteMember(payload) { return invoke("invite-member", payload); },
  async setMemberAccess(member, { can_message, can_files, expires_at, status }) {
    const client = await sb();
    check(await client.rpc("set_member_access", {
      member: member.id, p_can_message: can_message ?? member.can_message, p_can_files: can_files ?? member.can_files,
      p_expires_at: expires_at === undefined ? member.expires_at : expires_at, p_status: status || "active",
    }));
  },
  async touchMembership(engagementId) {
    const client = await sb();
    await client.rpc("touch_membership", { eng: engagementId });
  },
  async teamFiles(engagementId) {
    const client = await sb();
    return check(await client.from("team_files").select("*").eq("engagement_id", engagementId).order("created_at", { ascending: false }));
  },
  async uploadTeamFile(engagementId, file, note) {
    const client = await sb();
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-120);
    const contentType = checkFile(file);
    const path = `${engagementId}/team/${crypto.randomUUID()}-${safe}`;
    check(await client.storage.from("portal").upload(path, typed(file, contentType), { upsert: false, contentType }));
    try {
      const row = check(await client.from("team_files").insert({ engagement_id: engagementId, path, name: file.name, size: file.size, note: note || null }).select().single());
      this.notify("team_file", row.id);
      return row;
    } catch (err) {
      await client.storage.from("portal").remove([path]);
      throw err;
    }
  },
  async deleteTeamFile(f) {
    const client = await sb();
    await client.storage.from("portal").remove([f.path]);
    check(await client.from("team_files").delete().eq("id", f.id));
  },

  // ---- deliverables ----
  async deliverables(engagementId) {
    const client = await sb();
    return check(await client.from("deliverables").select("*").eq("engagement_id", engagementId).order("created_at", { ascending: false }));
  },
  async uploadDeliverable(engagementId, fields, file) {
    const client = await sb();
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-120);
    const contentType = checkFile(file);
    const path = `${engagementId}/deliverables/${crypto.randomUUID()}-${safe}`;
    check(await client.storage.from("portal").upload(path, typed(file, contentType), { upsert: false, contentType }));
    try {
      return check(await client.from("deliverables").insert({ engagement_id: engagementId, path, name: file.name, size: file.size, ...fields }).select().single());
    } catch (err) {
      await client.storage.from("portal").remove([path]);
      throw err;
    }
  },
  async updateDeliverable(id, fields) {
    const client = await sb();
    check(await client.from("deliverables").update(fields).eq("id", id));
  },
  async deleteDeliverable(d) {
    const client = await sb();
    check(await client.from("deliverables").delete().eq("id", d.id));
    await client.storage.from("portal").remove([d.path]);
  },

  // ---- action items ----
  async actionItems(engagementId) {
    const client = await sb();
    return check(await client.from("action_items").select("*").eq("engagement_id", engagementId).order("position").order("created_at"));
  },
  async addActionItem(row) {
    const client = await sb();
    return check(await client.from("action_items").insert(row).select().single());
  },
  async deleteActionItem(id) {
    const client = await sb();
    check(await client.from("action_items").delete().eq("id", id));
  },
  async setActionDone(id, done) {
    const client = await sb();
    check(await client.rpc("set_action_item_done", { item: id, done }));
  },

  // ---- the signed agreement behind an engagement ----
  async agreement(engagementId) {
    const client = await sb();
    return check(await client.rpc("engagement_agreement", { eng: engagementId }));
  },

  // ---- closing out an engagement (admin) ----
  /** Everything stored for an engagement, as one JSON-ready object. Files are listed, not embedded. */
  async exportEngagement(engagementId) {
    const client = await sb();
    const by = (table, extra = "*") => client.from(table).select(extra).eq("engagement_id", engagementId).then(check);
    const engagement = check(await client.from("engagements").select("*, client:profiles!engagements_client_id_fkey(id, email, full_name, company)").eq("id", engagementId).single());
    const [assignments, milestones, decisions, messages, actionItems, deliverables, files, teamFiles, publications, drafts, activity, members, proposals] = await Promise.all([
      by("assignments"), by("milestones"), by("decisions"), by("messages"), by("action_items"), by("deliverables"), by("files"),
      by("team_files"), by("publications"), by("report_drafts"), by("activity"), by("engagement_members"),
      client.from("proposals").select("*").eq("engagement_id", engagementId).then(check),
    ]);
    const asgIds = assignments.map((a) => a.id);
    const qIds = [...new Set(assignments.map((a) => a.questionnaire_id))];
    const [answers, questionnaires] = await Promise.all([
      asgIds.length ? client.from("answers").select("*").in("assignment_id", asgIds).then(check) : [],
      qIds.length ? client.from("questionnaires").select("*, questions(*)").in("id", qIds).then(check) : [],
    ]);
    return {
      exported_at: new Date().toISOString(), engagement, milestones, decisions, action_items: actionItems, questionnaires, assignments, answers,
      publications, report_drafts: drafts, messages, team: members, deliverables, client_files: files, team_files: teamFiles, proposals, activity,
      note: "Files are listed by path. Download them from the portal before deleting the engagement.",
    };
  },
  /** Every stored file under an engagement's folder, including deliverables/ and team/. */
  async engagementObjects(engagementId) {
    const client = await sb();
    const bucket = client.storage.from("portal");
    const out = [];
    const walk = async (prefix) => {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await bucket.list(prefix, { limit: 1000, offset });
        if (error) throw new Error(error.message);
        for (const item of data) {
          if (item.id === null) await walk(`${prefix}/${item.name}`); // a folder
          else out.push(`${prefix}/${item.name}`);
        }
        if (data.length < 1000) break;
      }
    };
    await walk(engagementId);
    return out;
  },
  /** Deletes an engagement's files, then the engagement and everything that belongs to it. */
  async deleteEngagement(engagementId) {
    const client = await sb();
    const paths = await this.engagementObjects(engagementId);
    for (let i = 0; i < paths.length; i += 100) check(await client.storage.from("portal").remove(paths.slice(i, i + 100)));
    check(await client.from("engagements").delete().eq("id", engagementId));
    return paths.length;
  },

  // ---- requests: to-dos, documents, answers, approvals and pricing asked of anyone on the team ----
  /** Everyone a request can go to: [{ id, name, role, org }]. */
  async requestParties(engagementId) {
    const client = await sb();
    return check(await client.rpc("request_parties", { eng: engagementId })) || [];
  },
  async submitRequest(id, note) {
    const client = await sb();
    check(await client.rpc("submit_request", { req: id, note: note || null }));
  },
  async reviewRequest(id, accept, note) {
    const client = await sb();
    check(await client.rpc("review_request", { req: id, accept, note: note || null }));
  },
  async requestFiles(engagementId) {
    const client = await sb();
    return check(await client.from("request_files").select("*").eq("engagement_id", engagementId).order("created_at"));
  },
  async uploadRequestFile(engagementId, requestId, file) {
    const client = await sb();
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-120);
    const contentType = checkFile(file);
    const path = `${engagementId}/requests/${requestId}/${crypto.randomUUID()}-${safe}`;
    check(await client.storage.from("portal").upload(path, typed(file, contentType), { upsert: false, contentType }));
    try {
      return check(await client.from("request_files").insert({ request_id: requestId, engagement_id: engagementId, path, name: file.name, size: file.size }).select().single());
    } catch (err) {
      await client.storage.from("portal").remove([path]);
      throw err;
    }
  },
  async deleteRequestFile(f) {
    const client = await sb();
    check(await client.from("request_files").delete().eq("id", f.id));
    await client.storage.from("portal").remove([f.path]);
  },

  // ---- notifications (written by the database; each person reads only their own) ----
  async notifications(limit = 60) {
    const client = await sb();
    return check(await client.from("notifications").select("*").order("created_at", { ascending: false }).limit(limit));
  },
  /** Mark some (or, with no ids, all) of my notifications read. */
  async markNotificationsRead(ids = null) {
    const client = await sb();
    return check(await client.rpc("mark_notifications_read", { ids }));
  },

  // ---- schedule of values ----
  async sovSheets(engagementId) {
    const client = await sb();
    return check(await client.from("sov_sheets").select("*").eq("engagement_id", engagementId).order("created_at"));
  },
  async sovSheet(id) {
    const client = await sb();
    return check(await client.from("sov_sheets").select("*").eq("id", id).single());
  },
  async sovLines(sheetId) {
    const client = await sb();
    return check(await client.from("sov_lines").select("*").eq("sheet_id", sheetId).order("position").order("updated_at"));
  },
  /** The owner side's budget per line. Row level security returns nothing to the contractor. */
  async sovBudget(engagementId) {
    const client = await sb();
    return check(await client.from("sov_budget").select("*").eq("engagement_id", engagementId));
  },
  async sovVersions(sheetId) {
    const client = await sb();
    return check(await client.from("sov_versions").select("id, version, subtotal, ohp, total, submitted_by, created_at").eq("sheet_id", sheetId).order("version", { ascending: false }));
  },
  async sovVersion(id) {
    const client = await sb();
    return check(await client.from("sov_versions").select("*").eq("id", id).single());
  },
  async sovSaveLine(lineId, patch) {
    const client = await sb();
    return check(await client.rpc("sov_save_line", { line: lineId, patch }));
  },
  async sovAddLine(sheetId, section, description) {
    const client = await sb();
    return check(await client.rpc("sov_add_line", { sheet: sheetId, p_section: section || null, p_description: description }));
  },
  async sovDeleteLine(lineId) {
    const client = await sb();
    check(await client.rpc("sov_delete_line", { line: lineId }));
  },
  async sovUpdateSheet(sheetId, patch) {
    const client = await sb();
    return check(await client.rpc("sov_update_sheet", { sheet: sheetId, patch }));
  },
  async sovSubmit(sheetId) {
    const client = await sb();
    return check(await client.rpc("sov_submit", { sheet: sheetId }));
  },
  async sovReview(sheetId, accept, note) {
    const client = await sb();
    check(await client.rpc("sov_review", { sheet: sheetId, accept, note: note || null }));
  },
  async sovReopen(sheetId) {
    const client = await sb();
    check(await client.rpc("sov_reopen", { sheet: sheetId }));
  },
  async sovLineReview(lineId, note) {
    const client = await sb();
    check(await client.rpc("sov_line_review", { line: lineId, p_note: note || null }));
  },
  // Admin: set up a sheet, its lines and the budget (direct table access, admin-only by RLS).
  async sovCreateSheet(fields) {
    const client = await sb();
    return check(await client.from("sov_sheets").insert(fields).select().single());
  },
  async sovAdminUpdateSheet(id, fields) {
    const client = await sb();
    return check(await client.from("sov_sheets").update(fields).eq("id", id).select().single());
  },
  async sovDeleteSheet(id) {
    const client = await sb();
    check(await client.from("sov_sheets").delete().eq("id", id));
  },
  async sovInsertLines(rows) {
    const client = await sb();
    return check(await client.from("sov_lines").insert(rows).select());
  },
  async sovSaveBudget(row) {
    const client = await sb();
    check(await client.from("sov_budget").upsert(row, { onConflict: "line_id" }));
  },

  // ---- the project model (owner side: Michael, the client, advisers given access) ----
  async pmModels(engagementId) {
    const client = await sb();
    return check(await client.from("pm_models").select("*").eq("engagement_id", engagementId).order("created_at"));
  },
  async pmModel(id) {
    const client = await sb();
    return check(await client.from("pm_models").select("*").eq("id", id).single());
  },
  async pmLines(modelId) {
    const client = await sb();
    return check(await client.from("pm_lines").select("*").eq("model_id", modelId).order("position"));
  },
  async pmInputs(modelId) {
    const client = await sb();
    return check(await client.from("pm_inputs").select("*").eq("model_id", modelId).order("position"));
  },
  async pmComments(modelId) {
    const client = await sb();
    return check(await client.from("pm_comments").select("*").eq("model_id", modelId).order("created_at"));
  },
  async pmInputLog(engagementId, limit = 60) {
    const client = await sb();
    return check(await client.from("pm_input_log").select("*").eq("engagement_id", engagementId).order("changed_at", { ascending: false }).limit(limit));
  },
  async pmSnapshots(modelId) {
    const client = await sb();
    return check(await client.from("pm_snapshots").select("id, label, created_by, created_at").eq("model_id", modelId).order("created_at", { ascending: false }));
  },
  async pmSnapshot(id) {
    const client = await sb();
    return check(await client.from("pm_snapshots").select("*").eq("id", id).single());
  },
  async pmSaveSnapshot(row) {
    const client = await sb();
    return check(await client.from("pm_snapshots").insert(row).select("id, label, created_by, created_at").single());
  },
  /** Set an assumption (Michael: any; others: the ones they're asked to confirm). Logged. */
  async pmSetInput(id, value, text, status, note) {
    const client = await sb();
    return check(await client.rpc("pm_set_input", { input: id, p_value: value, p_text: text ?? null, p_status: status, p_note: note || null }));
  },
  async pmAskInput(id, who, due) {
    const client = await sb();
    return check(await client.rpc("pm_ask_input", { input: id, who, p_due: due || null }));
  },
  async pmAddComment(row) {
    const client = await sb();
    return check(await client.from("pm_comments").insert(row).select().single());
  },
  async pmDeleteComment(id) {
    const client = await sb();
    check(await client.from("pm_comments").delete().eq("id", id));
  },
  // Admin: the model's structure.
  async pmCreateModel(fields) {
    const client = await sb();
    return check(await client.from("pm_models").insert(fields).select().single());
  },
  async pmUpdateModel(id, fields) {
    const client = await sb();
    check(await client.from("pm_models").update(fields).eq("id", id));
  },
  async pmDeleteModel(id) {
    const client = await sb();
    check(await client.from("pm_models").delete().eq("id", id));
  },
  async pmAddLines(rows) {
    const client = await sb();
    return check(await client.from("pm_lines").insert(rows).select());
  },
  async pmSaveLine(id, fields) {
    const client = await sb();
    return check(await client.from("pm_lines").update(fields).eq("id", id).select().single());
  },
  async pmDeleteLine(id) {
    const client = await sb();
    check(await client.from("pm_lines").delete().eq("id", id));
  },
  async pmAddInputs(rows) {
    const client = await sb();
    return check(await client.from("pm_inputs").insert(rows).select());
  },
  async pmUpdateInput(id, fields) {
    const client = await sb();
    return check(await client.from("pm_inputs").update(fields).eq("id", id).select().single());
  },
  /** Give (or take away) a team member's access to the project model. */
  async setMemberModel(memberId, allow) {
    const client = await sb();
    check(await client.rpc("set_member_model", { member: memberId, allow }));
  },

  // ---- the owner model (same audience as the project model) ----
  async omModels(engagementId) {
    const client = await sb();
    return check(await client.from("om_models").select("*").eq("engagement_id", engagementId).order("created_at"));
  },
  async omModel(id) {
    const client = await sb();
    return check(await client.from("om_models").select("*").eq("id", id).single());
  },
  /** Everything in one model, in one round trip per table. */
  async omBundle(modelId) {
    const client = await sb();
    const get = (t, order = "position") => client.from(t).select("*").eq("model_id", modelId).order(order).then(check);
    const [entities, periods, adjustments, properties, components, findings, inputs, personal, comments, snapshots] = await Promise.all([
      get("om_entities"), get("om_periods"), get("om_adjustments"), get("om_properties"), get("om_components"), get("om_findings"), get("om_inputs"),
      get("om_personal").catch(() => []),
      get("om_comments", "created_at").catch(() => []),
      client.from("om_snapshots").select("id, label, created_by, created_at").eq("model_id", modelId).order("created_at", { ascending: false }).then(check).catch(() => []),
    ]);
    return { entities, periods, adjustments, properties, components, findings, inputs, personal, comments, snapshots };
  },
  async omInputLog(engagementId, limit = 60) {
    const client = await sb();
    return check(await client.from("om_input_log").select("*").eq("engagement_id", engagementId).order("changed_at", { ascending: false }).limit(limit));
  },
  async omSetInput(id, value, text, status, note) {
    const client = await sb();
    return check(await client.rpc("om_set_input", { input: id, p_value: value, p_text: text ?? null, p_status: status, p_note: note || null }));
  },
  async omAskInput(id, who, due) {
    const client = await sb();
    return check(await client.rpc("om_ask_input", { input: id, who, p_due: due || null }));
  },
  async omAskFinding(id, who, due) {
    const client = await sb();
    return check(await client.rpc("om_ask_finding", { finding: id, who, p_due: due || null }));
  },
  async omAddComment(row) {
    const client = await sb();
    return check(await client.from("om_comments").insert(row).select().single());
  },
  async omDeleteComment(id) {
    const client = await sb();
    check(await client.from("om_comments").delete().eq("id", id));
  },
  async omSaveSnapshot(row) {
    const client = await sb();
    return check(await client.from("om_snapshots").insert(row).select("id, label, created_by, created_at").single());
  },
  async omSnapshot(id) {
    const client = await sb();
    return check(await client.from("om_snapshots").select("*").eq("id", id).single());
  },
  // Admin: the model's structure. `table` is one of om_entities, om_periods, om_adjustments,
  // om_properties, om_components, om_findings, om_inputs, om_personal.
  async omCreateModel(fields) {
    const client = await sb();
    return check(await client.from("om_models").insert(fields).select().single());
  },
  async omUpdateModel(id, fields) {
    const client = await sb();
    check(await client.from("om_models").update(fields).eq("id", id));
  },
  async omDeleteModel(id) {
    const client = await sb();
    check(await client.from("om_models").delete().eq("id", id));
  },
  async omInsert(table, rows) {
    const client = await sb();
    return check(await client.from(table).insert(rows).select());
  },
  async omUpdate(table, id, fields) {
    const client = await sb();
    return check(await client.from(table).update(fields).eq("id", id).select().single());
  },
  async omDelete(table, id) {
    const client = await sb();
    check(await client.from(table).delete().eq("id", id));
  },

  /** Live changes. Calls onChange({ table, eventType, new, old }) for each row change the user may see.
   *  `filters` is a list of { table, filter } (filter as "column=eq.value"). Returns an unsubscribe function. */
  async subscribe(name, filters, onChange, onStatus) {
    const client = await sb();
    let ch = client.channel(`${name}-${crypto.randomUUID().slice(0, 8)}`);
    for (const f of filters) {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: f.table, ...(f.filter ? { filter: f.filter } : {}) },
        (p) => onChange({ table: f.table, eventType: p.eventType, new: p.new, old: p.old }));
    }
    ch.subscribe((status) => onStatus?.(status));
    return () => { try { client.removeChannel(ch); } catch (_) { /* gone */ } };
  },

  /** Email the other side about something new. Best effort: never blocks the action itself. */
  async notify(kind, id) {
    try { await invoke("room-notify", { kind, id }); } catch (err) { console.warn("Notification not sent:", err.message); }
  },
};

export { progressOf };
