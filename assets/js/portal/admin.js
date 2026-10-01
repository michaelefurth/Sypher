// Admin console for the Managing Principal.
// Routes (hash): #overview · #clients · #engagement=<id> · #responses=<assignmentId>
//                #draft=<id> · #questionnaires
import { store, isDemo, progressOf } from "./store.js";
import { esc, paragraphs, $, $$, fmtDate, relTime, renderChrome, requireSession, toast, confirmDialog, statusPill, progressBar, download } from "./ui.js";

const main = document.getElementById("main");
let session;

const CHANGE_LABEL = { revise: "Revise", confirm: "Confirms", contradiction: "Contradiction", new_risk: "New risk" };
const CHANGE_CLASS = { revise: "pill--teal", confirm: "", contradiction: "pill--red", new_risk: "pill--gold" };
const ACTIVITY = {
  client_invited: "Client invited", assignment_created: "Questionnaire assigned", assignment_submitted: "Questionnaire submitted",
  draft_ready: "AI draft ready for review", update_published: "Update published",
};

function shell(active, counts, body) {
  const link = (hash, label, count) => `<a href="#${hash}" class="${active === hash ? "is-active" : ""}">${label}${count ? `<span class="count">${count}</span>` : ""}</a>`;
  return `<div class="admin">
    <nav class="admin__nav" aria-label="Admin">
      <h4>Workspace</h4>
      ${link("overview", "Overview")}
      ${link("clients", "Clients & engagements")}
      ${link("drafts", "AI drafts", counts.review)}
      ${link("questionnaires", "Questionnaires")}
      <h4>Help</h4>
      <a href="../docs/client-portal.md" target="_blank" rel="noopener">Setup guide</a>
    </nav>
    <div class="admin__main">${body}</div>
  </div>`;
}

async function counts() {
  const drafts = await store.drafts();
  return { review: drafts.filter((d) => d.status === "awaiting_review").length, drafts };
}

function title(h, sub = "", actions = "") {
  return `<div class="admin__title"><div><h1>${h}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="btn-row">${actions}</div></div>`;
}

/* ------------------------------------------------------------------ views */
async function viewOverview(c) {
  const [clients, activity] = await Promise.all([store.clients(), store.activity()]);
  const engagements = clients.flatMap((cl) => (cl.engagements || []).map((e) => ({ ...e, client: cl })));
  const assignmentLists = await Promise.all(engagements.map((e) => store.assignmentsFor(e.id).then((as) => as.map((a) => ({ ...a, engagement: e })))));
  const assignments = assignmentLists.flat();
  const submitted = assignments.filter((a) => a.status === "submitted");
  const review = c.drafts.filter((d) => d.status === "awaiting_review");
  const engTitle = (id) => engagements.find((e) => e.id === id)?.title || "Engagement";
  return title(`Good to see you, <em class="italic accent">Michael.</em>`, "What needs your attention across every engagement.") + `
    <div class="stat-row">
      <div class="stat"><b>${engagements.filter((e) => e.status === "active").length}</b><span>Active engagements</span></div>
      <div class="stat stat--gold"><b>${review.length}</b><span>Drafts to review</span></div>
      <div class="stat"><b>${submitted.length}</b><span>Questionnaires submitted</span></div>
      <div class="stat"><b>${assignments.filter((a) => ["open", "reopened"].includes(a.status)).length}</b><span>Awaiting clients</span></div>
    </div>
    <div class="p-grid">
      <section class="p-card p-card--accent"><p class="p-kicker">Needs your attention</p>
        ${review.length || submitted.length ? `<ul class="p-list">
          ${review.map((d) => `<li class="p-row"><div><h2 class="p-item">Draft ready: ${esc(engTitle(d.engagement_id))}</h2><p class="p-muted">${esc(relTime(d.created_at))}</p></div><a class="btn btn--navy btn--sm" href="#draft=${esc(d.id)}">Review draft</a></li>`).join("")}
          ${submitted.map((a) => `<li class="p-row"><div><h2 class="p-item">${esc(a.questionnaire?.title)}</h2><p class="p-muted">${esc(a.engagement.title)} · submitted ${esc(relTime(a.submitted_at))}</p></div><a class="btn btn--ghost btn--sm" href="#responses=${esc(a.id)}">View answers</a></li>`).join("")}
        </ul>` : `<p class="p-empty">You're all caught up.</p>`}
      </section>
      <section class="p-card"><p class="p-kicker">Recent activity</p>
        ${activity.length ? `<ul class="p-list">${activity.slice(0, 12).map((a) => `<li><strong>${esc(ACTIVITY[a.kind] || a.kind)}</strong><p class="p-muted">${esc(engTitle(a.engagement_id))} · ${esc(relTime(a.created_at))}</p></li>`).join("")}</ul>` : `<p class="p-muted">No activity yet.</p>`}
      </section>
    </div>`;
}

async function viewClients() {
  const clients = await store.clients();
  const rows = clients.flatMap((cl) => (cl.engagements?.length ? cl.engagements : [null]).map((e) => `<tr>
      <td><strong>${esc(cl.full_name || cl.email)}</strong><br><span class="p-muted">${esc(cl.company || "")} ${esc(cl.email)}</span></td>
      <td>${e ? esc(e.title) : `<span class="p-muted">No engagement</span>`}</td>
      <td>${e ? statusPill(e.status) : ""}</td>
      <td>${e ? `<a class="p-linkbtn" href="#engagement=${esc(e.id)}">Open</a>` : ""}</td></tr>`)).join("");
  return title("Clients &amp; engagements", "Invite a client and their workspace is ready the moment they sign in.") + `
    <div class="p-grid">
      <section class="p-card"><div class="p-table-wrap" tabindex="0" role="region" aria-label="Table"><table class="p-table">
        <thead><tr><th>Client</th><th>Engagement</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="p-muted">No clients yet.</td></tr>`}</tbody></table></div></section>
      <section class="p-card p-card--accent"><p class="p-kicker">Invite a client</p>
        <form class="p-form" id="invite-form">
          <div class="p-field"><label for="i-email">Email</label><input class="p-input" id="i-email" name="email" type="email" required></div>
          <div class="p-field"><label for="i-name">Full name</label><input class="p-input" id="i-name" name="full_name"></div>
          <div class="p-field"><label for="i-company">Company</label><input class="p-input" id="i-company" name="company"></div>
          <div class="p-field"><label for="i-title">Engagement title</label><input class="p-input" id="i-title" name="engagement_title" required placeholder="e.g. Business Feasibility Study"></div>
          <div class="p-field"><label for="i-summary">Summary the client will see</label><textarea class="p-textarea" id="i-summary" name="engagement_summary" rows="3"></textarea></div>
          <button class="btn btn--navy btn--sm" type="submit">Send invitation</button>
          <p class="p-muted">${isDemo ? "Demo mode: no email is sent." : "They'll receive a secure link to set up their access."}</p>
        </form></section>
    </div>`;
}

async function viewEngagement(id) {
  const [eng, assignments, drafts, pubs, questionnaires, activity] = await Promise.all([
    store.engagement(id), store.assignmentsFor(id), store.drafts(id), store.publications(id), store.questionnaires(), store.activity(id),
  ]);
  const client = eng.client || {};
  return title(esc(eng.title), `${esc(client.full_name || client.email || "")}${client.company ? ` · ${esc(client.company)}` : ""}`, statusPill(eng.status)) + `
    <div class="draft-grid">
      <div class="p-stack">
        <section class="p-card"><p class="p-kicker">Questionnaires</p>
          ${assignments.length ? `<div class="p-table-wrap" tabindex="0" role="region" aria-label="Table"><table class="p-table"><thead><tr><th>Questionnaire</th><th>Progress</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          ${assignments.map((a) => `<tr><td><strong>${esc(a.questionnaire?.title)}</strong><br><span class="p-muted">${a.due_date ? `Due ${esc(fmtDate(a.due_date, { month: "short", day: "numeric" }))}` : "No due date"}</span></td>
            <td style="min-width:140px">${progressBar(a.progress)}<span class="p-muted">${a.progress.answered + a.progress.unknown}/${a.progress.total}</span></td>
            <td>${statusPill(a.status)}</td>
            <td><div class="btn-row" style="gap:.5rem 1rem">
              <a class="p-linkbtn" href="#responses=${esc(a.id)}">Answers</a>
              ${a.status === "submitted" || a.status === "complete" ? `<button class="p-linkbtn" data-reopen="${esc(a.id)}">Reopen</button>` : ""}
              ${a.status === "submitted" ? `<button class="p-linkbtn" data-complete="${esc(a.id)}">Mark complete</button>` : ""}
              <button class="p-linkbtn" data-regen="${esc(a.id)}">AI draft</button>
            </div></td></tr>`).join("")}
          </tbody></table></div>` : `<p class="p-empty">No questionnaires assigned yet.</p>`}
          <form class="p-form p-form--2" id="assign-form" style="margin-top:1.75rem;padding-top:1.5rem;border-top:1px solid var(--rule)">
            <div class="p-field p-span"><label for="a-q">Assign a questionnaire</label>
              <select class="p-select" id="a-q" name="questionnaire" required>${questionnaires.map((q) => `<option value="${esc(q.id)}">${esc(q.title)} (${q.count} questions)</option>`).join("")}</select></div>
            <div class="p-field"><label for="a-due">Due date</label><input class="p-input" id="a-due" name="due" type="date"></div>
            <div class="p-field p-span"><label for="a-msg">Note to the client</label><textarea class="p-textarea" id="a-msg" name="message" rows="2" placeholder="Shown at the top of the questionnaire"></textarea></div>
            <div class="p-span"><button class="btn btn--navy btn--sm" type="submit" ${questionnaires.length ? "" : "disabled"}>Assign</button></div>
          </form>
        </section>
        <section class="p-card"><p class="p-kicker">AI drafts</p>
          ${drafts.length ? `<ul class="p-list">${drafts.map((d) => `<li class="p-row"><div>${statusPill(d.status)} <span class="p-muted">${esc(relTime(d.created_at))}</span>${d.error ? `<p class="p-muted">${esc(d.error)}</p>` : ""}</div>${d.status === "awaiting_review" || d.status === "published" || d.status === "dismissed" ? `<a class="p-linkbtn" href="#draft=${esc(d.id)}">Open</a>` : ""}</li>`).join("")}</ul>` : `<p class="p-muted">A draft is generated automatically when the client submits a questionnaire.</p>`}
        </section>
        <section class="p-card"><p class="p-kicker">Published updates</p>
          ${pubs.length ? `<ul class="p-list">${pubs.map((p) => `<li><div class="p-row"><h2 class="p-item">${esc(p.title)}</h2><span class="p-muted">${esc(fmtDate(p.published_at))}</span></div></li>`).join("")}</ul>` : `<p class="p-muted">Nothing published yet.</p>`}
          <details style="margin-top:1rem"><summary class="p-linkbtn">Write an update by hand</summary>
            <form class="p-form" id="manual-pub" style="margin-top:1rem">
              <div class="p-field"><label for="m-title">Title</label><input class="p-input" id="m-title" name="title" required></div>
              <div class="p-field"><label for="m-body">Message</label><textarea class="p-textarea" id="m-body" name="body" rows="6" required></textarea></div>
              <button class="btn btn--navy btn--sm" type="submit">Publish to client</button>
            </form></details>
        </section>
      </div>
      <div class="p-stack">
        <section class="p-card p-card--accent"><p class="p-kicker">Report context for the AI</p>
          <p class="p-muted">Private to you. Paste the report's key assumptions, figures and conclusions. Claude compares each answer against this to propose section updates.</p>
          <form class="p-form" id="context-form">
            <textarea class="p-textarea" name="report_context" rows="12" aria-label="Report context for the AI">${esc(eng.report_context || "")}</textarea>
            <div class="p-field"><label for="e-summary">Summary the client sees</label><textarea class="p-textarea" id="e-summary" name="summary" rows="3">${esc(eng.summary || "")}</textarea></div>
            <button class="btn btn--navy btn--sm" type="submit">Save</button>
          </form></section>
        <section class="p-card"><p class="p-kicker">Activity</p>
          ${activity.length ? `<ul class="p-list">${activity.map((a) => `<li><strong>${esc(ACTIVITY[a.kind] || a.kind)}</strong><p class="p-muted">${esc(relTime(a.created_at))}</p></li>`).join("")}</ul>` : `<p class="p-muted">No activity yet.</p>`}
        </section>
      </div>
    </div>`;
}

function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

async function viewResponses(assignmentId) {
  const d = await store.assignment(assignmentId);
  const byQ = new Map(d.answers.map((a) => [a.question_id, a]));
  const p = progressOf(d.questions, d.answers);
  window.__responses = d; // used by the export buttons
  return title(esc(d.questionnaire.title), `${esc(d.engagement?.title || "")} · ${p.answered} answered · ${p.unknown} pending · ${p.open} not started`,
    `${statusPill(d.assignment.status)}<button class="btn btn--ghost btn--sm" data-export="csv">Export CSV</button><button class="btn btn--ghost btn--sm" data-export="json">Export JSON</button><button class="btn btn--navy btn--sm" data-regen="${esc(assignmentId)}">Generate AI draft</button>`) + `
    <section class="p-card"><div class="p-table-wrap" tabindex="0" role="region" aria-label="Table"><table class="p-table">
      <thead><tr><th>#</th><th style="width:38%">Question</th><th>Answer</th></tr></thead>
      <tbody>${d.questions.map((q) => {
        const a = byQ.get(q.id);
        const files = d.files.filter((f) => f.question_id === q.id);
        const ans = !a ? `<span class="p-muted">Not started</span>`
          : a.state === "unknown" ? `<span class="pill pill--gold">Don't know yet</span>${a.value ? paragraphs(a.value) : ""}`
          : (a.value || "").trim() ? paragraphs(a.value) : `<span class="p-muted">Blank</span>`;
        return `<tr><td class="num">${esc(q.number || q.position)}</td>
          <td>${q.priority ? `<span class="pill pill--gold" style="margin-bottom:.4rem">${q.priority === "rerun" ? "Rerun the model" : "Critical"}</span><br>` : ""}${esc(q.prompt)}${q.why ? `<p class="p-muted" style="margin-top:.4rem">${esc(q.why)}</p>` : ""}</td>
          <td>${ans}${a?.note ? `<p class="p-muted" style="margin-top:.4rem"><em>Note:</em> ${esc(a.note)}</p>` : ""}${files.length ? `<p class="p-muted">Files: ${files.map((f) => esc(f.name)).join(", ")}</p>` : ""}</td></tr>`;
      }).join("")}</tbody></table></div></section>`;
}

function exportResponses(kind) {
  const d = window.__responses;
  if (!d) return;
  const byQ = new Map(d.answers.map((a) => [a.question_id, a]));
  const rows = d.questions.map((q) => {
    const a = byQ.get(q.id) || {};
    return {
      number: q.number, section: [q.section_code, q.section_title].filter(Boolean).join(". "), priority: q.priority || "",
      question: q.prompt, what_it_changes: q.why || "", answer: a.value || "", state: a.value || a.state === "unknown" ? a.state || "answered" : "not_started",
      note: a.note || "", files: d.files.filter((f) => f.question_id === q.id).map((f) => f.name).join("; "), updated_at: a.updated_at || "",
    };
  });
  const base = `${(d.engagement?.title || "responses").replace(/[^\w]+/g, "-")}-${new Date().toISOString().slice(0, 10)}`;
  if (kind === "json") download(`${base}.json`, JSON.stringify({ questionnaire: d.questionnaire.title, engagement: d.engagement?.title, exported_at: new Date().toISOString(), responses: rows }, null, 2), "application/json");
  else {
    const head = Object.keys(rows[0] || { number: "" });
    download(`${base}.csv`, [head.join(","), ...rows.map((r) => head.map((h) => csvCell(r[h])).join(","))].join("\n"), "text/csv");
  }
}

async function viewDrafts(c) {
  return title("AI drafts", "Every submission produces a draft for your review. Nothing reaches a client until you publish it.") + `
    <section class="p-card">${c.drafts.length ? `<ul class="p-list">${c.drafts.map((d) => `<li class="p-row"><div>${statusPill(d.status)} <span class="p-muted">${esc(relTime(d.created_at))}${d.model ? ` · ${esc(d.model)}` : ""}</span>${d.error ? `<p class="p-muted">${esc(d.error)}</p>` : ""}</div>
      <div class="btn-row">${["awaiting_review", "published", "dismissed"].includes(d.status) ? `<a class="btn btn--ghost btn--sm" href="#draft=${esc(d.id)}">Open</a>` : ""}<a class="p-linkbtn" href="#engagement=${esc(d.engagement_id)}">Engagement</a></div></li>`).join("")}</ul>` : `<p class="p-empty">No drafts yet.</p>`}</section>`;
}

function draftMarkdown(d, eng) {
  const x = d.draft;
  const lines = [`# Draft update: ${eng?.title || ""}`, "", x.summary, ""];
  if (x.model_rerun.required) lines.push("## Model rerun", ...x.model_rerun.reasons.map((r) => `- ${r}`), ...x.model_rerun.input_changes.map((i) => `- ${i.input}: ${i.previous_value || "?"} → ${i.new_value || "?"} (Q${i.question_number})`), "");
  lines.push("## Section updates");
  x.section_updates.forEach((u) => lines.push(`### ${u.section} (${CHANGE_LABEL[u.change_type] || u.change_type})`, u.rationale, "", `> ${u.proposed_text.replace(/\n/g, "\n> ")}`, ""));
  lines.push("## Data points", "| Q | Item | Value | Confidence |", "|---|---|---|---|", ...x.data_points.map((p) => `| ${p.question_number} | ${p.label} | ${p.value} ${p.unit} | ${p.confidence} |`), "");
  lines.push("## Flags", ...x.flags.map((f) => `- **${f.severity}**: ${f.issue}`), "", "## Follow-up questions", ...x.follow_up_questions.map((f) => `- ${f.question} _(${f.reason})_`));
  return lines.join("\n");
}

async function viewDraft(id) {
  const d = await store.draft(id);
  window.__draft = d;
  if (!d.draft) return title("Draft in progress", "Claude is still working on this one. Refresh in a minute.");
  const x = d.draft;
  const done = d.status !== "awaiting_review";
  return title(`Draft update`, `${esc(d.engagement?.title || "")} · ${esc(relTime(d.created_at))}${d.model ? ` · ${esc(d.model)}` : ""}`,
    `${statusPill(d.status)}<button class="btn btn--ghost btn--sm" data-draft-md>Download Markdown</button>${done ? "" : `<button class="btn btn--ghost btn--sm" data-dismiss="${esc(d.id)}">Dismiss</button>`}`) + `
    <div class="draft-grid">
      <div class="p-stack">
        <section class="p-card p-card--accent"><p class="p-kicker">Summary for you</p>${paragraphs(x.summary)}
          ${x.model_rerun.required ? `<div class="draft-rerun" style="margin-top:1.25rem"><strong>Rerun the model</strong>
            <ul style="margin:.5rem 0 0;padding-left:1.1rem">${x.model_rerun.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
            ${x.model_rerun.input_changes.length ? `<div class="p-table-wrap" tabindex="0" role="region" aria-label="Model input changes" style="margin-top:.75rem"><table class="p-table"><thead><tr><th>Input</th><th>Was</th><th>Now</th><th>Q</th></tr></thead><tbody>${x.model_rerun.input_changes.map((i) => `<tr><td>${esc(i.input)}</td><td>${esc(i.previous_value || "—")}</td><td><strong>${esc(i.new_value || "—")}</strong></td><td class="num">${esc(i.question_number)}</td></tr>`).join("")}</tbody></table></div>` : ""}
          </div>` : ""}
        </section>
        <section class="p-card"><p class="p-kicker">Proposed section updates</p>
          ${x.section_updates.length ? x.section_updates.map((u, i) => `<div class="draft-update">
            <div class="p-row"><h2 class="p-item">${esc(u.section)}</h2><span class="pill ${CHANGE_CLASS[u.change_type] || ""}">${esc(CHANGE_LABEL[u.change_type] || u.change_type)}</span></div>
            <p class="p-muted" style="margin-top:.4rem">${esc(u.rationale)}${u.question_numbers.length ? ` · Q${u.question_numbers.map(esc).join(", Q")}` : ""}</p>
            <blockquote>${esc(u.proposed_text)}</blockquote>
            <button class="p-linkbtn copy-btn" data-copy="${i}">Copy wording</button></div>`).join("") : `<p class="p-muted">No section changes proposed.</p>`}
        </section>
        <section class="p-card"><p class="p-kicker">Data points extracted</p>
          ${x.data_points.length ? `<div class="p-table-wrap" tabindex="0" role="region" aria-label="Table"><table class="p-table"><thead><tr><th>Q</th><th>Item</th><th>Value</th><th>Confidence</th></tr></thead><tbody>
          ${x.data_points.map((p) => `<tr><td class="num">${esc(p.question_number)}</td><td>${esc(p.label)}<p class="p-muted" style="margin-top:.3rem">“${esc(p.source_quote)}”</p></td><td><strong>${esc(p.value)}</strong> ${esc(p.unit)}</td><td>${esc(p.confidence)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="p-muted">No figures extracted.</p>`}
        </section>
      </div>
      <div class="p-stack">
        <section class="p-card p-card--navy"><p class="p-kicker">Publish to the client</p>
          ${done ? `<p>This draft is ${esc(d.status)}.</p>` : `<form class="p-form" id="publish-form">
            <div class="p-field"><label for="p-title" style="color:var(--on-dark-muted)">Title</label><input class="p-input" id="p-title" name="title" value="An update on your engagement" required></div>
            <div class="p-field"><label for="p-body" style="color:var(--on-dark-muted)">Message (edit freely)</label><textarea class="p-textarea" id="p-body" name="body" rows="9" required>${esc(x.client_summary)}</textarea></div>
            <button class="btn btn--gold btn--sm" type="submit">Approve &amp; publish</button>
            <p style="font-size:.85rem">Only this message is shared. The analysis on this page stays private to you.</p>
          </form>`}
        </section>
        <section class="p-card"><p class="p-kicker">Flags</p>
          ${x.flags.length ? x.flags.map((f) => `<div class="draft-flag"><span class="pill ${f.severity === "high" ? "pill--red" : f.severity === "medium" ? "pill--gold" : ""}">${esc(f.severity)}</span><div>${esc(f.issue)}${f.question_numbers.length ? `<p class="p-muted">Q${f.question_numbers.map(esc).join(", Q")}</p>` : ""}</div></div>`).join("") : `<p class="p-muted">No flags.</p>`}
        </section>
        <section class="p-card"><p class="p-kicker">Follow-up questions</p>
          ${x.follow_up_questions.length ? `<ol style="padding-left:1.1rem;margin:0">${x.follow_up_questions.map((f) => `<li style="margin-bottom:.75rem">${esc(f.question)}<p class="p-muted">${esc(f.reason)}</p></li>`).join("")}</ol>
            <button class="btn btn--ghost btn--sm" data-followups style="margin-top:.5rem">Send as a new questionnaire</button>` : `<p class="p-muted">None.</p>`}
          ${x.open_questions.length ? `<p class="p-muted" style="margin-top:1rem">Still open: Q${x.open_questions.map(esc).join(", Q")}</p>` : ""}
        </section>
      </div>
    </div>`;
}

async function viewQuestionnaires() {
  const list = await store.questionnaires();
  return title("Questionnaires", "Your library of question sets. Import one as JSON, then assign it to any engagement.",
    `<button class="btn btn--ghost btn--sm" data-template>Download template</button>`) + `
    <div class="p-grid">
      <section class="p-card">${list.length ? `<ul class="p-list">${list.map((q) => `<li><div class="p-row"><h2 class="p-item">${esc(q.title)}</h2><span class="p-muted">${q.count} questions</span></div>${q.description ? `<p class="p-muted">${esc(q.description)}</p>` : ""}</li>`).join("")}</ul>` : `<p class="p-empty">No questionnaires yet.</p>`}</section>
      <section class="p-card p-card--accent"><p class="p-kicker">Import a questionnaire</p>
        <form class="p-form" id="import-form">
          <div class="p-field"><label for="imp-file">JSON file</label><input class="p-input" id="imp-file" type="file" accept=".json,application/json"></div>
          <div class="p-field"><label for="imp-text">…or paste JSON</label><textarea class="p-textarea" id="imp-text" rows="8" placeholder='{"title": "...", "questions": [{"number": "1", "prompt": "..."}]}'></textarea></div>
          <button class="btn btn--navy btn--sm" type="submit">Import</button>
        </form></section>
    </div>`;
}

const TEMPLATE = {
  title: "Follow-up questions",
  description: "Questions that decide whether the model needs to be rerun.",
  intro: "Answer what you can. Mark anything you don't know yet and add a note on when you'll have it.",
  questions: [
    { number: "1", section_code: "A", section_title: "Where things stand today", prompt: "Has the business made any sales yet? If so, how many units by month, at what price?", why: "Replaces the first months of the ramp with actuals.", priority: "rerun", answer_type: "long_text" },
    { number: "2", section_code: "A", section_title: "Where things stand today", prompt: "What has been signed that cannot be undone?", why: "Which paths in the report are still open.", answer_type: "long_text" },
    { number: "3", section_code: "B", section_title: "Customers and price", prompt: "Which customers have committed in writing?", why: "First-quarter volume.", priority: "critical", answer_type: "long_text" },
  ],
};

/* ------------------------------------------------------------ router/bind */
async function route() {
  const hash = location.hash.slice(1) || "overview";
  const [key, arg] = hash.split("=");
  main.innerHTML = `<div class="p-loading">Loading…</div>`;
  try {
    const c = await counts();
    let body, active = key;
    if (key === "clients") body = await viewClients();
    else if (key === "engagement") { body = await viewEngagement(arg); active = "clients"; }
    else if (key === "responses") { body = await viewResponses(arg); active = "clients"; }
    else if (key === "draft") { body = await viewDraft(arg); active = "drafts"; }
    else if (key === "drafts") body = await viewDrafts(c);
    else if (key === "questionnaires") body = await viewQuestionnaires();
    else { body = await viewOverview(c); active = "overview"; }
    main.innerHTML = shell(active, c, body);
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    main.innerHTML = shell("", { review: 0 }, `<p class="p-empty">${esc(err.message)}</p>`);
  }
}

function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

main.addEventListener("submit", async (e) => {
  const form = e.target;
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const hash = location.hash.slice(1);
    const engId = hash.startsWith("engagement=") ? hash.split("=")[1] : null;
    if (form.id === "invite-form") {
      const r = await store.inviteClient(formData(form));
      toast(r.invited ? "Invitation sent." : "Engagement added for the existing client.");
      location.hash = `engagement=${r.engagement_id}`;
    } else if (form.id === "context-form") {
      await store.updateEngagement(engId, { report_context: form.report_context.value, summary: form.summary.value });
      toast("Saved.");
    } else if (form.id === "assign-form") {
      await store.assign(engId, form.questionnaire.value, form.due.value, form.message.value);
      toast("Questionnaire assigned. The client will see it in their portal.");
      route();
    } else if (form.id === "manual-pub") {
      const ok = await confirmDialog({ title: "Publish this update?", body: "<p>The client will see it in their portal and receive an email.</p>", confirmLabel: "Publish" });
      if (ok) { await store.publish({ engagement_id: engId, ...formData(form) }); toast("Published."); route(); }
    } else if (form.id === "publish-form") {
      const d = window.__draft;
      const ok = await confirmDialog({ title: "Approve and publish?", body: "<p>Your message will appear in the client's portal and they'll be emailed. The analysis stays private.</p>", confirmLabel: "Publish" });
      if (ok) { await store.publish({ engagement_id: d.engagement_id, draft_id: d.id, ...formData(form) }); toast("Published to the client."); route(); }
    } else if (form.id === "import-form") {
      let text = form.querySelector("#imp-text").value.trim();
      const file = form.querySelector("#imp-file").files[0];
      if (file) text = await file.text();
      if (!text) throw new Error("Choose a file or paste JSON.");
      let json;
      try { json = JSON.parse(text); } catch { throw new Error("That isn't valid JSON."); }
      await store.importQuestionnaire(json);
      toast("Questionnaire imported.");
      route();
    }
  } catch (err) { toast(err.message, true); }
  finally { if (btn) btn.disabled = false; }
});

main.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  try {
    if (t.dataset.export) exportResponses(t.dataset.export);
    else if (t.dataset.reopen) { await store.setAssignmentStatus(t.dataset.reopen, "reopened"); toast("Reopened. The client can edit their answers again."); route(); }
    else if (t.dataset.complete) { await store.setAssignmentStatus(t.dataset.complete, "complete"); toast("Marked complete."); route(); }
    else if (t.dataset.regen) {
      t.disabled = true;
      const id = await store.regenerateDraft(t.dataset.regen);
      toast(isDemo ? "Sample draft created." : "Claude is drafting. You'll get an email when it's ready.");
      if (isDemo) location.hash = `draft=${id}`; else route();
    } else if (t.dataset.dismiss) {
      if (await confirmDialog({ title: "Dismiss this draft?", body: "<p>It won't be sent. You can generate a new one at any time.</p>", confirmLabel: "Dismiss" })) { await store.dismissDraft(t.dataset.dismiss); route(); }
    } else if (t.hasAttribute("data-copy")) {
      const u = window.__draft.draft.section_updates[Number(t.dataset.copy)];
      await navigator.clipboard.writeText(u.proposed_text); toast("Wording copied.");
    } else if (t.hasAttribute("data-draft-md")) {
      download(`draft-${window.__draft.id}.md`, draftMarkdown(window.__draft, window.__draft.engagement), "text/markdown");
    } else if (t.hasAttribute("data-followups")) {
      const d = window.__draft;
      const qs = d.draft.follow_up_questions;
      const ok = await confirmDialog({ title: "Send follow-up questions?", body: `<p>This creates a new questionnaire with ${qs.length} questions and assigns it to the client.</p>`, confirmLabel: "Create & assign" });
      if (!ok) return;
      const qid = await store.importQuestionnaire({
        title: `Follow-up questions · ${new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" })}`,
        intro: "A few points to close out from your last answers.",
        questions: qs.map((f, i) => ({ number: String(i + 1), prompt: f.question, why: f.reason, answer_type: "long_text" })),
      });
      await store.assign(d.engagement_id, qid, "", "Thank you for your answers. These few follow-ups will close the remaining gaps.");
      toast("Follow-up questionnaire assigned.");
    } else if (t.hasAttribute("data-template")) {
      download("questionnaire-template.json", JSON.stringify(TEMPLATE, null, 2), "application/json");
    }
  } catch (err) { toast(err.message, true); t.disabled = false; }
});

(async () => {
  session = await requireSession({ admin: true });
  if (!session) return;
  renderChrome(session, { active: "admin", admin: true });
  window.addEventListener("hashchange", route);
  route();
})();
