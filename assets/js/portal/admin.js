// Admin console for the Managing Principal.
// Routes (hash): #overview · #inquiries · #inquiry=<id> · #proposals · #proposal=<id>
//                #clients · #engagement=<id>/<tab> · #responses=<assignmentId> · #draft=<id> · #questionnaires
// An engagement page has six tabs: today (messages, requests, activity), models, documents,
// plan, people and settings; the next conversation and the milestones stay beside every tab.
import { store, progressOf, FILE_ACCEPT, checkFile } from "./store.js";
import { esc, paragraphs, fileLabel, $, $$, fmtDate, relTime, renderChrome, requireSession, toast, toastNotice, confirmDialog, promptDialog, statusPill, progressBar, download } from "./ui.js";
import { SOV_TEMPLATES, sovTotals, sheetPill, money } from "./sov.js";
import { mountBell } from "./bell.js";
import { createFromTemplate, modelSummary } from "./model.js";
import { createOwnerFromTemplate, ownerSummary } from "./owner.js";
import { viewInquiries, viewInquiry, viewProposals, viewProposal, pipelineSubmit, pipelineClick } from "./admin-pipeline.js";

const main = document.getElementById("main");
let session;

const CHANGE_LABEL = { revise: "Revise", confirm: "Confirms", contradiction: "Contradiction", new_risk: "New risk" };
const CHANGE_CLASS = { revise: "pill--teal", confirm: "", contradiction: "pill--red", new_risk: "pill--gold" };
const ACTIVITY = {
  client_invited: "Client invited", assignment_created: "Questionnaire assigned", assignment_submitted: "Questionnaire submitted",
  draft_ready: "AI draft ready for review", update_published: "Update published",
  inquiry_received: "New diagnostic received", proposal_accepted: "Proposal accepted", proposal_declined: "Proposal declined",
  message_posted: "Message", deliverable_shared: "Document shared", action_assigned: "Item added for the client",
  action_done: "Task done", decision_recorded: "Decision recorded", milestone_current: "Milestone under way", milestone_done: "Milestone complete",
  team_file_shared: "Team file added", member_invited: "Joined the team", member_revoked: "Team access removed",
  invoice_sent: "Invoice sent", invoice_paid: "Invoice paid", invoice_payment_failed: "Payment failed", invoice_voided: "Invoice voided",
  invoice_refunded: "Refund issued", invoice_credited: "Credit note issued", invoice_uncollectible: "Invoice marked uncollectible",
};
const activityLabel = (a) => {
  const base = a.kind === "message_posted"
    ? (a.detail?.thread === "team" ? (a.detail?.from === "principal" ? "You wrote to the team" : a.detail?.from === "client" ? "Client wrote to the team" : "Team member wrote to the team")
      : a.detail?.from === "client" ? "Message from the client" : "You sent a message")
    : (ACTIVITY[a.kind] || a.kind);
  return a.detail?.title && !["update_published", "proposal_accepted", "proposal_declined"].includes(a.kind) ? `${base}: ${a.detail.title}` : base;
};
const fmtSize = (n) => (!n ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const MS_STATUS = [["upcoming", "Upcoming"], ["current", "In progress"], ["done", "Done"]];
const KIND = { task: "To-do", document: "Document", answer: "Question", approval: "Approval", pricing: "Pricing" };
const ENG_TABS = [["today", "Today"], ["models", "Models"], ["documents", "Documents"], ["billing", "Billing"], ["plan", "Plan"], ["people", "People"], ["settings", "Settings"]];
/** Invoice amounts are in cents; shown to the cent. */
const usd = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100);
const INV_KIND = { deposit: "Deposit", milestone: "Milestone", retainer: "Retainer", one_off: "Fee" };
const INV_STATUS = { draft: ["Draft", ""], open: ["Open", "pill--gold"], paid: ["Paid", "pill--navy"], void: ["Void", ""], uncollectible: ["Uncollectible", "pill--red"] };
/** Stripe tax codes offered on a line: consulting by default, accounting for bookkeeping and forensic work. */
const TAX_CODES = [["txcd_20060048", "Consulting"], ["txcd_20060001", "Accounting"], ["txcd_20030000", "General services"]];
/** The engagement the page is on (from #engagement=<id>/<tab>), and its tab. */
const engagementId = () => (location.hash.slice(1).match(/^engagement=([^/&]+)/) || [])[1] || null;
const engTab = () => { const t = location.hash.slice(1).split("/")[1]; return ENG_TABS.some(([k]) => k === t) ? t : "today"; };
const REQ_STATUS = { open: ["Open", "pill--teal"], submitted: ["To review", "pill--gold"], changes_requested: ["Changes requested", "pill--red"], accepted: ["Done", "pill--navy"] };

function shell(active, counts, body) {
  const link = (hash, label, count) => `<a href="#${hash}" class="${active === hash ? "is-active" : ""}">${label}${count ? `<span class="count">${count}</span>` : ""}</a>`;
  return `<div class="admin">
    <nav class="admin__nav" aria-label="Admin">
      <h4>Workspace</h4>
      ${link("overview", "Overview")}
      ${link("inquiries", "Inquiries", counts.inquiries)}
      ${link("proposals", "Proposals", counts.accepted)}
      ${link("clients", "Clients & engagements", counts.unreadTotal)}
      ${link("drafts", "AI drafts", counts.review)}
      ${link("questionnaires", "Questionnaires")}
      <h4>Help</h4>
      <a href="https://github.com/michaelefurth/Sypher/blob/HEAD/docs/client-portal.md" target="_blank" rel="noopener">Setup guide</a>
    </nav>
    <div class="admin__main">${body}</div>
  </div>`;
}

async function counts() {
  const [drafts, inquiries, proposals, unread] = await Promise.all([store.drafts(), store.inquiries(), store.proposals(), store.unreadCounts(session.user.id)]);
  return {
    unread, unreadTotal: Object.values(unread).reduce((a, b) => a + b, 0),
    review: drafts.filter((d) => d.status === "awaiting_review").length, drafts,
    inquiries: inquiries.filter((i) => i.status === "new").length, inquiryList: inquiries,
    accepted: proposals.filter((p) => p.status === "accepted" && !p.engagement_id).length, proposalList: proposals,
  };
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
  const fresh = c.inquiryList.filter((i) => i.status === "new");
  const signed = c.proposalList.filter((p) => p.status === "accepted" && !p.engagement_id);
  const live = c.proposalList.filter((p) => ["sent", "viewed"].includes(p.status));
  const unreadEngs = engagements.filter((e) => c.unread[e.id]);
  return title(`Good to see you, <em class="italic accent">Michael.</em>`, "What needs your attention across every engagement.") + `
    <div class="stat-row">
      <div class="stat"><b>${engagements.filter((e) => e.status === "active").length}</b><span>Active engagements</span></div>
      <div class="stat stat--gold"><b>${fresh.length}</b><span>New inquiries</span></div>
      <div class="stat"><b>${live.length}</b><span>Proposals out</span></div>
      <div class="stat stat--gold"><b>${c.unreadTotal}</b><span>Unread messages</span></div>
      <div class="stat stat--gold"><b>${review.length}</b><span>Drafts to review</span></div>
    </div>
    <div class="p-grid">
      <section class="p-card p-card--accent"><p class="p-kicker">Needs your attention</p>
        ${review.length || submitted.length || fresh.length || signed.length || unreadEngs.length ? `<ul class="p-list">
          ${unreadEngs.map((e) => `<li class="p-row"><div><h2 class="p-item">${c.unread[e.id]} new message${c.unread[e.id] > 1 ? "s" : ""}: ${esc(e.client.full_name || e.client.email)}</h2><p class="p-muted">${esc(e.title)}</p></div><a class="btn btn--navy btn--sm" href="#engagement=${esc(e.id)}">Reply</a></li>`).join("")}
          ${signed.map((p) => `<li class="p-row"><div><h2 class="p-item">Signed: ${esc(p.company || p.client_name || p.title)}</h2><p class="p-muted">${esc(p.title)} · ${esc(relTime(p.responded_at))}</p></div><a class="btn btn--navy btn--sm" href="#proposal=${esc(p.id)}">Open engagement</a></li>`).join("")}
          ${fresh.map((i) => `<li class="p-row"><div><h2 class="p-item">New diagnostic: ${esc(i.company || i.name)}</h2><p class="p-muted">${esc(i.practices.join(", "))} · ${esc(relTime(i.created_at))}</p></div><a class="btn btn--ghost btn--sm" href="#inquiry=${esc(i.id)}">Read the brief</a></li>`).join("")}
          ${review.map((d) => `<li class="p-row"><div><h2 class="p-item">Draft ready: ${esc(engTitle(d.engagement_id))}</h2><p class="p-muted">${esc(relTime(d.created_at))}</p></div><a class="btn btn--navy btn--sm" href="#draft=${esc(d.id)}">Review draft</a></li>`).join("")}
          ${submitted.map((a) => `<li class="p-row"><div><h2 class="p-item">${esc(a.questionnaire?.title)}</h2><p class="p-muted">${esc(a.engagement.title)} · submitted ${esc(relTime(a.submitted_at))}</p></div><a class="btn btn--ghost btn--sm" href="#responses=${esc(a.id)}">View answers</a></li>`).join("")}
        </ul>` : `<p class="p-empty">You're all caught up.</p>`}
      </section>
      <section class="p-card"><p class="p-kicker">Recent activity</p>
        ${activity.length ? `<ul class="p-list">${activity.slice(0, 12).map((a) => `<li><strong>${esc(activityLabel(a))}</strong><p class="p-muted">${a.engagement_id ? `${esc(engTitle(a.engagement_id))} · ` : a.detail?.title ? `${esc(a.detail.title)} · ` : ""}${esc(relTime(a.created_at))}</p></li>`).join("")}</ul>` : `<p class="p-muted">No activity yet.</p>`}
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
          <p class="p-muted">They'll receive a secure link to set up their access.</p>
        </form></section>
    </div>`;
}

async function viewEngagement(id, tab = "today") {
  const [eng, assignments, drafts, pubs, questionnaires, activity, milestones, decisions, messages, actions, deliverables, roster, teamMessages, teamFiles] = await Promise.all([
    store.engagement(id), store.assignmentsFor(id), store.drafts(id), store.publications(id), store.questionnaires(), store.activity(id),
    store.milestones(id), store.decisions(id), store.messages(id), store.actionItems(id), store.deliverables(id),
    store.roster(id).catch(() => null), store.messages(id, "team"), store.teamFiles(id).catch(() => []),
  ]);
  const [requestFiles, sheets, budgetRows] = await Promise.all([store.requestFiles(id).catch(() => []), store.sovSheets(id).catch(() => []), store.sovBudget(id).catch(() => [])]);
  const sheetLines = await Promise.all(sheets.map((x) => store.sovLines(x.id).catch(() => [])));
  const models = await store.pmModels(id).catch(() => []);
  const inbox = await store.inboxDocuments(id).catch(() => []);
  window.__inbox = inbox;
  const summaries = await Promise.all(models.map((m) => modelSummary(m.id).catch(() => null)));
  const owners = await store.omModels(id).catch(() => []);
  const [invoices, billing] = await Promise.all([store.invoices(id).catch(() => []), tab === "billing" ? store.billingProfile(eng.client_id).catch(() => null) : null]);
  const ownerSums = await Promise.all(owners.map((m) => ownerSummary(m.id).catch(() => null)));
  const budget = budgetRows.length ? new Map(budgetRows.map((b) => [b.line_id, b])) : null;
  window.__team = { roster, teamFiles };
  const members = roster?.members || [];
  const activeMembers = members.filter((m) => m.status === "active");
  const who = (uid) => uid === session.user.id ? "You" : uid === eng.client_id ? (eng.client?.full_name || "Client") : (members.find((m) => m.user_id === uid)?.name || "Former member");
  const whoRole = (uid) => { const m = members.find((x) => x.user_id === uid); return m ? [m.role_label, m.organization].filter(Boolean).join(", ") : ""; };
  const assignee = (a) => (a.assignee_id ? who(a.assignee_id) : (eng.client?.full_name || "Client"));
  const accessText = (m) => m.status === "revoked" ? "Access removed" : m.status === "expired" ? `Ended ${fmtDate(m.expires_at, { month: "short", day: "numeric" })}` : m.expires_at ? `Until ${fmtDate(m.expires_at, { month: "short", day: "numeric", year: "numeric" })}` : "Until the engagement ends";
  if (tab === "today" && messages.some((m) => m.author_id !== session.user.id && !m.read_at)) store.markRead(id).catch(() => {});
  const clientName = (eng.client?.full_name || "").split(" ")[0] || "Client";
  const msName = new Map(milestones.map((m) => [m.id, m.title]));
  const localDT = (v) => { if (!v) return ""; const d = new Date(v); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const client = eng.client || {};
  const unreadMsgs = messages.filter((m) => m.author_id !== session.user.id && !m.read_at).length;
  const toReview = actions.filter((a) => a.status === "submitted").length;
  const draftsToReview = drafts.filter((d) => d.status === "awaiting_review").length;
  const thread = (list, domId, nameFor) => `<ol class="thread admin-thread" id="${domId}">${list.map((m) => {
    const mine = m.author_id === session.user.id;
    return `<li class="msg${mine ? " msg--mine" : ""}"><div class="msg__bubble"><p class="msg__who">${mine ? "You" : esc(nameFor(m.author_id))}${!mine && whoRole(m.author_id) ? `<span class="msg__role">${esc(whoRole(m.author_id))}</span>` : ""}<time datetime="${esc(m.created_at)}">${esc(fmtDate(m.created_at, { month: "short", day: "numeric" }))} ${esc(new Date(m.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</time></p><div class="msg__body">${paragraphs(m.body)}</div>${mine && domId === "thread" ? `<p class="msg__who" style="margin:.4rem 0 0">${m.read_at ? "Read" : "Not read yet"}</p>` : ""}</div></li>`;
  }).join("")}</ol>`;
  const disclosure = (label, inner, open = false) => `<details class="room-add"${open ? " open" : ""}><summary class="p-linkbtn">${label}</summary>${inner}</details>`;
  const docRow = (d) => `<li class="doc">
    <span class="doc__icon" aria-hidden="true">${esc((d.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</span>
    <div class="doc__body"><p class="doc__title">${fileLabel(d.title)}${d.shared_with_team ? ` <span class="pill pill--teal">Team can see</span>` : ""}</p>${d.note ? `<p class="doc__note">${esc(d.note)}</p>` : ""}
      <p class="doc__meta">${d.milestone_id && msName.has(d.milestone_id) ? `${esc(msName.get(d.milestone_id))} · ` : ""}${esc(fmtDate(d.created_at, { month: "short", day: "numeric" }))}${d.size ? ` · ${esc(fmtSize(d.size))}` : ""}</p></div>
    <div class="btn-row" style="gap:.5rem 1rem"><button class="p-linkbtn" data-open-file="${esc(d.path)}">Open</button>${members.length ? `<button class="p-linkbtn" data-deliverable-share="${esc(d.id)}" data-share="${d.shared_with_team ? "0" : "1"}">${d.shared_with_team ? "Unshare" : "Share with team"}</button>` : ""}<button class="p-linkbtn" data-deliverable-delete="${esc(d.id)}">Remove</button></div></li>`;

  /* ------------------------------------------------------------ the cards */
  const cards = {
    messages: () => `<section class="p-card p-card--accent" id="messages"><div class="p-row"><p class="p-kicker">Private messages</p><span class="p-muted">${messages.length ? `${messages.length} in the thread` : ""}</span></div>
      ${messages.length ? thread(messages, "thread", () => clientName) : `<p class="p-muted">No messages yet. The client can write to you from their room; you're emailed when they do.</p>`}
      <form class="p-form" id="msg-form"><label class="visually-hidden" for="msg-body">Reply to ${esc(clientName)}</label>
        <textarea class="p-textarea" id="msg-body" name="body" rows="3" maxlength="8000" placeholder="Write to ${esc(clientName)}…" required></textarea>
        <div class="p-row"><span class="p-muted">They're emailed a link to read it.</span><button class="btn btn--navy btn--sm" type="submit">Send</button></div>
      </form>
    </section>`,
    requests: () => `<section class="p-card" id="requests"><div class="p-row"><p class="p-kicker">Requests</p><span class="p-muted">${toReview ? `${toReview} to review` : actions.length ? `${actions.filter((a) => a.status !== "accepted").length} open` : ""}</span></div>
      ${actions.length ? `<ul class="req-list req-list--admin">${actions.map((a) => {
        const files = requestFiles.filter((f) => f.request_id === a.id);
        const [sl, sc] = REQ_STATUS[a.status] || [a.status, ""];
        return `<li class="req req--${esc(a.kind)} is-${esc(a.status)}">
          <div class="req__head"><span class="req__kind">${esc(KIND[a.kind] || a.kind)}</span><h3 class="req__title">${esc(a.title)}</h3><span class="pill pill--dot ${sc}">${esc(sl)}</span></div>
          <p class="req__meta"><span>${esc(a.created_by ? who(a.created_by) : "You")} → ${esc(assignee(a))}</span>${a.due_date && a.status !== "accepted" ? `<span>Due ${esc(fmtDate(a.due_date, { month: "short", day: "numeric" }))}</span>` : ""}${a.submitted_at ? `<span>Answered ${esc(relTime(a.submitted_at))}</span>` : ""}</p>
          ${a.detail ? `<p class="req__detail">${esc(a.detail)}</p>` : ""}
          ${a.response ? `<div class="req__answer"><b>${esc(a.submitted_by ? who(a.submitted_by) : "Answer")}</b>${paragraphs(a.response)}</div>` : ""}
          ${a.review_note ? `<p class="req__meta">Review note: ${esc(a.review_note)}</p>` : ""}
          ${files.length ? `<ul class="req__files">${files.map((f) => `<li><button type="button" class="req__file" data-open-file="${esc(f.path)}"><span aria-hidden="true">${esc((f.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</span>${fileLabel(f.name)} <small>${esc(who(f.uploaded_by))}</small></button></li>`).join("")}</ul>` : ""}
          <div class="req__actions">
            ${a.status === "submitted" && a.kind !== "pricing" ? `<button class="btn btn--ghost btn--sm" data-req-review="changes" data-req="${esc(a.id)}">Ask for changes</button><button class="btn btn--navy btn--sm" data-req-review="accept" data-req="${esc(a.id)}">Accept</button>` : ""}
            ${a.kind === "pricing" && a.link_ref ? `<a class="p-linkbtn" href="pricing.html?s=${esc(a.link_ref)}">Open the sheet</a>` : ""}
            ${a.link_kind === "pm_input" && models.length ? `<a class="p-linkbtn" href="project.html?m=${esc(models[0].id)}">Open the model</a>` : ""}
            ${["om_input", "om_finding"].includes(a.link_kind) && owners.length ? `<a class="p-linkbtn" href="owner.html?m=${esc(owners[0].id)}">Open the owner model</a>` : ""}
            ${a.status !== "accepted" && a.kind !== "pricing" && !["pm_input", "om_input"].includes(a.link_kind) ? `<button class="p-linkbtn" data-req-answer="${esc(a.id)}">Answer for them</button>` : ""}
            <button class="p-linkbtn" data-action-delete="${esc(a.id)}">Remove</button></div></li>`;
      }).join("")}</ul>` : `<p class="p-muted">Ask the client or anyone on the team for a document, an answer, an approval or a to-do. They answer in the portal with a note and files, and you accept it or send it back. Anyone on the engagement can ask you, too.</p>`}
      ${disclosure("Ask for something", `<form class="p-form p-form--2" id="action-form">
        <div class="p-field"><label for="ac-kind">Kind</label><select class="p-select" id="ac-kind" name="kind"><option value="document">Document or file</option><option value="answer">Answer to a question</option><option value="approval">Approval</option><option value="task">To-do</option></select></div>
        <div class="p-field"><label for="ac-who">From</label><select class="p-select" id="ac-who" name="assignee_id"><option value="">${esc(eng.client?.full_name || "The client")} (client)</option>${activeMembers.map((m) => `<option value="${esc(m.user_id)}">${esc(m.name)}${m.role_label ? ` (${esc(m.role_label)})` : ""}</option>`).join("")}</select></div>
        <div class="p-field p-span"><label for="ac-title">What's needed</label><input class="p-input" id="ac-title" name="title" required placeholder="e.g. Send the last 12 months of bank statements"></div>
        <div class="p-field"><label for="ac-detail">Detail (optional)</label><input class="p-input" id="ac-detail" name="detail"></div>
        <div class="p-field"><label for="ac-due">Due</label><input class="p-input" id="ac-due" name="due_date" type="date"></div>
        <div class="p-span p-row"><label class="p-check p-check--inline"><input type="checkbox" name="notify" checked> Email them</label><button class="btn btn--ghost btn--sm" type="submit">Send request</button></div>
      </form>`)}
    </section>`,
    activity: (limit = 8) => `<section class="p-card"><div class="p-row"><p class="p-kicker">Activity</p>${activity.length > limit ? `<a class="p-linkbtn" href="#engagement=${esc(id)}/plan">All activity</a>` : ""}</div>
      ${activity.length ? `<ul class="p-list">${activity.slice(0, limit).map((a) => `<li><strong>${esc(activityLabel(a))}</strong><p class="p-muted">${esc(relTime(a.created_at))}</p></li>`).join("")}</ul>` : `<p class="p-muted">No activity yet.</p>`}
    </section>`,
    project: () => `<section class="p-card p-card--navy" id="project"><p class="p-kicker">Project model</p>
      ${models.length ? `<ul class="pm-adminlist">${models.map((m, i) => { const r = summaries[i]?.result; const open = summaries[i]?.inputs.filter((x) => x.status !== "confirmed").length ?? 0; return `<li>
        <div class="p-row"><a class="link-on-dark" href="project.html?m=${esc(m.id)}"><b>${esc(m.title)}</b></a>${r ? `<span>${money(r.total)}</span>` : ""}</div>
        ${r ? `<p class="pm-adminlist__figs">Loan ${money(r.loan)} · equity ${money(r.equity)} · coverage yr 2 ${r.years[1].dscr == null ? "—" : `${r.years[1].dscr.toFixed(2)}×`} · ${open} open assumption${open === 1 ? "" : "s"}</p>` : ""}
        <div class="btn-row" style="gap:.5rem 1rem"><a class="btn btn--gold btn--sm" href="project.html?m=${esc(m.id)}">Open the model</a></div></li>`; }).join("")}</ul>`
        : `<p style="color:var(--on-dark-muted)">One place for the whole project: land, the contractor's pricing (linked live), contingency, soft and opening costs, the loan, equity, monthly draws, interest during construction, and coverage after opening. Advisers you give access to can confirm figures and comment.</p>`}
      <details class="room-add"><summary class="p-linkbtn" style="color:var(--champagne)">New project model</summary>
        <form class="p-form p-form--2" id="model-form">
          <div class="p-field p-span"><label for="pm-title" style="color:var(--on-dark-muted)">Title</label><input class="p-input" id="pm-title" name="title" required placeholder="e.g. Phase 1 restaurant: total cost and financing"></div>
          <div class="p-field"><label for="pm-sheet" style="color:var(--on-dark-muted)">Hard costs from</label><select class="p-select" id="pm-sheet" name="sheet"><option value="">No pricing sheet</option>${sheets.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join("")}</select></div>
          <div class="p-field"><label for="pm-sf" style="color:var(--on-dark-muted)">Building area (SF)</label><input class="p-input" id="pm-sf" name="sf" inputmode="decimal"></div>
          <div class="p-span"><button class="btn btn--gold btn--sm" type="submit">Create the model</button></div>
        </form></details>
    </section>`,
    owner: () => `<section class="p-card p-card--navy" id="owner"><p class="p-kicker">Owner model</p>
      ${owners.length ? `<ul class="pm-adminlist">${owners.map((m, i) => { const r = ownerSums[i]?.result; const open = ownerSums[i]?.inputs.filter((x) => x.status !== "confirmed").length ?? 0; return `<li>
        <div class="p-row"><a class="link-on-dark" href="owner.html?m=${esc(m.id)}"><b>${esc(m.title)}</b></a>${r?.global.cfads != null ? `<span>${money(r.global.cfads)} recurring</span>` : ""}</div>
        ${r ? `<p class="pm-adminlist__figs">Coverage ${r.global.dscr == null ? "—" : `${r.global.dscr.toFixed(2)}×`}${r.global.withProject ? ` · with the project ${r.global.withProject.dscr.toFixed(2)}×` : ""} · cost segregation ${money(r.seg.usable)} usable (${money(r.seg.taxSaved)} tax) · ${r.findings.open} open finding${r.findings.open === 1 ? "" : "s"} · ${open} open assumption${open === 1 ? "" : "s"}</p>` : ""}
        <div class="btn-row" style="gap:.5rem 1rem"><a class="btn btn--gold btn--sm" href="owner.html?m=${esc(m.id)}">Open the owner model</a></div></li>`; }).join("")}</ul>`
        : `<p style="color:var(--on-dark-muted)">The owner's businesses, properties and taxes in one place: the books by year beside the filed returns, the adjustments that normalize cash flow and explain the book-to-tax gap, each property's depreciation as filed and with a cost segregation study, the owner's tax estimate, global coverage of existing and new debt, and a findings register with who resolves what. The same people see it as the project model.</p>`}
      <details class="room-add"><summary class="p-linkbtn" style="color:var(--champagne)">New owner model</summary>
        <form class="p-form p-form--2" id="owner-form">
          <div class="p-field p-span"><label for="om-title" style="color:var(--on-dark-muted)">Title</label><input class="p-input" id="om-title" name="title" required placeholder="e.g. Books, taxes and properties: 2024 to 2026"></div>
          <div class="p-field"><label for="om-owner" style="color:var(--on-dark-muted)">Owner's name</label><input class="p-input" id="om-owner" name="owner_name" value="${esc(eng.client?.full_name || "")}"></div>
          <div class="p-field"><label for="om-pm" style="color:var(--on-dark-muted)">Project model for coverage</label><select class="p-select" id="om-pm" name="pm_model_id"><option value="">None</option>${models.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join("")}</select></div>
          <div class="p-field p-span"><label for="om-entities" style="color:var(--on-dark-muted)">Entities (one per line, as “Name | kind”: smllc, sole_prop, partnership, s_corp, c_corp, rental)</label><textarea class="p-textarea" id="om-entities" name="entities" rows="3" placeholder="${esc(eng.client?.company || "The business")} | smllc"></textarea></div>
          <div class="p-span"><button class="btn btn--gold btn--sm" type="submit">Create the owner model</button> <span style="color:var(--on-dark-muted)">It starts with the standard assumptions and the fifteen standard forensic findings.</span></div>
        </form></details>
    </section>`,
    pricing: () => `<section class="p-card p-card--accent" id="pricing"><p class="p-kicker">Pricing (schedule of values)</p>
      ${sheets.length ? `<ul class="price-list">${sheets.map((x, i) => {
        const t = sovTotals(x, sheetLines[i], budget);
        return `<li><div class="p-row"><a class="price-list__title" href="pricing.html?s=${esc(x.id)}">${esc(x.title)}</a>${sheetPill(x.status)}</div>
          <p class="p-muted">${x.contractor_id ? esc(who(x.contractor_id)) : "No contractor"} · ${t.answered} of ${t.count} lines · ${money(t.total)}${t.budget ? ` · budget ${money(t.budget.base)}${t.budget.pricedBudget ? ` (priced lines <span class="${t.budget.variance > 0 ? "is-over" : "is-under"}">${t.budget.variance > 0 ? "+" : "−"}${money(Math.abs(t.budget.variance))}</span>)` : ""}` : ""}${x.version ? ` · v${x.version}` : ""}</p>
          <div class="btn-row" style="gap:.5rem 1rem"><a class="btn btn--ghost btn--sm" href="pricing.html?s=${esc(x.id)}">Open the sheet</a></div></li>`;
      }).join("")}</ul>` : `<p class="p-muted">A schedule of values the contractor prices line by line, with autosave. You and the client see each line beside the budget; the contractor never sees the budget.</p>`}
      <details class="room-add"><summary class="p-linkbtn">New pricing sheet</summary>
        <form class="p-form p-form--2" id="sheet-form">
          <div class="p-field p-span"><label for="sh-title">Title</label><input class="p-input" id="sh-title" name="title" required placeholder="e.g. Building and site: contractor pricing"></div>
          <div class="p-field"><label for="sh-who">Contractor</label><select class="p-select" id="sh-who" name="contractor_id"><option value="">None yet (I'll key it in)</option>${activeMembers.map((m) => `<option value="${esc(m.user_id)}">${esc(m.name)}${m.role_label ? ` (${esc(m.role_label)})` : ""}</option>`).join("")}</select></div>
          <div class="p-field"><label for="sh-due">Due</label><input class="p-input" id="sh-due" name="due_date" type="date"></div>
          <div class="p-field p-span"><label for="sh-tpl">Start from</label><select class="p-select" id="sh-tpl" name="template">${Object.entries(SOV_TEMPLATES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select></div>
          <div class="p-field p-span"><label for="sh-intro">What you need (shown at the top of the sheet)</label><textarea class="p-textarea" id="sh-intro" name="intro" rows="3" placeholder="The drawings and revision to price from, what to include, when you need it"></textarea></div>
          <div class="p-span p-row"><span class="p-muted">Add the contractor to the team first (People). They're asked and emailed when the sheet is created.</span><button class="btn btn--navy btn--sm" type="submit">Create the sheet</button></div>
        </form></details>
    </section>`,
    deliverables: () => `<section class="p-card"><div class="p-row"><p class="p-kicker">Deliverables</p><span class="p-muted">${deliverables.length ? `${deliverables.length} shared` : ""}</span></div>
      ${deliverables.length ? `<ul class="doc-list">${deliverables.map(docRow).join("")}</ul>` : `<p class="p-muted">Reports, models and documents you share appear in the client's Documents tab, filed by milestone.</p>`}
      ${disclosure("Share a document", `<form class="p-form p-form--2" id="deliverable-form">
        <div class="p-field p-span"><label for="dl-file">File (PDF, Office, CSV, text or image; up to 50 MB)</label><input class="p-input" id="dl-file" name="file" type="file" accept="${FILE_ACCEPT}" required></div>
        <div class="p-field"><label for="dl-title">Title</label><input class="p-input" id="dl-title" name="title" placeholder="e.g. Cash-flow model, v2"></div>
        <div class="p-field"><label for="dl-ms">Milestone</label><select class="p-select" id="dl-ms" name="milestone_id"><option value="">General</option>${milestones.map((m) => `<option value="${esc(m.id)}"${m.status === "current" ? " selected" : ""}>${esc(m.title)}</option>`).join("")}</select></div>
        <div class="p-field p-span"><label for="dl-note">Note for the client (optional)</label><input class="p-input" id="dl-note" name="note" placeholder="What it is and what to look at first"></div>
        <div class="p-span p-row"><span class="room-add__perms"><label class="p-check p-check--inline"><input type="checkbox" name="notify" checked> Email the client</label>${members.length ? `<label class="p-check p-check--inline"><input type="checkbox" name="team"> Team can see it too</label>` : ""}</span><button class="btn btn--navy btn--sm" type="submit">Share with client</button></div>
      </form>`)}
    </section>`,
    teamFiles: () => (teamFiles.length ? `<section class="p-card"><p class="p-kicker">Team files</p><ul class="doc-list">${teamFiles.map((f) => `<li class="doc">
      <span class="doc__icon doc__icon--mine" aria-hidden="true">${esc((f.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</span>
      <div class="doc__body"><p class="doc__title">${fileLabel(f.name)}</p>${f.note ? `<p class="doc__note">${esc(f.note)}</p>` : ""}<p class="doc__meta">${esc(who(f.uploaded_by))} · ${esc(relTime(f.created_at))}${f.size ? ` · ${esc(fmtSize(f.size))}` : ""}</p></div>
      <div class="btn-row" style="gap:.5rem 1rem"><button class="p-linkbtn" data-open-file="${esc(f.path)}">Open</button><button class="p-linkbtn" data-team-file-delete="${esc(f.id)}">Remove</button></div></li>`).join("")}</ul></section>` : ""),
    updates: () => `<section class="p-card"><p class="p-kicker">Published updates</p>
      ${pubs.length ? `<ul class="p-list">${pubs.map((p) => `<li><div class="p-row"><h2 class="p-item">${esc(p.title)}</h2><span class="p-muted">${esc(fmtDate(p.published_at))}</span></div></li>`).join("")}</ul>` : `<p class="p-muted">Nothing published yet. Updates come from the AI drafts below, or you write one here.</p>`}
      ${disclosure("Write an update by hand", `<form class="p-form" id="manual-pub">
        <div class="p-field"><label for="m-title">Title</label><input class="p-input" id="m-title" name="title" required></div>
        <div class="p-field"><label for="m-body">Message</label><textarea class="p-textarea" id="m-body" name="body" rows="6" required></textarea></div>
        <button class="btn btn--navy btn--sm" type="submit">Publish to client</button>
      </form>`)}
    </section>`,
    drafts: () => `<section class="p-card"><div class="p-row"><p class="p-kicker">AI drafts</p>${draftsToReview ? `<span class="pill pill--gold">${draftsToReview} to review</span>` : ""}</div>
      ${drafts.length ? `<ul class="p-list">${drafts.map((d) => `<li class="p-row"><div>${statusPill(d.status)} <span class="p-muted">${esc(relTime(d.created_at))}</span>${d.error ? `<p class="p-muted">${esc(d.error)}</p>` : ""}</div>${d.status === "awaiting_review" || d.status === "published" || d.status === "dismissed" ? `<a class="p-linkbtn" href="#draft=${esc(d.id)}">Open</a>` : ""}</li>`).join("")}</ul>` : `<p class="p-muted">A draft is generated automatically when the client submits a questionnaire.</p>`}
    </section>`,
    milestonesManage: () => `<section class="p-card"><p class="p-kicker">Milestones</p>
      ${milestones.length ? `<ul class="p-list">${milestones.map((m) => `<li class="p-row"><div><strong>${esc(m.title)}</strong><br><span class="p-muted">${esc(m.due_label || "")}</span></div>
        <div class="btn-row" style="gap:.5rem"><select class="p-select p-select--sm" data-ms-status="${esc(m.id)}" aria-label="Status of ${esc(m.title)}">${MS_STATUS.map(([v, l]) => `<option value="${v}"${m.status === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <button class="p-linkbtn" data-ms-delete="${esc(m.id)}">Remove</button></div></li>`).join("")}</ul>` : `<p class="p-muted">No milestones yet. The client sees them as the plan, with the documents each one produced.</p>`}
      ${disclosure("Add a milestone", `<form class="p-form p-form--2" id="ms-form">
        <div class="p-field"><label for="ms-title">Milestone</label><input class="p-input" id="ms-title" name="title" required></div>
        <div class="p-field"><label for="ms-when">When</label><input class="p-input" id="ms-when" name="due_label" placeholder="Week 6"></div>
        <div class="p-span"><button class="btn btn--ghost btn--sm" type="submit">Add milestone</button></div>
      </form>`)}
    </section>`,
    decisions: () => `<section class="p-card"><p class="p-kicker">Decision log</p>
      ${decisions.length ? `<ul class="p-list">${decisions.map((d) => `<li><div class="p-row"><strong>${esc(d.decision)}</strong><button class="p-linkbtn" data-dec-delete="${esc(d.id)}">Remove</button></div><p class="p-muted">${esc(fmtDate(d.decided_on))}${d.owner ? ` · ${esc(d.owner)}` : ""}${d.rationale ? ` · ${esc(d.rationale)}` : ""}</p></li>`).join("")}</ul>` : `<p class="p-muted">Record decisions as they’re made. The client sees them with the reasons.</p>`}
      ${disclosure("Record a decision", `<form class="p-form" id="dec-form">
        <div class="p-field"><label for="dec-what">Decision</label><input class="p-input" id="dec-what" name="decision" required></div>
        <div class="p-field"><label for="dec-why">Why</label><textarea class="p-textarea" id="dec-why" name="rationale" rows="2"></textarea></div>
        <div class="p-form p-form--2"><div class="p-field"><label for="dec-owner">Owner</label><input class="p-input" id="dec-owner" name="owner"></div>
        <div class="p-field"><label for="dec-date">Date</label><input class="p-input" id="dec-date" name="decided_on" type="date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
        <button class="btn btn--ghost btn--sm" type="submit">Record decision</button>
      </form>`)}
    </section>`,
    context: () => `<section class="p-card p-card--accent"><p class="p-kicker">Report context for the AI</p>
      <p class="p-muted">Private to you. Paste the report's key assumptions, figures and conclusions. Claude compares each answer against this to propose section updates.</p>
      <form class="p-form" id="context-form">
        <textarea class="p-textarea" name="report_context" rows="12" aria-label="Report context for the AI">${esc(eng.report_context || "")}</textarea>
        <div class="p-field"><label for="e-summary">Summary the client sees</label><textarea class="p-textarea" id="e-summary" name="summary" rows="3">${esc(eng.summary || "")}</textarea></div>
        <button class="btn btn--navy btn--sm" type="submit">Save</button>
      </form></section>`,
    clientCard: () => `<section class="p-card p-card--navy"><p class="p-kicker">The client</p>
      <h3>${esc(client.full_name || client.email || "Client")}</h3>
      <p style="color:var(--on-dark-muted)">${[client.company, client.email, client.phone].filter(Boolean).map(esc).join(" · ")}</p>
      <p style="margin-top:1rem;font-size:.85rem"><a class="link-on-dark" href="dashboard.html">See the client’s view</a> (opens your own room if you have none)</p>
    </section>`,
    team: () => `<section class="p-card" id="team"><div class="p-row"><p class="p-kicker">Team</p><span class="p-muted">${activeMembers.length ? `${activeMembers.length} outside adviser${activeMembers.length > 1 ? "s" : ""}` : ""}</span></div>
      ${members.length ? `<ul class="people">${members.map((m) => `<li class="person${m.status !== "active" ? " is-off" : ""}">
        <span class="msg__avatar msg__avatar--initials" aria-hidden="true">${esc((m.name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase())}</span>
        <div class="person__body"><p class="person__name">${esc(m.name)}</p><p class="person__role">${esc([m.role_label, m.organization, m.email].filter(Boolean).join(" · "))}</p>
          <p class="person__access">${esc(accessText(m))} · ${[m.can_message && "messages", m.can_files && "files", m.can_model && "project model", "requests"].filter(Boolean).join(", ")}${m.last_seen_at ? ` · last in ${esc(relTime(m.last_seen_at))}` : m.status === "active" ? " · not signed in yet" : ""}</p></div>
        <div class="btn-row" style="gap:.4rem 1rem;flex-direction:column;align-items:flex-end">
          ${m.status === "active" && (models.length || owners.length) && !sheets.some((x) => x.contractor_id === m.user_id) ? `<button class="p-linkbtn" data-member-model="${esc(m.id)}" data-allow="${m.can_model ? "0" : "1"}">${m.can_model ? "Remove model access" : "Give model access"}</button>` : ""}
          ${m.status === "active" ? `<button class="p-linkbtn" data-member-extend="${esc(m.id)}">+30 days</button><button class="p-linkbtn p-linkbtn--danger" data-member-revoke="${esc(m.id)}">Remove</button>` : `<button class="p-linkbtn" data-member-restore="${esc(m.id)}">Restore 30 days</button>`}
        </div></li>`).join("")}</ul>` : `<p class="p-muted">Nobody outside yet. The client can add their attorney, CPA or lender from their room, or you can add them here. Members see only the team thread, team files and their tasks.</p>`}
      ${disclosure("Add someone", `<form class="p-form p-form--2" id="member-form">
        <div class="p-field"><label for="mb-name">Name</label><input class="p-input" id="mb-name" name="full_name" required></div>
        <div class="p-field"><label for="mb-email">Email</label><input class="p-input" id="mb-email" name="email" type="email" required></div>
        <div class="p-field"><label for="mb-role">Role</label><input class="p-input" id="mb-role" name="role_label" placeholder="Attorney, CPA, Lender…"></div>
        <div class="p-field"><label for="mb-org">Firm</label><input class="p-input" id="mb-org" name="organization"></div>
        <div class="p-field"><label for="mb-len">Access</label><select class="p-select" id="mb-len" name="length"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="">Until the engagement ends</option></select></div>
        <div class="p-field room-add__perms" style="align-self:end"><label class="p-check"><input type="checkbox" name="can_message" checked> Messages</label><label class="p-check"><input type="checkbox" name="can_files" checked> Files</label></div>
        <div class="p-span"><button class="btn btn--navy btn--sm" type="submit">Send invitation</button></div>
      </form>`)}
    </section>`,
    teamThread: () => `<section class="p-card"><p class="p-kicker">Team thread</p>
      ${teamMessages.length ? thread(teamMessages, "team-thread", who) : `<p class="p-muted">${members.length ? "No team messages yet." : "Appears once someone is on the team."}</p>`}
      ${members.length ? `<form class="p-form" id="team-msg-form"><label class="visually-hidden" for="team-msg-body">Write to the team</label>
        <textarea class="p-textarea" id="team-msg-body" name="body" rows="2" maxlength="8000" placeholder="Write to the whole team…" required></textarea>
        <div class="p-row"><span class="p-muted">Everyone on the team who can message is emailed a link.</span><button class="btn btn--ghost btn--sm" type="submit">Send to team</button></div></form>` : ""}
    </section>`,
    questionnaires: () => `<section class="p-card"><p class="p-kicker">Questionnaires</p>
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
      </tbody></table></div>` : `<p class="p-muted">No questionnaires assigned yet.</p>`}
      ${disclosure("Assign a questionnaire", `<form class="p-form p-form--2" id="assign-form">
        <div class="p-field p-span"><label for="a-q">Questionnaire</label>
          <select class="p-select" id="a-q" name="questionnaire" required>${questionnaires.map((q) => `<option value="${esc(q.id)}">${esc(q.title)} (${q.count} questions)</option>`).join("")}</select></div>
        <div class="p-field"><label for="a-due">Due date</label><input class="p-input" id="a-due" name="due" type="date"></div>
        <div class="p-field p-span"><label for="a-msg">Note to the client</label><textarea class="p-textarea" id="a-msg" name="message" rows="2" placeholder="Shown at the top of the questionnaire"></textarea></div>
        <div class="p-span"><button class="btn btn--navy btn--sm" type="submit" ${questionnaires.length ? "" : "disabled"}>Assign</button></div>
      </form>`)}
    </section>`,
    remove: () => (models.length || owners.length || sheets.length ? `<section class="p-card"><p class="p-kicker">Models and sheets</p>
      <p class="p-muted">Deleting is permanent. The project model keeps its pricing sheet; the owner model keeps its project model.</p>
      <ul class="p-list">${models.map((m) => `<li class="p-row"><span>Project model: <strong>${esc(m.title)}</strong></span><button class="p-linkbtn p-linkbtn--danger" data-model-delete="${esc(m.id)}">Delete</button></li>`).join("")}
        ${owners.map((m) => `<li class="p-row"><span>Owner model: <strong>${esc(m.title)}</strong></span><button class="p-linkbtn p-linkbtn--danger" data-owner-delete="${esc(m.id)}">Delete</button></li>`).join("")}
        ${sheets.map((x) => `<li class="p-row"><span>Pricing sheet: <strong>${esc(x.title)}</strong></span><button class="p-linkbtn p-linkbtn--danger" data-sheet-delete="${esc(x.id)}">Delete</button></li>`).join("")}</ul>
    </section>` : ""),
    closeout: () => `<section class="p-card closeout"><p class="p-kicker">Close out</p>
      <p class="p-muted">When the work is done, mark it complete: the client keeps read access and outside team members lose theirs. To remove the client's data entirely, export it first, then delete.</p>
      <div class="btn-row" style="gap:.75rem 1.25rem;margin-top:1rem">
        ${eng.status === "active" ? `<button class="btn btn--ghost btn--sm" data-eng-status="complete">Mark complete</button>` : `<button class="btn btn--ghost btn--sm" data-eng-status="active">Reopen</button>`}
        <button class="p-linkbtn" data-eng-export>Export everything (JSON)</button>
        <button class="p-linkbtn p-linkbtn--danger" data-eng-delete>Delete engagement and files</button>
      </div>
    </section>`,
  };

  /* ---------------------------------------------- beside every tab */
  const next = eng.next_meeting_at ? new Date(eng.next_meeting_at) : null;
  const side = `
    <section class="p-card p-card--navy"><p class="p-kicker">${next && next.getTime() < Date.now() ? "Last conversation" : "Next conversation"}</p>
      ${next ? `<h3>${esc(fmtDate(eng.next_meeting_at, { weekday: "long", month: "long", day: "numeric" }))}</h3><p style="color:var(--on-dark-muted)">${esc(next.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}${eng.next_meeting_note ? ` · ${esc(eng.next_meeting_note)}` : ""}${eng.meeting_link ? ` · <a class="link-on-dark" href="${esc(eng.meeting_link)}" target="_blank" rel="noopener">Video link</a>` : ""}</p>` : `<p style="color:var(--on-dark-muted)">Not scheduled. The client sees “not scheduled yet” and can suggest a time.</p>`}
      <details class="room-add"><summary class="p-linkbtn" style="color:var(--champagne)">${next ? "Change" : "Schedule"}</summary>
        <form class="p-form" id="room-form">
          <div class="p-field"><label for="r-meet" style="color:var(--on-dark-muted)">When</label><input class="p-input" id="r-meet" name="next_meeting_at" type="datetime-local" value="${esc(localDT(eng.next_meeting_at))}"></div>
          <div class="p-field"><label for="r-note" style="color:var(--on-dark-muted)">Agenda the client sees</label><textarea class="p-textarea" id="r-note" name="next_meeting_note" rows="2">${esc(eng.next_meeting_note || "")}</textarea></div>
          <div class="p-field"><label for="r-link" style="color:var(--on-dark-muted)">Video link (https)</label><input class="p-input" id="r-link" name="meeting_link" type="url" value="${esc(eng.meeting_link || "")}"></div>
          <div class="p-field"><label for="r-kick" style="color:var(--on-dark-muted)">Engagement began</label><input class="p-input" id="r-kick" name="kickoff_date" type="date" value="${esc(eng.kickoff_date || "")}"></div>
          <button class="btn btn--gold btn--sm" type="submit">Save</button>
        </form></details>
    </section>
    ${tab === "plan" ? "" : `<section class="p-card"><div class="p-row"><p class="p-kicker">Milestones</p><span class="p-muted">${milestones.length ? `${milestones.filter((m) => m.status === "done").length} of ${milestones.length} done` : ""}</span></div>
      ${milestones.length ? `<ul class="p-list admin-ms">${milestones.map((m) => `<li class="p-row"><div><strong>${esc(m.title)}</strong>${m.due_label ? `<br><span class="p-muted">${esc(m.due_label)}</span>` : ""}</div>
        <select class="p-select p-select--sm" data-ms-status="${esc(m.id)}" aria-label="Status of ${esc(m.title)}">${MS_STATUS.map(([v, l]) => `<option value="${v}"${m.status === v ? " selected" : ""}>${l}</option>`).join("")}</select></li>`).join("")}</ul>` : `<p class="p-muted">No milestones yet.</p>`}
      <p style="margin-top:.75rem"><a class="p-linkbtn" href="#engagement=${esc(id)}/plan">${milestones.length ? "Manage the plan" : "Add milestones"}</a></p>
    </section>`}`;

  const invLine = (i) => `<div class="inv-line">
      <div class="p-field"><label for="il-d${i}">Line ${i + 1}${i ? " (optional)" : ""}</label><input class="p-input" id="il-d${i}" name="line_desc_${i}" maxlength="500"${i ? "" : " required"} placeholder="${i ? "" : "e.g. Phase 1 deposit"}"></div>
      <div class="p-field"><label for="il-a${i}">Amount ($)</label><input class="p-input" id="il-a${i}" name="line_amt_${i}" inputmode="decimal" pattern="[0-9,]*(\\.[0-9]{1,2})?"${i ? "" : " required"}></div>
      <div class="p-field"><label for="il-t${i}">Tax category</label><select class="p-select" id="il-t${i}" name="line_tax_${i}">${TAX_CODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div></div>`;
  const invRow = (inv) => {
    const [sl, sc] = INV_STATUS[inv.status] || [inv.status, ""];
    const late = inv.status === "open" && inv.due_date && inv.due_date < new Date().toISOString().slice(0, 10);
    return `<li class="inv${late ? " is-late" : ""}">
      <div class="inv__body"><p class="inv__title">${esc(inv.description || "Invoice")}${inv.number ? ` <span class="p-muted">${esc(inv.number)}</span>` : ""}</p>
        <p class="inv__meta">${esc(INV_KIND[inv.kind] || inv.kind)} · ${usd(inv.total)}${inv.tax ? ` incl. ${usd(inv.tax)} tax` : inv.status !== "draft" ? " · no tax" : ""}
          ${inv.status === "paid" ? ` · paid ${esc(fmtDate(inv.paid_at, { month: "short", day: "numeric", year: "numeric" }))}` : inv.due_date ? ` · <span class="${late ? "is-late" : ""}">${late ? "overdue since" : "due"} ${esc(fmtDate(inv.due_date, { month: "short", day: "numeric", year: "numeric" }))}</span>` : ""}
          ${inv.status === "open" && inv.amount_paid ? ` · ${usd(inv.amount_paid)} paid so far` : ""}${inv.refunded ? ` · ${usd(inv.refunded)} refunded` : ""}${inv.credited ? ` · ${usd(inv.credited)} credited` : ""}</p></div>
      <span class="pill pill--dot ${late ? "pill--red" : sc}">${esc(late ? "Overdue" : sl)}</span>
      ${inv.last_payment_error && inv.status === "open" ? `<p class="inv__err">${esc(inv.last_payment_error)}</p>` : ""}
      <div class="btn-row inv__acts">${inv.hosted_invoice_url ? `<a class="p-linkbtn" href="${esc(inv.hosted_invoice_url)}" target="_blank" rel="noopener">Payment page</a>` : ""}${inv.invoice_pdf ? `<a class="p-linkbtn" href="${esc(inv.invoice_pdf)}" target="_blank" rel="noopener">PDF</a>` : ""}
        <button class="p-linkbtn" data-inv-sync="${esc(inv.id)}">Refresh from Stripe</button>${inv.status === "open" ? `<button class="p-linkbtn" data-inv-void="${esc(inv.id)}">Void</button>` : ""}</div></li>`;
  };
  const b = billing || {};
  const hasAddr = !!(b.line1 && b.city && b.state && b.postal_code);
  const openInv = invoices.filter((x) => x.status === "open");
  cards.invoices = () => `<section class="p-card p-card--accent" id="invoices"><div class="p-row"><p class="p-kicker">Invoices</p><span class="p-muted">${openInv.length ? `${usd(openInv.reduce((a, x) => a + (x.amount_remaining ?? x.total ?? 0), 0))} outstanding` : invoices.length ? "All settled" : ""}</span></div>
      ${invoices.length ? `<ul class="inv-list">${invoices.map(invRow).join("")}</ul>` : `<p class="p-muted">No invoices yet. An invoice is emailed to the client by Stripe with a link to pay by card or bank account, and shows in their Billing tab.</p>`}
      ${disclosure("New invoice", hasAddr ? `<form class="p-form" id="invoice-form">
        <input type="hidden" name="request_id" value="${esc(crypto.randomUUID())}">
        <div class="p-form p-form--2" style="margin:0">
          <div class="p-field"><label for="inv-kind">Kind</label><select class="p-select" id="inv-kind" name="kind">${Object.entries(INV_KIND).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
          <div class="p-field"><label for="inv-days">Due in (days)</label><input class="p-input" id="inv-days" name="days_until_due" type="number" min="0" max="90" value="15"></div>
          <div class="p-field p-span"><label for="inv-desc">Memo on the invoice</label><input class="p-input" id="inv-desc" name="description" maxlength="300" value="${esc(eng.title)}"></div>
        </div>
        <div class="inv-lines">${[0, 1, 2].map(invLine).join("")}</div>
        <div class="p-row"><span class="inv-total" id="inv-total">Sales tax is added by Stripe Tax from ${esc(clientName)}'s address.</span><button class="btn btn--navy btn--sm" type="submit">Create and send</button></div>
      </form>` : `<p class="p-muted">Add ${esc(clientName)}'s billing address first: Stripe Tax needs it to work out sales tax.</p>`, !invoices.length && hasAddr)}
    </section>`;
  cards.billingAddress = () => `<section class="p-card" id="billing-address"><p class="p-kicker">Billing address</p>
      ${hasAddr ? `<p class="bill-addr">${b.billing_name ? `<strong>${esc(b.billing_name)}</strong><br>` : ""}${esc([b.line1, b.line2].filter(Boolean).join(", "))}<br>${esc(`${b.city}, ${b.state} ${b.postal_code}`)}${b.billing_email ? `<br><span class="p-muted">${esc(b.billing_email)}</span>` : ""}</p>
        <p class="p-muted">${b.stripe_customer_id ? `Stripe customer ${esc(b.stripe_customer_id)}` : "Becomes a Stripe customer with the first invoice."}</p>` : `<p class="p-muted">None yet. ${esc(clientName)} can add it in their Billing tab, or you can here.</p>`}
      ${disclosure(hasAddr ? "Change it" : "Add it", `<form class="p-form p-form--2" id="billing-admin-form">
        <div class="p-field p-span"><label for="ba-name">Name or company</label><input class="p-input" id="ba-name" name="billing_name" value="${esc(b.billing_name || client.company || client.full_name || "")}" required></div>
        <div class="p-field p-span"><label for="ba-email">Invoice email</label><input class="p-input" id="ba-email" name="billing_email" type="email" value="${esc(b.billing_email || client.email || "")}"></div>
        <div class="p-field p-span"><label for="ba-l1">Street</label><input class="p-input" id="ba-l1" name="line1" value="${esc(b.line1 || "")}" required></div>
        <div class="p-field p-span"><label for="ba-l2">Suite (optional)</label><input class="p-input" id="ba-l2" name="line2" value="${esc(b.line2 || "")}"></div>
        <div class="p-field"><label for="ba-city">City</label><input class="p-input" id="ba-city" name="city" value="${esc(b.city || "")}" required></div>
        <div class="p-field"><label for="ba-state">State</label><input class="p-input" id="ba-state" name="state" value="${esc(b.state || "")}" maxlength="2" required></div>
        <div class="p-field"><label for="ba-zip">ZIP code</label><input class="p-input" id="ba-zip" name="postal_code" value="${esc(b.postal_code || "")}" required></div>
        <div class="p-span"><button class="btn btn--navy btn--sm" type="submit">Save</button></div>
      </form>`, !hasAddr)}
    </section>`;

  cards.inbox = () => !inbox.length ? "" : `<section class="p-card p-card--accent" id="review-inbox"><div class="p-row"><p class="p-kicker">Waiting for your review</p><span class="p-muted">${inbox.length} filed by the assistant</span></div>
      <p class="p-muted">Only you can see these. Open each one; share it and it moves into ${esc(clientName)}'s Documents like any upload, or discard it.</p>
      <ul class="doc-list">${inbox.map((d) => `<li class="doc doc--review" data-inbox-item="${esc(d.id)}">
        <span class="doc__icon" aria-hidden="true">${esc((d.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</span>
        <div class="doc__body"><p class="doc__title">${fileLabel(d.title)}</p>${d.note ? `<p class="doc__note">${esc(d.note)}</p>` : ""}
          <p class="doc__meta">${fileLabel(d.name)}${d.size ? ` · ${esc(fmtSize(d.size))}` : ""}${d.milestone_id && msName.has(d.milestone_id) ? ` · ${esc(msName.get(d.milestone_id))}` : ""} · filed ${esc(relTime(d.created_at))}</p>
          <div class="review-acts">
            <button class="p-linkbtn" data-inbox-open="${esc(d.path)}">Open</button>
            ${members.length ? `<label class="p-check"><input type="checkbox" data-inbox-team${d.suggest_team ? " checked" : ""}> Team can see${d.suggest_team ? " (suggested)" : ""}</label>` : ""}
            <label class="p-check"><input type="checkbox" data-inbox-notify checked> Email ${esc(clientName)}</label>
            <button class="btn btn--navy btn--sm" data-inbox-share="${esc(d.id)}">Share</button>
            <button class="p-linkbtn" data-inbox-discard="${esc(d.id)}">Discard</button>
          </div></div></li>`).join("")}</ul>
    </section>`;

  const TAB_CARDS = {
    today: [cards.messages, cards.requests, () => cards.activity(8)],
    models: [cards.project, cards.owner, cards.pricing],
    documents: [cards.inbox, cards.deliverables, cards.teamFiles, cards.updates, cards.drafts],
    billing: [cards.invoices, cards.billingAddress],
    plan: [cards.milestonesManage, cards.decisions, cards.context, () => cards.activity(40)],
    people: [cards.clientCard, cards.team, cards.teamThread],
    settings: [cards.questionnaires, cards.remove, cards.closeout],
  };
  const badges = { today: unreadMsgs + toReview, documents: draftsToReview + inbox.length, billing: openInv.length, people: activeMembers.filter((m) => !m.last_seen_at).length };
  const tabs = `<nav class="room-tabs room-tabs--admin" aria-label="Engagement"><div class="room-tabs__inner">${ENG_TABS.map(([k, label]) => `<a href="#engagement=${esc(id)}/${k}" class="room-tabs__link"${k === tab ? ' aria-current="page"' : ""}>${label}${badges[k] ? `<span class="room-tabs__badge${k === "people" ? " room-tabs__badge--soft" : ""}" aria-label="${badges[k]} ${k === "today" ? "waiting" : k === "documents" ? "to review" : k === "billing" ? "unpaid" : "not signed in yet"}">${badges[k]}</span>` : ""}</a>`).join("")}</div></nav>`;
  return title(esc(eng.title), `${esc(client.full_name || client.email || "")}${client.company ? ` · ${esc(client.company)}` : ""}`, statusPill(eng.status)) + `<div class="admin-tabs-anchor" aria-hidden="true"></div>` + tabs + `
    <div class="draft-grid admin-eng">
      <div class="p-stack">${TAB_CARDS[tab].map((fn) => fn()).join("")}</div>
      <div class="p-stack admin-side">${side}</div>
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
let lastEng = null, lastTab = null;
/** The scroll position that puts the engagement's tabs just under the header. */
// Measured from a marker just above the strip: the strip itself is sticky, so once the page
// scrolls it reports where it is stuck, not where it sits.
const stripTop = () => { const s = document.querySelector(".admin-tabs-anchor"); return s ? s.getBoundingClientRect().top + window.scrollY - (document.getElementById("p-header")?.offsetHeight || 0) : 0; };
async function route() {
  const hash = location.hash.slice(1) || "overview";
  const [key, arg] = hash.split("=");
  // Within one engagement, keep the page up while the next view loads: a tab switch shouldn't
  // flash "Loading…", and a refresh after an action should leave you where you were.
  const sameEng = key === "engagement" && engagementId() === lastEng;
  const tabChanged = sameEng && engTab() !== lastTab;
  const y = window.scrollY, belowTabs = sameEng && y > stripTop();
  if (!sameEng) main.innerHTML = `<div class="p-loading">Loading…</div>`;
  try {
    const c = await counts();
    let body, active = key;
    if (key === "inquiries") body = await viewInquiries();
    else if (key === "inquiry") { body = await viewInquiry(arg); active = "inquiries"; }
    else if (key === "proposals") body = await viewProposals();
    else if (key === "proposal") { body = await viewProposal(arg); active = "proposals"; }
    else if (key === "clients") body = await viewClients();
    else if (key === "engagement") { body = await viewEngagement(engagementId(), engTab()); active = "clients"; }
    else if (key === "responses") { body = await viewResponses(arg); active = "clients"; }
    else if (key === "draft") { body = await viewDraft(arg); active = "drafts"; }
    else if (key === "drafts") body = await viewDrafts(c);
    else if (key === "questionnaires") body = await viewQuestionnaires();
    else { body = await viewOverview(c); active = "overview"; }
    main.innerHTML = shell(active, c, body);
    lastEng = key === "engagement" ? engagementId() : null;
    lastTab = key === "engagement" ? engTab() : null;
    if (!sameEng) window.scrollTo(0, 0);
    else if (tabChanged) { if (belowTabs) window.scrollTo(0, stripTop()); }
    else window.scrollTo(0, y);
    document.querySelectorAll(".admin-thread").forEach((t) => { t.scrollTop = t.scrollHeight; }); // newest messages in view
  } catch (err) {
    console.error(err);
    main.innerHTML = shell("", { review: 0, inquiries: 0, accepted: 0 }, `<p class="p-empty">${esc(err.message)}</p>`);
  }
}

function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

main.addEventListener("submit", async (e) => {
  const form = e.target;
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const label = btn?.textContent;
  if (btn) btn.disabled = true;
  try {
    const engId = engagementId();
    if (await pipelineSubmit(form, route)) return;
    if (form.id === "msg-form") {
      const body = form.body.value.trim();
      if (!body) return;
      const row = await store.postMessage(engId, body);
      toastNotice(row.notice, "Sent. The client has been emailed.", "Sent.");
      await route();
      document.getElementById("msg-body")?.focus();
      const th = document.getElementById("thread"); if (th) th.scrollTop = th.scrollHeight;
      return;
    } else if (form.id === "team-msg-form") {
      const body = form.body.value.trim();
      if (!body) return;
      const sentRow = await store.postMessage(engId, body, "team");
      toastNotice(sentRow.notice, "Sent to the team.", "Sent.");
      await route();
      const th = document.getElementById("team-thread"); if (th) th.scrollTop = th.scrollHeight;
      return;
    } else if (form.id === "member-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const days = v("length");
      const r = await store.inviteMember({ engagement_id: engId, email: v("email"), full_name: v("full_name"), role_label: v("role_label") || null, organization: v("organization") || null,
        can_message: form.can_message.checked, can_files: form.can_files.checked, expires_at: days ? new Date(Date.now() + Number(days) * 864e5).toISOString() : null });
      if (r.emailed === false) toastNotice({ reason: "email failed" }, "", `${v("full_name")} has been added.`);
      else toast(r.invited ? `Invitation sent to ${v("email")}.` : `${v("full_name")} already had an account and has been added.`);
      route();
    } else if (form.id === "action-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const existing = await store.actionItems(engId);
      const row = await store.addActionItem({ engagement_id: engId, kind: v("kind"), title: v("title"), detail: v("detail") || null, due_date: v("due_date") || null, assignee_id: v("assignee_id") || null, position: existing.length + 1 });
      const n = form.notify.checked ? await store.notify("action_item", row.id) : null;
      toastNotice(n, form.notify.checked ? "Sent. They've been emailed." : "Request added.", "Request added.");
      route();
    } else if (form.id === "model-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const sf = Number(String(v("sf")).replace(/[,\s]/g, "")) || null;
      const m = await createFromTemplate({ engagementId: engId, title: v("title"), sheetId: v("sheet") || null, buildingSf: sf });
      toast("Model created from the template. Fill in the costs and assumptions.");
      location.href = `project.html?m=${m.id}`;
    } else if (form.id === "owner-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const entities = v("entities").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [name, kind] = l.split("|").map((x) => x.trim()); return { name, kind: ["sole_prop", "smllc", "partnership", "s_corp", "c_corp", "rental", "individual"].includes(kind) ? kind : "smllc" }; });
      const m = await createOwnerFromTemplate({ engagementId: engId, title: v("title"), ownerName: v("owner_name") || null, pmModelId: v("pm_model_id") || null, entities });
      toast("Owner model created. Add the books by year, the properties and the adjustments.");
      location.href = `owner.html?m=${m.id}`;
    } else if (form.id === "sheet-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const contractor = v("contractor_id") || null;
      const sheet = await store.sovCreateSheet({ engagement_id: engId, title: v("title"), intro: v("intro") || null, contractor_id: contractor });
      const tpl = SOV_TEMPLATES[v("template")] || SOV_TEMPLATES.blank;
      if (tpl.lines.length) {
        await store.sovInsertLines(tpl.lines.map(([section, code, description, hint], i) => ({ sheet_id: sheet.id, engagement_id: engId, position: i + 1, section, code: code || null, description, hint: hint || null })));
      }
      let notice = null;
      if (contractor) {
        const req = await store.addActionItem({ engagement_id: engId, kind: "pricing", link_ref: sheet.id, assignee_id: contractor, title: `Price the schedule of values: ${sheet.title}`, due_date: v("due_date") || null, position: 0 });
        notice = await store.notify("action_item", req.id);
      }
      const went = toastNotice(notice, contractor ? "Sheet created. The contractor has been asked and emailed." : "Sheet created.", "Sheet created and the contractor asked.");
      setTimeout(() => { location.href = `pricing.html?s=${sheet.id}`; }, went ? 0 : 4000);
    } else if (form.id === "deliverable-form") {
      const file = form.file.files[0];
      if (!file) throw new Error("Choose a file to share.");
      checkFile(file);
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      if (btn) btn.textContent = "Uploading…";
      const row = await store.uploadDeliverable(engId, { title: v("title") || file.name.replace(/\.[^.]+$/, ""), note: v("note") || null, milestone_id: v("milestone_id") || null, shared_with_team: !!form.team?.checked }, file);
      const n = form.notify.checked ? await store.notify("deliverable", row.id) : null;
      toastNotice(n, form.notify.checked ? "Shared. The client has been emailed." : "Shared in the client's Documents.", "Shared in the client's Documents.");
      route();
    } else if (form.id === "invoice-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const lines = [0, 1, 2].map((i) => ({ description: v(`line_desc_${i}`), amount: v(`line_amt_${i}`).replace(/[$,\s]/g, ""), tax_code: v(`line_tax_${i}`) }))
        .filter((l) => l.description || l.amount)
        .map((l) => {
          const cents = Math.round(Number(l.amount) * 100);
          if (!l.description || !Number.isFinite(cents) || cents <= 0) throw new Error("Each line needs a description and an amount above zero.");
          return { description: l.description, amount_cents: cents, tax_code: l.tax_code };
        });
      const subtotal = lines.reduce((a, l) => a + l.amount_cents, 0);
      if (!await confirmDialog({ title: "Send this invoice?", body: `<p>${usd(subtotal)} before tax, ${lines.length} line${lines.length === 1 ? "" : "s"}. Stripe adds any sales tax, emails it to the client and shows it in their Billing tab.</p>`, confirmLabel: "Send" })) return;
      if (btn) btn.textContent = "Sending…";
      const r = await store.billing({ action: "create_invoice", engagement_id: engId, kind: v("kind"), description: v("description") || null,
        days_until_due: Number(v("days_until_due")) || 15, lines, request_id: v("request_id") });
      toast(`Invoice ${r.invoice?.number || ""} sent: ${usd(r.invoice?.total ?? subtotal)}${r.invoice?.tax ? ` including ${usd(r.invoice.tax)} tax` : ""}.`);
      route();
    } else if (form.id === "billing-admin-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const eng = await store.engagement(engId);
      await store.billing({ action: "save_address", client_id: eng.client_id, billing_name: v("billing_name"), billing_email: v("billing_email"),
        line1: v("line1"), line2: v("line2"), city: v("city"), state: v("state").toUpperCase(), postal_code: v("postal_code") });
      toast("Billing address saved."); route();
    } else if (form.id === "room-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const link = v("meeting_link");
      if (link && !/^https:\/\//.test(link)) throw new Error("The video link should start with https://");
      await store.updateEngagement(engId, { kickoff_date: v("kickoff_date") || null, next_meeting_at: v("next_meeting_at") ? new Date(v("next_meeting_at")).toISOString() : null, next_meeting_note: v("next_meeting_note") || null, meeting_link: link || null });
      toast("Client room updated.");
    } else if (form.id === "ms-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const existing = await store.milestones(engId);
      await store.saveMilestone({ engagement_id: engId, position: existing.length + 1, title: v("title"), due_label: v("due_label") || null, status: "upcoming" });
      route();
    } else if (form.id === "dec-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      await store.addDecision({ engagement_id: engId, decision: v("decision"), rationale: v("rationale") || null, owner: v("owner") || null, decided_on: v("decided_on") || new Date().toISOString().slice(0, 10) });
      toast("Decision recorded. The client sees it in their room.");
      route();
    } else if (form.id === "invite-form") {
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
      if (ok) { const r = await store.publish({ engagement_id: engId, ...formData(form) }); toastNotice(r?.emailed === false ? { reason: "email failed" } : null, "Published.", "Published."); route(); }
    } else if (form.id === "publish-form") {
      const d = window.__draft;
      const ok = await confirmDialog({ title: "Approve and publish?", body: "<p>Your message will appear in the client's portal and they'll be emailed. The analysis stays private.</p>", confirmLabel: "Publish" });
      if (ok) { const r = await store.publish({ engagement_id: d.engagement_id, draft_id: d.id, ...formData(form) }); toastNotice(r?.emailed === false ? { reason: "email failed" } : null, "Published to the client.", "Published."); route(); }
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
  finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
});

main.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.matches(".room-tabs--admin .room-tabs__link[aria-current='page']") && window.scrollY > stripTop() + 4) { e.preventDefault(); window.scrollTo({ top: stripTop(), behavior: "smooth" }); return; }
  try {
    if (await pipelineClick(t, route)) return;
    if (t.dataset.msDelete) { await store.deleteMilestone(t.dataset.msDelete); route(); }
    else if (t.dataset.reqReview) {
      const accept = t.dataset.reqReview === "accept";
      const note = accept ? null : await promptDialog({ title: "Ask for changes", label: "What needs to change", required: true, confirmLabel: "Send back" });
      if (!accept && !note) return;
      await store.reviewRequest(t.dataset.req, accept, note);
      const n = await store.notify("request_update", t.dataset.req);
      toastNotice(n, accept ? "Accepted. They've been told." : "Sent back with your note.", accept ? "Accepted." : "Sent back.");
      route();
    }
    else if (t.dataset.memberModel) {
      await store.setMemberModel(t.dataset.memberModel, t.dataset.allow === "1");
      toast(t.dataset.allow === "1" ? "They can now see the project and owner models." : "Model access removed.");
      route();
    }
    else if (t.dataset.ownerDelete) {
      if (await confirmDialog({ title: "Delete this owner model?", body: "<p>Its entities, books, adjustments, properties, findings, assumptions, comments and saved versions are deleted. The project model is kept.</p>", confirmLabel: "Delete" })) { await store.omDeleteModel(t.dataset.ownerDelete); toast("Deleted."); route(); }
    }
    else if (t.dataset.modelDelete) {
      if (await confirmDialog({ title: "Delete this project model?", body: "<p>Its cost lines, assumptions, comments and saved versions are deleted. The pricing sheet is kept.</p>", confirmLabel: "Delete" })) { await store.pmDeleteModel(t.dataset.modelDelete); toast("Deleted."); route(); }
    }
    else if (t.dataset.reqAnswer) {
      const note = await promptDialog({ title: "Answer for them", body: "<p class=\"p-muted\">Record an answer you received another way (by email or on a call). It's marked as answered by you.</p>", label: "Answer", required: true, confirmLabel: "Save answer" });
      if (!note) return;
      await store.submitRequest(t.dataset.reqAnswer, note);
      toast("Answer recorded.");
      route();
    }
    else if (t.dataset.sheetDelete) {
      if (await confirmDialog({ title: "Delete this pricing sheet?", body: "<p>Every line, the budget and the submitted versions are deleted. It can't be undone.</p>", confirmLabel: "Delete" })) {
        await store.sovDeleteSheet(t.dataset.sheetDelete);
        const engId = engagementId();
        for (const a of (await store.actionItems(engId)).filter((x) => x.kind === "pricing" && x.link_ref === t.dataset.sheetDelete)) await store.deleteActionItem(a.id);
        toast("Deleted."); route();
      }
    }
    else if (t.dataset.actionDelete) {
      if (await confirmDialog({ title: "Remove this item?", body: "<p>It disappears from the client's list.</p>", confirmLabel: "Remove" })) { await store.deleteActionItem(t.dataset.actionDelete); route(); }
    }
    else if (t.dataset.deliverableDelete) {
      const d = (await store.deliverables(engagementId())).find((x) => x.id === t.dataset.deliverableDelete);
      if (d && await confirmDialog({ title: "Remove this document?", body: `<p><strong>${esc(d.title)}</strong> is deleted and disappears from the client's Documents.</p>`, confirmLabel: "Remove" })) { await store.deleteDeliverable(d); toast("Removed."); route(); }
    }
    else if (t.dataset.inboxOpen) {
      const win = window.open("", "_blank");
      try { const url = await store.inboxUrl(t.dataset.inboxOpen); if (win) win.location.href = url; else location.href = url; }
      catch (err) { if (win) win.close(); throw err; }
    }
    else if (t.dataset.inboxShare) {
      const item = (window.__inbox || []).find((x) => x.id === t.dataset.inboxShare);
      const li = t.closest("[data-inbox-item]");
      if (!item || !li) return;
      const team = !!li.querySelector("[data-inbox-team]")?.checked, notify = !!li.querySelector("[data-inbox-notify]")?.checked;
      t.disabled = true; t.textContent = "Sharing…";
      const row = await store.shareInboxDocument(item, { shared_with_team: team });
      const n = notify ? await store.notify("deliverable", row.id) : null;
      toastNotice(n, notify ? "Shared. The client has been emailed." : "Shared in the client's Documents.", "Shared in the client's Documents.");
      route();
    }
    else if (t.dataset.inboxDiscard) {
      const item = (window.__inbox || []).find((x) => x.id === t.dataset.inboxDiscard);
      if (item && await confirmDialog({ title: "Discard this document?", body: `<p><strong>${esc(item.title)}</strong> is deleted. Nobody else ever saw it.</p>`, confirmLabel: "Discard" })) {
        await store.discardInboxDocument(item); toast("Discarded."); route();
      }
    }
    else if (t.dataset.invVoid) {
      if (await confirmDialog({ title: "Void this invoice?", body: "<p>The client can no longer pay it, and Stripe marks it void. This can't be undone; send a new invoice if the amount was wrong.</p>", confirmLabel: "Void" })) {
        await store.billing({ action: "void_invoice", invoice_id: t.dataset.invVoid }); toast("Voided."); route();
      }
    }
    else if (t.dataset.invSync) {
      await store.billing({ action: "sync_invoice", invoice_id: t.dataset.invSync }); toast("Up to date with Stripe."); route();
    }
    else if (t.dataset.engStatus) {
      const engId = engagementId();
      await store.updateEngagement(engId, { status: t.dataset.engStatus });
      toast(t.dataset.engStatus === "complete" ? "Marked complete. Team members' access has ended." : "Reopened.");
      route();
    }
    else if (t.hasAttribute("data-eng-export")) {
      const engId = engagementId();
      const data = await store.exportEngagement(engId);
      const slug = (data.engagement.title || "engagement").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      download(`${slug}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
      toast("Export downloaded. Files are listed by path; download any you need from Deliverables and Documents.");
    }
    else if (t.hasAttribute("data-eng-delete")) {
      const engId = engagementId();
      const eng = await store.engagement(engId);
      const files = await store.engagementObjects(engId);
      const typed = await new Promise((resolve) => {
        const dlg = document.createElement("dialog");
        dlg.className = "p-dialog";
        dlg.innerHTML = `<form method="dialog" class="p-dialog__box">
          <h2>Delete this engagement?</h2>
          <p>This permanently deletes <strong>${esc(eng.title)}</strong>: its questionnaires' answers, messages, tasks, milestones, decisions, updates, AI drafts, team access and <strong>${files.length} stored file${files.length === 1 ? "" : "s"}</strong>. It can't be undone. Export it first if you need a record.</p>
          <div class="p-field"><label for="del-confirm">Type the engagement title to confirm</label><input class="p-input" id="del-confirm" autocomplete="off"></div>
          <div class="p-dialog__actions"><button class="btn btn--ghost btn--sm" value="cancel">Cancel</button><button class="btn btn--navy btn--sm" value="ok">Delete permanently</button></div></form>`;
        document.body.appendChild(dlg);
        dlg.addEventListener("close", () => { const v = dlg.querySelector("#del-confirm").value.trim(); resolve(dlg.returnValue === "ok" ? v : null); dlg.remove(); });
        dlg.showModal();
      });
      if (typed === null) return;
      if (typed !== eng.title.trim()) { toast("The title didn't match, so nothing was deleted.", true); return; }
      const n = await store.deleteEngagement(engId);
      toast(`Deleted, with ${n} file${n === 1 ? "" : "s"}.`);
      location.hash = "clients";
    }
    else if (t.dataset.deliverableShare) {
      await store.updateDeliverable(t.dataset.deliverableShare, { shared_with_team: t.dataset.share === "1" });
      toast(t.dataset.share === "1" ? "The team can now see it." : "Only the client can see it now.");
      route();
    }
    else if (t.dataset.teamFileDelete) {
      const f = (window.__team?.teamFiles || []).find((x) => x.id === t.dataset.teamFileDelete);
      if (f && await confirmDialog({ title: "Remove this team file?", body: `<p><strong>${esc(f.name)}</strong> is deleted for everyone.</p>`, confirmLabel: "Remove" })) { await store.deleteTeamFile(f); toast("Removed."); route(); }
    }
    else if (t.dataset.memberExtend || t.dataset.memberRevoke || t.dataset.memberRestore) {
      const m = (window.__team?.roster?.members || []).find((x) => x.id === (t.dataset.memberExtend || t.dataset.memberRevoke || t.dataset.memberRestore));
      if (!m) return;
      if (t.dataset.memberExtend) {
        const base = m.expires_at && new Date(m.expires_at).getTime() > Date.now() ? new Date(m.expires_at).getTime() : Date.now();
        await store.setMemberAccess(m, { expires_at: new Date(base + 30 * 864e5).toISOString(), status: "active" });
        toast(`${m.name}: access extended 30 days.`);
      } else if (t.dataset.memberRevoke) {
        if (!await confirmDialog({ title: `Remove ${esc(m.name)}?`, body: "<p>Their access ends immediately. What they shared stays with the engagement.</p>", confirmLabel: "Remove access" })) return;
        await store.setMemberAccess(m, { status: "revoked" });
        toast(`${m.name} no longer has access.`);
      } else {
        await store.setMemberAccess(m, { expires_at: new Date(Date.now() + 30 * 864e5).toISOString(), status: "active" });
        toast(`${m.name} has access again for 30 days.`);
      }
      route();
    }
    else if (t.dataset.openFile) {
      const win = window.open("", "_blank");
      try { const url = await store.fileUrl(t.dataset.openFile); if (win) win.location.href = url; else location.href = url; }
      catch (err) { if (win) win.close(); throw err; }
    }
    else if (t.dataset.decDelete) {
      if (await confirmDialog({ title: "Remove this decision?", body: "<p>It disappears from the client's room.</p>", confirmLabel: "Remove" })) { await store.deleteDecision(t.dataset.decDelete); route(); }
    }
    else if (t.dataset.export) exportResponses(t.dataset.export);
    else if (t.dataset.reopen) { await store.setAssignmentStatus(t.dataset.reopen, "reopened"); toast("Reopened. The client can edit their answers again."); route(); }
    else if (t.dataset.complete) { await store.setAssignmentStatus(t.dataset.complete, "complete"); toast("Marked complete."); route(); }
    else if (t.dataset.regen) {
      t.disabled = true;
      await store.regenerateDraft(t.dataset.regen);
      toast("Claude is drafting. You'll get an email when it's ready.");
      route();
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

main.addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-ms-status]");
  if (!sel) return;
  try { await store.saveMilestone({ id: sel.dataset.msStatus, status: sel.value }); toast("Milestone updated."); }
  catch (err) { toast(err.message, true); }
});

(async () => {
  session = await requireSession({ admin: true });
  if (!session) return;
  renderChrome(session, { active: "admin", admin: true });
  window.addEventListener("hashchange", route);
  route();
  // Alerts across every engagement; choosing one opens that engagement.
  mountBell({
    me: session.user.id,
    open: (n) => { if (n.engagement_id) { const h = `engagement=${n.engagement_id}/today`; if (engagementId() === n.engagement_id && engTab() === "today") route(); else location.hash = h; } },
    onChange: (row) => { if (row && engagementId() === row.engagement_id && !main.contains(document.activeElement)) route(); },
  }).catch((err) => console.warn("Alerts unavailable:", err.message));
})();
