// The room, as each person sees it.
//
// The client:
//   Home       front and center: what needs them, what they're waiting on (by person), what's
//              new since they last looked, where things stand, and the recent activity
//   Requests   everything asked of anyone on the engagement: documents, answers, approvals,
//              to-dos; answer with a note and files, accept or send back
//   Pricing    the contractor's schedule of values beside the budget (once a sheet exists)
//   Documents  the signed agreement, deliverables from Michael, and files they've shared
//   Messages   a private thread with Michael
//   Plan       the milestone track (with the documents each produced) and the decision log
//   Team       outside advisers they've brought in: people, team thread, team tasks, team files
//
// A team member (attorney, CPA, contractor …), with access the client or Michael granted, sees:
//   Home, Requests (what they asked or were asked), Pricing (a contractor with a sheet),
//   Messages (the team thread, if they may message) and Files (if they may see files).
//
// The bell in the header lists alerts as they happen (Supabase Realtime); tabs are hash
// routes, so the back button and email links work.
import { store, FILE_ACCEPT, checkFile } from "./store.js";
import { ADMIN_CONTACT } from "./config.js";
import { esc, paragraphs, fileLabel, fmtDate, relTime, greeting, initials, renderChrome, requireSession, statusPill, progressBar, toast, toastNotice, download, confirmDialog, promptDialog } from "./ui.js";
import { mountSov, sovTotals, sheetPill, money, SHEET_STATUS } from "./sov.js";
import { mountBell } from "./bell.js";
import { mountModel, modelSummary } from "./model.js";
import { mountOwner, ownerSummary } from "./owner.js";

const main = document.getElementById("main");
const ROLES = ["Attorney", "CPA", "Bookkeeper", "Lender", "Insurance broker", "Contractor", "Architect", "Business partner", "Other"];
const ENG_KEY = "sypher-room-engagement";
const SHEET_KEY = "sypher-room-sheet";
const POLL_MS = 20000;
const ALIASES = { overview: "home", tasks: "requests", timeline: "home" };

let session, engagements = [], eng = null, room = null, pollTimer = null, bell = null, grid = null, pm = null, focusReq = null, softTimer = null;
const unread = { private: 0, team: 0 };

const isMember = () => eng?.access === "member";
const me = () => session.user.id;
const myMembership = () => room?.roster?.members?.find((m) => m.user_id === me());
function tabList() {
  const pricing = [...(room?.sheets?.length ? [["pricing", "Pricing"]] : []), ...(room?.models?.length ? [["project", "Project"]] : []), ...(room?.owners?.length ? [["owner", "Books and tax"]] : [])];
  if (!isMember()) {
    return [["home", "Home"], ["requests", "Requests"], ...pricing, ["documents", "Documents"], ["billing", "Billing"], ["messages", "Messages"], ["plan", "Plan"], ["team", "Team"]];
  }
  const m = myMembership() || {};
  return [["home", "Home"], ["requests", "Requests"], ...pricing, ...(m.can_message ? [["messages", "Messages"]] : []), ...(m.can_files ? [["files", "Files"]] : [])];
}
const tab = () => {
  const raw = location.hash.slice(1).split("=")[0];
  const t = ALIASES[raw] || raw;
  const list = tabList();
  return list.some(([k]) => k === t) ? t : list[0][0];
};
const fmtSize = (n) => (!n ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const dueText = (d) => (d ? fmtDate(d, { month: "short", day: "numeric" }) : "");
const overdue = (d) => d && d < new Date().toISOString().slice(0, 10);
const ext = (name) => esc((String(name).split(".").pop() || "").slice(0, 4).toUpperCase());
const daysFromNow = (n) => new Date(Date.now() + n * 864e5).toISOString();

/* --------------------------------------------------------------- people */
function personName(userId) {
  const r = room.roster;
  if (!r) return userId === me() ? "You" : ADMIN_CONTACT.name;
  if (userId === me()) return "You";
  if (r.principals?.some((p) => p.user_id === userId)) return ADMIN_CONTACT.name;
  if (r.client?.user_id === userId) return r.client.name;
  const m = r.members?.find((x) => x.user_id === userId);
  if (m) return m.name;
  // Not on the roster: before the roster lists principals, that is Michael; otherwise someone whose access ended.
  return r.principals?.length ? "Someone no longer on the team" : ADMIN_CONTACT.name;
}
function personRole(userId) {
  const r = room.roster;
  if (!r) return "";
  if (r.principals?.some((p) => p.user_id === userId)) return "Sypher Solutions";
  if (r.client?.user_id === userId) return r.client.organization || "Client";
  const m = r.members?.find((x) => x.user_id === userId);
  return m ? [m.role_label, m.organization].filter(Boolean).join(", ") : "";
}
const isPrincipal = (userId) => !!room.roster?.principals?.some((p) => p.user_id === userId);
function avatar(userId, size = 36) {
  if (isPrincipal(userId)) return `<img class="msg__avatar" src="../assets/img/michael-furth-avatar.webp" alt="" width="${size}" height="${size}">`;
  return `<span class="msg__avatar msg__avatar--initials" aria-hidden="true">${esc(initials(personName(userId)))}</span>`;
}
function assigneeName(a) {
  if (!a.assignee_id) return room.roster?.client?.name || "Client";
  return a.assignee_id === me() ? "You" : personName(a.assignee_id);
}

/* ------------------------------------------------------------- loading */
async function loadRoom() {
  const id = eng.id;
  if (isMember()) {
    const roster = await store.roster(id);
    const mine = roster?.members?.find((m) => m.user_id === me()) || {};
    const [actions, teamMessages, teamFiles, deliverables, lastRead] = await Promise.all([
      store.actionItems(id),
      mine.can_message ? store.messages(id, "team") : [],
      mine.can_files ? store.teamFiles(id) : [],
      mine.can_files ? store.deliverables(id) : [],
      mine.can_message ? store.teamLastRead(id, me()) : null,
    ]);
    const [requestFiles, parties, sheets, models, owners] = await Promise.all([
      store.requestFiles(id).catch(() => []), store.requestParties(id).catch(() => []), store.sovSheets(id).catch(() => []), store.pmModels(id).catch(() => []), store.omModels(id).catch(() => []),
    ]);
    room = { roster, actions, teamMessages, teamFiles, deliverables, teamLastRead: lastRead, requestFiles, parties, sheets, models, owners };
    await loadPricing(room);
    store.touchMembership(id).catch(() => {});
  } else {
    const [assignments, pubs, files, milestones, decisions, actions, deliverables, messages, agreement, activity, roster, teamMessages, teamFiles, lastRead] = await Promise.all([
      store.assignmentsFor(id), store.publications(id), store.engagementFiles(id), store.milestones(id), store.decisions(id),
      store.actionItems(id), store.deliverables(id), store.messages(id), store.agreement(id).catch(() => null), store.activity(id, 120),
      store.roster(id).catch(() => null), store.messages(id, "team"), store.teamFiles(id).catch(() => []), store.teamLastRead(id, me()).catch(() => null),
    ]);
    const [requestFiles, parties, sheets, models, owners] = await Promise.all([
      store.requestFiles(id).catch(() => []), store.requestParties(id).catch(() => []), store.sovSheets(id).catch(() => []), store.pmModels(id).catch(() => []), store.omModels(id).catch(() => []),
    ]);
    const [invoices, billing] = await Promise.all([store.invoices(id).catch(() => []), store.billingProfile(me()).catch(() => null)]);
    room = { assignments, pubs, files, milestones, decisions, actions, deliverables, messages, agreement, activity, roster, teamMessages, teamFiles, teamLastRead: lastRead, requestFiles, parties, sheets, models, owners, invoices, billing };
    await loadPricing(room);
  }
  countUnread();
}

/** Lines (and, owner side, the budget) for each pricing sheet, for the Home summary. */
async function loadPricing(r) {
  r.modelSummary = r.models?.length ? await modelSummary(r.models[0].id).catch(() => null) : null;
  r.ownerSummary = r.owners?.length ? await ownerSummary(r.owners[0].id).catch(() => null) : null;
  r.sheetLines = new Map();
  r.budget = null;
  if (!r.sheets.length) return;
  const [lineSets, budget] = await Promise.all([
    Promise.all(r.sheets.map((s) => store.sovLines(s.id).catch(() => []))),
    isMember() ? [] : store.sovBudget(eng.id).catch(() => []),
  ]);
  r.sheets.forEach((s, i) => r.sheetLines.set(s.id, lineSets[i]));
  r.budget = budget.length ? new Map(budget.map((b) => [b.line_id, b])) : null;
}

function countUnread() {
  unread.private = (room.messages || []).filter((m) => m.author_id !== me() && !m.read_at).length;
  const since = room.teamLastRead ? new Date(room.teamLastRead).getTime() : 0;
  unread.team = (room.teamMessages || []).filter((m) => m.author_id !== me() && new Date(m.created_at).getTime() > since).length;
}

/* ----------------------------------------------------------- the frame */
function cover() {
  const first = (session.profile.full_name || "").split(" ")[0];
  const switcher = engagements.length > 1 ? `<label class="room-switch"><span class="visually-hidden">Switch engagement</span>
    <select class="p-select p-select--sm" data-switch>${engagements.map((e) => `<option value="${esc(e.id)}"${e.id === eng.id ? " selected" : ""}>${esc(e.title)}${e.access === "member" ? " (team)" : ""}</option>`).join("")}</select></label>` : "";
  if (isMember()) {
    const m = myMembership() || {};
    const client = room.roster?.client || {};
    return `<section class="room-cover room-cover--team">
      <img class="room-cover__mark" src="../assets/img/sypher-mark-480.webp" alt="" width="375" height="388">
      <div class="p-shell room-cover__inner">
        <div class="room-cover__top"><p class="room-cover__kicker">Team access${client.organization ? ` · ${esc(client.organization)}` : ""}</p>${switcher}</div>
        <p class="room-cover__hello">${esc(greeting())}${first ? `, <em>${esc(first)}.</em>` : "."}</p>
        <h1 class="room-cover__title">${esc(eng.title)}</h1>
        <p class="room-cover__summary">You’re working with ${esc(client.name || "the client")} and Michael Furth of Sypher Solutions. This space holds what the team shares: ${[m.can_message && "the team thread", m.can_files && "files", "your tasks"].filter(Boolean).join(", ")}.</p>
        <dl class="room-cover__meta">
          <div><dt>Client</dt><dd>${esc(client.name || "")}</dd></div>
          ${m.role_label ? `<div><dt>Your role</dt><dd>${esc(m.role_label)}</dd></div>` : ""}
          <div><dt>Access until</dt><dd>${m.expires_at ? esc(fmtDate(m.expires_at)) : "The engagement ends"}</dd></div>
        </dl>
      </div>
    </section>`;
  }
  return `<section class="room-cover">
    <img class="room-cover__mark" src="../assets/img/sypher-mark-480.webp" alt="" width="375" height="388">
    <div class="p-shell room-cover__inner">
      <div class="room-cover__top"><p class="room-cover__kicker">Client room${session.profile.company ? ` · ${esc(session.profile.company)}` : ""}</p>${switcher}</div>
      <p class="room-cover__hello">${esc(greeting())}${first ? `, <em>${esc(first)}.</em>` : "."}</p>
      <h1 class="room-cover__title">${esc(eng.title)}</h1>
      ${eng.summary ? `<p class="room-cover__summary">${esc(eng.summary)}</p>` : ""}
      <dl class="room-cover__meta">
        ${eng.kickoff_date ? `<div><dt>Began</dt><dd>${esc(fmtDate(eng.kickoff_date))}</dd></div>` : ""}
        <div><dt>Status</dt><dd>${eng.status === "active" ? "Under way" : eng.status === "complete" ? "Complete" : "Archived"}</dd></div>
        <div><dt>Principal</dt><dd>${esc(ADMIN_CONTACT.name)}</dd></div>
      </dl>
    </div>
  </section>`;
}

function tabs() {
  const current = tab();
  const badge = (k) => {
    const strong = (n, label) => `<span class="room-tabs__badge" aria-label="${n} ${label}">${n}</span>`;
    const soft = (n, label) => `<span class="room-tabs__badge room-tabs__badge--soft" aria-label="${n} ${label}">${n}</span>`;
    if (k === "messages") { const n = isMember() ? unread.team : unread.private; return n ? strong(n, "unread") : ""; }
    if (k === "team" && unread.team) return strong(unread.team, "unread");
    if (k === "home") { const n = attention().length; return n ? soft(n, "need you") : ""; }
    if (k === "requests") { const n = room.actions.filter(needsMe).length; return n ? strong(n, "for you") : ""; }
    if (k === "pricing") { const n = room.sheets.filter(sheetNeedsMe).length; return n ? strong(n, "to act on") : ""; }
    if (k === "billing") { const n = openInvoices().length; return n ? strong(n, "to pay") : ""; }
    const alerts = (links) => (bell ? links.reduce((sum, l) => sum + bell.unread(eng.id, l).length, 0) : 0);
    if (k === "documents") { const n = alerts(["documents"]); return n ? strong(n, "new") : ""; }
    if (k === "plan") { const n = alerts(["plan"]); return n ? soft(n, "new") : ""; }
    if (k === "files") { const n = alerts(["files", "documents"]); return n ? strong(n, "new") : ""; }
    return "";
  };
  return `<nav class="room-tabs" aria-label="${isMember() ? "Team space" : "Client room"}"><div class="p-shell room-tabs__inner">
    ${tabList().map(([k, label]) => `<a href="#${k}" class="room-tabs__link"${k === current ? ' aria-current="page"' : ""}>${label}${badge(k)}</a>`).join("")}
  </div></nav>`;
}

/* --------------------------------------------------------------- tasks */
// "Mine": for the client, tasks with no assignee (or assigned to them); for a member, theirs.
const isMine = (a) => (isMember() ? a.assignee_id === me() : !a.assignee_id || a.assignee_id === me());
const openAssignments = () => (room?.assignments || []).filter((a) => ["open", "reopened"].includes(a.status));

function actionList(items, { showAssignee = false, canDelete = false } = {}) {
  const open = items.filter((a) => !a.done_at);
  const done = items.filter((a) => a.done_at);
  const row = (a) => {
    const tickable = isMine(a) || !isMember();
    const meta = [showAssignee ? `<span class="todo__who">${esc(assigneeName(a))}</span>` : "",
      a.due_date && !a.done_at ? `<span class="todo__due${overdue(a.due_date) ? " is-late" : ""}">${overdue(a.due_date) ? "Was due" : "Due"} ${esc(dueText(a.due_date))}</span>` : "",
      a.done_at ? `<span class="todo__due">Done ${esc(relTime(a.done_at))}</span>` : "",
      canDelete && a.created_by === me() ? `<button type="button" class="p-linkbtn" data-task-delete="${esc(a.id)}">Remove</button>` : ""].filter(Boolean).join("");
    const text = `<span class="todo__text"><span class="todo__title">${esc(a.title)}</span>${a.detail ? `<span class="todo__detail">${esc(a.detail)}</span>` : ""}</span>`;
    return `<li class="todo${a.done_at ? " is-done" : ""}">
      ${tickable ? `<label class="todo__check"><input type="checkbox" data-action="${esc(a.id)}"${a.done_at ? " checked" : ""}><span class="todo__box" aria-hidden="true"></span>${text}</label>`
        : `<div class="todo__check todo__check--ro"><span class="todo__box todo__box--ro${a.done_at ? " is-done" : ""}" aria-hidden="true"></span>${text}</div>`}
      ${meta ? `<div class="todo__meta">${meta}</div>` : ""}
    </li>`;
  };
  return `<ul class="todo-list">${open.map(row).join("")}</ul>
    ${done.length ? `<details class="todo-done"><summary>${done.length} done</summary><ul class="todo-list">${done.map(row).join("")}</ul></details>` : ""}`;
}

function taskForm() {
  const members = (room.roster?.members || []).filter((m) => m.status === "active");
  return `<details class="room-add"><summary class="p-linkbtn">Add a task</summary>
    <form class="p-form p-form--2" id="task-form">
      <div class="p-field p-span"><label for="t-title">What’s needed</label><input class="p-input" id="t-title" name="title" required maxlength="200" placeholder="e.g. Review the lease renewal clause"></div>
      <div class="p-field"><label for="t-who">Who</label><select class="p-select" id="t-who" name="assignee_id"><option value="">Me</option>${members.map((m) => `<option value="${esc(m.user_id)}">${esc(m.name)}${m.role_label ? ` (${esc(m.role_label)})` : ""}</option>`).join("")}</select></div>
      <div class="p-field"><label for="t-due">Due</label><input class="p-input" id="t-due" name="due_date" type="date"></div>
      <div class="p-field p-span"><label for="t-detail">Detail (optional)</label><input class="p-input" id="t-detail" name="detail" maxlength="500"></div>
      <div class="p-span"><button class="btn btn--navy btn--sm" type="submit">Add task</button></div>
    </form></details>`;
}

/* ------------------------------------------------------ client: overview */
function assignmentCard(a) {
  const p = a.progress;
  const done = p.answered + p.unknown;
  const open = ["open", "reopened"].includes(a.status);
  const due = a.due_date ? `Due ${fmtDate(a.due_date, { month: "long", day: "numeric" })}` : "";
  return `<li>
    <div class="p-row"><h3>${esc(a.questionnaire?.title)}</h3>${statusPill(a.status)}</div>
    ${progressBar(p)}
    <div class="p-row"><span class="p-muted">${done} of ${p.total} answered${p.unknown ? ` · ${p.unknown} pending` : ""}${due ? ` · ${due}` : ""}</span>
    <a class="btn ${open ? "btn--navy" : "btn--ghost"} btn--sm" href="questionnaire.html?a=${encodeURIComponent(a.id)}">${open ? (done ? "Continue" : "Begin") : "Review answers"}</a></div>
  </li>`;
}

function meetingCard() {
  if (!eng.next_meeting_at) {
    return `<section class="p-card room-meet"><h2 class="p-kicker">Next conversation</h2><p>Not scheduled yet. <a class="accent" href="#messages" data-compose="Could we find a time to talk this week?">Suggest a time</a>.</p></section>`;
  }
  const at = new Date(eng.next_meeting_at);
  const past = at.getTime() < Date.now() - 3600_000;
  return `<section class="p-card p-card--navy room-meet" aria-label="Next conversation">
    <h2 class="p-kicker">${past ? "Last conversation" : "Next conversation"}</h2>
    <p class="room-meet__day">${esc(at.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }))}</p>
    <p class="room-meet__time">${esc(at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }))}</p>
    ${eng.next_meeting_note ? `<p class="room-meet__note">${esc(eng.next_meeting_note)}</p>` : ""}
    <div class="room-meet__actions">
      ${eng.meeting_link && /^https:\/\//.test(eng.meeting_link) ? `<a class="btn btn--gold btn--sm" href="${esc(eng.meeting_link)}" target="_blank" rel="noopener">Join</a>` : ""}
      ${past ? "" : `<button type="button" class="p-linkbtn room-meet__cal" data-ics>Add to calendar</button>`}
    </div>
  </section>`;
}

function principalCard() {
  const c = ADMIN_CONTACT;
  return `<section class="p-card room-principal">
    <h2 class="p-kicker">${isMember() ? "Sypher Solutions" : "Your principal"}</h2>
    <div class="room-principal__id"><img class="room-principal__photo" src="../assets/img/michael-furth-avatar.webp" alt="" width="64" height="64">
      <div><h3>${esc(c.name)}</h3><p class="p-muted">${esc(c.title)}, Sypher Solutions</p></div></div>
    <ul class="room-principal__lines">
      ${isMember() ? (myMembership()?.can_message ? `<li><a href="#messages">Write in the team thread</a></li>` : "") : `<li><a href="#messages">Message in the portal</a></li>`}
      <li><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></li>
      ${c.phone && !isMember() ? `<li><a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></li>` : ""}
    </ul>
    ${c.response_promise && !isMember() ? `<p class="room-principal__promise">${esc(c.response_promise)}</p>` : ""}
  </section>`;
}

function latestMessageCard() {
  const last = room.messages[room.messages.length - 1];
  return `<section class="p-card room-msgpeek"><h2 class="p-kicker">Messages</h2>
    ${last ? `<p class="room-msgpeek__who">${last.author_id === me() ? "You" : esc(ADMIN_CONTACT.name.split(" ")[0])} · ${esc(relTime(last.created_at))}${unread.private ? ` <span class="pill pill--gold">${unread.private} new</span>` : ""}</p>
      <p class="room-msgpeek__body">${esc(last.body.length > 180 ? `${last.body.slice(0, 180)}…` : last.body)}</p>` : `<p class="p-muted">Questions between meetings? Write to Michael here and the whole thread stays with the engagement.</p>`}
    <a class="btn btn--ghost btn--sm" href="#messages">${last ? "Open the thread" : "Write to Michael"}</a>
  </section>`;
}

function whereThingsStand() {
  const ms = room.milestones;
  if (!ms.length) return "";
  const done = ms.filter((m) => m.status === "done").length;
  const now = ms.find((m) => m.status === "current");
  return `<section class="p-card p-card--accent room-stand"><h2 class="p-kicker">Where things stand</h2>
    <div class="room-stand__row"><p class="room-stand__big"><b>${done}</b> of ${ms.length}</p><p class="p-muted">milestones complete</p></div>
    <div class="p-progress" role="progressbar" aria-valuenow="${Math.round((done / ms.length) * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="Milestones complete"><span style="transform:scaleX(${done / ms.length})"></span></div>
    ${now ? `<p class="room-stand__now"><span class="room-track__now">In progress</span> ${esc(now.title)}</p>` : ""}
    <a class="p-linkbtn" href="#plan">See the plan</a>
  </section>`;
}

function updatesCard() {
  const [latest, ...older] = room.pubs;
  return `<section class="p-card" aria-label="Updates from Michael"><h2 class="p-kicker">Updates from Michael</h2>
    ${latest ? `<article class="room-update-item"><div class="p-row"><h3>${esc(latest.title)}</h3><span class="p-muted">${esc(fmtDate(latest.published_at))}</span></div><div class="room-update">${paragraphs(latest.body)}</div></article>
      ${older.length ? `<details class="room-older"><summary>${older.length} earlier update${older.length > 1 ? "s" : ""}</summary><ul class="p-list">${older.map((p) => `<li><details class="room-older__item"><summary><span>${esc(p.title)}</span><span class="p-muted">${esc(fmtDate(p.published_at))}</span></summary><div class="room-update">${paragraphs(p.body)}</div></details></li>`).join("")}</ul></details>` : ""}`
      : `<p class="p-empty">Updates will appear here as the work moves.</p>`}
  </section>`;
}

function teamPeek() {
  const active = (room.roster?.members || []).filter((m) => m.status === "active");
  const teamOpen = room.actions.filter((a) => a.assignee_id && a.assignee_id !== me() && !a.done_at).length;
  return `<section class="p-card room-teampeek"><h2 class="p-kicker">Your team</h2>
    ${active.length ? `<ul class="people people--mini">${active.slice(0, 4).map((m) => `<li><span class="msg__avatar msg__avatar--initials" aria-hidden="true">${esc(initials(m.name))}</span><span><b>${esc(m.name)}</b>${m.role_label ? ` · ${esc(m.role_label)}` : ""}</span></li>`).join("")}</ul>
      <p class="p-muted">${teamOpen ? `${teamOpen} open task${teamOpen > 1 ? "s" : ""} with the team` : "No open team tasks"}${unread.team ? ` · ${unread.team} new message${unread.team > 1 ? "s" : ""}` : ""}</p>`
      : `<p class="p-muted">Bring in your attorney, CPA or lender. They get their own time-limited access to share files and messages with you and Michael, and nothing else.</p>`}
    <a class="btn btn--ghost btn--sm" href="#team">${active.length ? "Open the team space" : "Add someone"}</a>
  </section>`;
}

/* ------------------------------------------------------------- requests */
const KIND = { task: "To-do", document: "Document", answer: "Question", approval: "Approval", pricing: "Pricing" };
const REQ_STATUS = { open: ["Open", "pill--teal"], submitted: ["Awaiting review", "pill--gold"], changes_requested: ["Changes requested", "pill--red"], accepted: ["Done", "pill--navy"] };
const clientId = () => room.roster?.client?.user_id || null;
const isLive = (a) => a.status === "open" || a.status === "changes_requested";
// Mine to answer: the client answers anything with no one named; a member, what's asked of them.
const canRespond = (a) => (isMember() ? a.assignee_id === me() : !a.assignee_id || a.assignee_id === me());
// Mine to review: what I asked for, or (the client) anything asked of someone else on the engagement.
const canReview = (a) => a.status === "submitted" && a.kind !== "pricing" && (a.created_by === me() || (!isMember() && !!a.assignee_id && a.assignee_id !== me()));
const needsMe = (a) => (isLive(a) && canRespond(a)) || canReview(a);
/** Who the ball is with: the person asked while it's open, whoever asked once it's answered. */
const waitingOn = (a) => (isLive(a) ? a.assignee_id || clientId() : a.created_by);
const waitingOnOthers = () => room.actions.filter((a) => a.status !== "accepted" && !needsMe(a) && (!isMember() || a.created_by === me() || a.assignee_id === me()));
function realName(uid) {
  if (!uid) return room.roster?.client?.name || "Client";
  if (uid === me()) return session.profile.full_name || "You";
  return personName(uid);
}
const askedName = (a) => (a.assignee_id ? personName(a.assignee_id) : isMember() ? (room.roster?.client?.name || "Client") : "You");
const fromName = (a) => (a.created_by ? personName(a.created_by) : ADMIN_CONTACT.name);

function dueBit(a) {
  if (!a.due_date || a.status === "accepted") return "";
  return `<span class="req__due${overdue(a.due_date) ? " is-late" : ""}">${overdue(a.due_date) ? "Was due" : "Due"} ${esc(dueText(a.due_date))}</span>`;
}

function fileChip(f) {
  return `<li><button type="button" class="req__file" data-open-file="${esc(f.path)}" title="${esc(personName(f.uploaded_by))} · ${esc(relTime(f.created_at))}">
    <span aria-hidden="true">${ext(f.name)}</span>${fileLabel(f.name)}${f.size ? ` <small>${esc(fmtSize(f.size))}</small>` : ""}</button>
    ${f.uploaded_by === me() && a11yRemovable(f) ? `<button type="button" class="p-linkbtn" data-req-file-delete="${esc(f.id)}" aria-label="Remove ${esc(f.name)}">Remove</button>` : ""}</li>`;
}
const a11yRemovable = (f) => { const a = room.actions.find((x) => x.id === f.request_id); return a && a.status !== "accepted"; };

function respondForm(a) {
  const ph = a.kind === "document" ? "A note with the files (optional)" : a.kind === "approval" ? "Approve, with any conditions" : "Your answer";
  return `<form class="req__respond" data-respond="${esc(a.id)}">
    <label class="visually-hidden" for="rs-${esc(a.id)}">Your answer to ${esc(a.title)}</label>
    <textarea class="p-textarea" id="rs-${esc(a.id)}" name="note" rows="3" maxlength="4000" placeholder="${esc(ph)}">${a.status === "changes_requested" ? "" : esc(a.response || "")}</textarea>
    <div class="req__bar">
      <label class="btn btn--ghost btn--sm file-btn">${a.kind === "document" ? "Attach the document" : "Attach files"}<input type="file" name="files" multiple accept="${FILE_ACCEPT}"></label>
      <span class="req__picked p-muted" aria-live="polite"></span>
      <button class="btn btn--navy btn--sm" type="submit">${a.kind === "approval" ? "Approve" : a.status === "changes_requested" ? "Send again" : "Send"}</button>
    </div>
  </form>`;
}

function requestCard(a) {
  const [sl, sc] = REQ_STATUS[a.status] || [a.status, ""];
  const files = (room.requestFiles || []).filter((f) => f.request_id === a.id);
  const respond = isLive(a) && canRespond(a);
  const actions = [];
  if (respond && a.kind === "task") actions.push(`<button type="button" class="btn btn--navy btn--sm" data-req-done="${esc(a.id)}">Mark done</button>`);
  if (respond && a.kind === "pricing") actions.push(`<a class="btn btn--navy btn--sm" href="#pricing">Open the pricing sheet</a>`);
  if (respond && a.link_kind === "pm_input") actions.push(`<a class="btn btn--navy btn--sm" href="#project">Set it in the project model</a>`);
  if (respond && a.link_kind === "om_input") actions.push(`<a class="btn btn--navy btn--sm" href="#owner">Set it in Books and tax</a>`);
  if (respond && a.link_kind === "om_finding") actions.push(`<a class="btn btn--navy btn--sm" href="#owner">Open the finding</a>`);
  if (canReview(a)) actions.push(`<button type="button" class="btn btn--ghost btn--sm" data-req-review="changes" data-req="${esc(a.id)}">Ask for changes</button>`, `<button type="button" class="btn btn--navy btn--sm" data-req-review="accept" data-req="${esc(a.id)}">Accept</button>`);
  if (a.kind === "task" && a.status === "accepted" && canRespond(a)) actions.push(`<button type="button" class="p-linkbtn" data-req-undo="${esc(a.id)}">Not done after all</button>`);
  if (a.created_by === me() && a.status === "open") actions.push(`<button type="button" class="p-linkbtn" data-task-delete="${esc(a.id)}">Remove</button>`);
  return `<li class="req req--${esc(a.kind)} is-${esc(a.status)}" id="req-${esc(a.id)}">
    <div class="req__head"><span class="req__kind">${esc(KIND[a.kind] || a.kind)}</span><h3 class="req__title">${esc(a.title)}</h3><span class="pill pill--dot ${sc}">${esc(sl)}</span></div>
    ${a.detail ? `<p class="req__detail">${esc(a.detail)}</p>` : ""}
    <p class="req__meta"><span>${esc(fromName(a))} → ${esc(askedName(a))}</span>${dueBit(a)}${a.submitted_at && a.status !== "open" ? `<span>Answered ${esc(relTime(a.submitted_at))}</span>` : ""}</p>
    ${a.status === "changes_requested" && a.review_note ? `<div class="req__review"><b>What needs to change</b>${paragraphs(a.review_note)}</div>` : ""}
    ${a.response ? `<div class="req__answer"><b>${esc(a.submitted_by ? personName(a.submitted_by) : "Answer")}${a.submitted_by ? " answered" : ""}</b>${paragraphs(a.response)}</div>` : ""}
    ${a.status === "accepted" && a.review_note ? `<p class="req__meta">Note: ${esc(a.review_note)}</p>` : ""}
    ${files.length ? `<ul class="req__files">${files.map(fileChip).join("")}</ul>` : ""}
    ${respond && !["task", "pricing"].includes(a.kind) && a.link_kind !== "pm_input" ? respondForm(a) : ""}
    ${actions.length ? `<div class="req__actions">${actions.join("")}</div>` : ""}
  </li>`;
}

function askForm() {
  const kinds = isMember() ? ["document", "answer", "approval"] : ["task", "document", "answer", "approval"];
  const parties = (room.parties || []).filter((p) => p.id !== me());
  const opt = (p) => `<option value="${p.role === "Client" ? "" : esc(p.id)}">${esc(p.name)}${p.role ? ` (${esc(p.role)}${p.org ? `, ${esc(p.org)}` : ""})` : ""}</option>`;
  const who = isMember() ? parties.map(opt).join("") : `<option value="">Me (a to-do for myself)</option>${parties.map(opt).join("")}`;
  return `<details class="room-add req-ask"><summary class="btn btn--ghost btn--sm">Ask for something</summary>
    <form class="p-form p-form--2" id="ask-form">
      <div class="p-field"><label for="ask-kind">What you need</label><select class="p-select" id="ask-kind" name="kind">${kinds.map((k) => `<option value="${k}"${k === "document" ? " selected" : ""}>${{ task: "A to-do", document: "A document or file", answer: "An answer to a question", approval: "An approval" }[k]}</option>`).join("")}</select></div>
      <div class="p-field"><label for="ask-who">From</label><select class="p-select" id="ask-who" name="assignee_id">${who}</select></div>
      <div class="p-field p-span"><label for="ask-title">Request</label><input class="p-input" id="ask-title" name="title" required maxlength="200" placeholder="e.g. The signed lease, all pages"></div>
      <div class="p-field"><label for="ask-due">By (optional)</label><input class="p-input" id="ask-due" name="due_date" type="date"></div>
      <div class="p-field"><label for="ask-detail">Detail (optional)</label><input class="p-input" id="ask-detail" name="detail" maxlength="500"></div>
      <div class="p-span"><button class="btn btn--navy btn--sm" type="submit">Send the request</button> <span class="p-muted">They’re emailed and it shows on their Home.</span></div>
    </form></details>`;
}

function viewRequests() {
  const all = room.actions;
  const forMe = all.filter(needsMe);
  const waiting = waitingOnOthers();
  const done = all.filter((a) => a.status === "accepted" && (!isMember() || a.created_by === me() || a.assignee_id === me()));
  const list = (items) => `<ul class="req-list">${items.map(requestCard).join("")}</ul>`;
  return `<div class="req-page">
    <section class="p-card p-card--accent" aria-label="Requests">
      <div class="p-row"><h2 class="p-kicker">Requests</h2>${askForm()}</div>
      <p class="p-muted req-page__lede">Documents, answers and approvals anyone on the engagement needs from anyone else. Answer here with a note and files; whoever asked accepts it or says what needs to change.${isMember() ? " You see what you’ve asked and what’s asked of you." : ""}</p>
      ${forMe.length ? `<h3 class="room-sub">For you <span class="room-sub__n">${forMe.length}</span></h3>${list(forMe)}` : `<p class="p-empty">Nothing needs you right now.</p>`}
      ${waiting.length ? `<h3 class="room-sub">Waiting on others <span class="room-sub__n">${waiting.length}</span></h3>${list(waiting)}` : ""}
      ${done.length ? `<details class="todo-done"><summary>${done.length} done</summary>${list(done)}</details>` : ""}
    </section>
  </div>`;
}

/* ----------------------------------------------------------------- home */
/** A pricing sheet waiting on me: the owner side reviews a submitted one; the contractor prices an open one. */
const sheetNeedsMe = (s) => (isMember() ? s.contractor_id === me() && ["not_started", "in_progress", "changes_requested"].includes(s.status) : s.status === "submitted");

function attention() {
  const out = [];
  for (const a of room.actions.filter(needsMe)) {
    if (a.kind === "pricing") continue; // the sheet itself is listed below
    const review = canReview(a);
    out.push({
      kind: review ? "Review" : KIND[a.kind], tone: review ? "gold" : a.status === "changes_requested" ? "rust" : "teal",
      title: a.title,
      meta: [review ? `${a.submitted_by ? personName(a.submitted_by) : askedName(a)} answered ${a.submitted_at ? relTime(a.submitted_at) : ""}` : `From ${fromName(a)}`, a.status === "changes_requested" ? "changes requested" : ""].filter(Boolean).join(" · "),
      due: dueBit(a),
      cta: a.kind === "task" && !review ? `<button type="button" class="btn btn--ghost btn--sm" data-req-done="${esc(a.id)}">Mark done</button>`
        : a.link_kind === "pm_input" && !review ? `<a class="btn btn--navy btn--sm" href="#project">Set it</a>`
        : a.link_kind === "om_input" && !review ? `<a class="btn btn--navy btn--sm" href="#owner">Set it</a>`
        : a.link_kind === "om_finding" && !review ? `<a class="btn btn--navy btn--sm" href="#owner">Open it</a>`
        : `<a class="btn btn--navy btn--sm" href="#requests" data-goto-req="${esc(a.id)}">${review ? "Review" : "Respond"}</a>`,
    });
  }
  for (const s of room.sheets.filter(sheetNeedsMe)) {
    const lines = room.sheetLines.get(s.id) || [];
    const t = sovTotals(s, lines);
    out.push({
      kind: "Pricing", tone: s.status === "changes_requested" ? "rust" : "gold", title: isMember() ? `Price: ${s.title}` : `Pricing ready to review: ${s.title}`,
      meta: isMember() ? `${t.answered} of ${t.count} lines answered${s.status === "changes_requested" ? " · changes requested" : ""}` : `Version ${s.version} · ${money(t.total)} · from ${realName(s.contractor_id)}`,
      due: "", cta: `<a class="btn btn--navy btn--sm" href="#pricing" data-goto-sheet="${esc(s.id)}">${isMember() ? (t.answered ? "Continue pricing" : "Start pricing") : "Review"}</a>`,
    });
  }
  if (!isMember()) {
    for (const asg of openAssignments()) {
      const p = asg.progress, done = p.answered + p.unknown;
      out.push({ kind: "Questions", tone: "teal", title: asg.questionnaire?.title || "Questionnaire", meta: `${done} of ${p.total} answered`, due: asg.due_date ? `<span class="req__due${overdue(asg.due_date) ? " is-late" : ""}">Due ${esc(dueText(asg.due_date))}</span>` : "",
        cta: `<a class="btn btn--navy btn--sm" href="questionnaire.html?a=${encodeURIComponent(asg.id)}">${done ? "Continue" : "Begin"}</a>` });
    }
    for (const inv of openInvoices()) {
      out.push({ kind: "Invoice", tone: overdue(inv.due_date) ? "rust" : "gold", title: `${inv.description || "Invoice"}${inv.number ? ` (${inv.number})` : ""}`,
        meta: `${usd(inv.amount_remaining ?? inv.total)} due`, due: inv.due_date ? `<span class="req__due${overdue(inv.due_date) ? " is-late" : ""}">Due ${esc(dueText(inv.due_date))}</span>` : "",
        cta: inv.hosted_invoice_url ? `<a class="btn btn--navy btn--sm" href="${esc(inv.hosted_invoice_url)}" target="_blank" rel="noopener">Pay</a>` : `<a class="btn btn--ghost btn--sm" href="#billing">View</a>` });
    }
    if (unread.private) out.push({ kind: "Message", tone: "navy", title: `${unread.private} new message${unread.private > 1 ? "s" : ""} from ${ADMIN_CONTACT.name.split(" ")[0]}`, meta: "", due: "", cta: `<a class="btn btn--ghost btn--sm" href="#messages">Read</a>` });
  }
  return out;
}

function attentionCard() {
  const items = attention();
  return `<section class="p-card p-card--accent home-attn" aria-label="Needs your attention">
    <div class="p-row"><h2 class="p-kicker">Needs your attention</h2>${items.length ? `<span class="p-muted">${items.length}</span>` : ""}</div>
    ${items.length ? `<ul class="attn-list">${items.map((i) => `<li class="attn attn--${i.tone}">
      <span class="attn__kind">${esc(i.kind)}</span>
      <div class="attn__body"><p class="attn__title">${esc(i.title)}</p><p class="attn__meta">${esc(i.meta)}${i.due ? ` ${i.due}` : ""}</p></div>
      <div class="attn__cta">${i.cta}</div></li>`).join("")}</ul>`
      : `<p class="p-empty">Nothing needs you right now.</p>`}
    <div class="home-attn__foot">${askForm()}<a class="p-linkbtn" href="#requests">All requests</a></div>
  </section>`;
}

function waitingCard() {
  const items = waitingOnOthers().filter((a) => a.kind !== "pricing");
  const sheets = room.sheets.filter((s) => !sheetNeedsMe(s) && s.status !== "accepted");
  if (!items.length && !sheets.length) return "";
  const groups = new Map();
  const add = (uid, row) => { const k = uid || "client"; if (!groups.has(k)) groups.set(k, { uid, rows: [] }); groups.get(k).rows.push(row); };
  for (const a of items) {
    const [sl] = REQ_STATUS[a.status] || [a.status];
    add(waitingOn(a), `<li><span class="wait__kind">${esc(KIND[a.kind])}</span><span class="wait__title">${esc(a.title)}</span><span class="wait__meta">${a.status === "submitted" ? `answered, ${esc(sl.toLowerCase())}` : esc(sl.toLowerCase())}${dueBit(a) ? ` · ${dueBit(a)}` : ` · asked ${esc(relTime(a.created_at))}`}</span></li>`);
  }
  for (const s of sheets) {
    const t = sovTotals(s, room.sheetLines.get(s.id) || []);
    const who = s.status === "submitted" ? null : s.contractor_id;
    add(who, `<li><span class="wait__kind">Pricing</span><a class="wait__title" href="#pricing" data-goto-sheet="${esc(s.id)}">${esc(s.title)}</a><span class="wait__meta">${esc((SHEET_STATUS[s.status]?.[0] || s.status).toLowerCase())} · ${t.answered} of ${t.count} lines</span></li>`);
  }
  return `<section class="p-card home-wait" aria-label="Waiting on others"><h2 class="p-kicker">Waiting on others</h2>
    ${[...groups.values()].map((g) => `<div class="wait-group">
      <p class="wait-group__who">${g.uid && isPrincipal(g.uid) ? `<img class="msg__avatar" src="../assets/img/michael-furth-avatar.webp" alt="" width="28" height="28">` : `<span class="msg__avatar msg__avatar--initials" aria-hidden="true">${esc(initials(realName(g.uid)))}</span>`}
        <b>${esc(g.uid === me() ? "You" : realName(g.uid))}</b>${g.uid ? `<span>${esc(personRole(g.uid))}</span>` : `<span>${esc(room.roster?.client?.organization || "Client")}</span>`}<span class="wait-group__n">${g.rows.length}</span></p>
      <ul class="wait-list">${g.rows.join("")}</ul></div>`).join("")}
  </section>`;
}

function newCard() {
  const fresh = bell ? bell.unread(eng.id).slice(0, 8) : [];
  return `<section class="p-card home-new" id="home-new" aria-label="New since your last visit">
    <div class="p-row"><h2 class="p-kicker">New since your last visit</h2>${fresh.length ? `<button type="button" class="p-linkbtn" data-alerts-read>Mark all read</button>` : ""}</div>
    ${fresh.length ? `<ul class="new-list">${fresh.map((n) => `<li><a href="#${esc(linkTab(n.link))}" data-alert="${esc(n.id)}"><span class="new-list__title">${esc(n.title)}</span>${n.body ? `<span class="new-list__body">${esc(n.body)}</span>` : ""}<span class="new-list__when">${esc(relTime(n.created_at))}</span></a></li>`).join("")}</ul>`
      : `<p class="p-muted">You’re up to date. New documents, answers, messages and pricing changes appear here and under the bell.</p>`}
  </section>`;
}

function pricingCard() {
  if (!room.sheets.length) return "";
  return `<section class="p-card home-price" aria-label="Pricing"><h2 class="p-kicker">Pricing</h2>
    <ul class="price-list">${room.sheets.map((s) => {
      const t = sovTotals(s, room.sheetLines.get(s.id) || [], room.budget);
      const pct = t.count ? t.answered / t.count : 0;
      return `<li><div class="p-row"><a class="price-list__title" href="#pricing" data-goto-sheet="${esc(s.id)}">${esc(s.title)}</a>${sheetPill(s.status)}</div>
        <div class="p-progress" role="progressbar" aria-valuenow="${Math.round(pct * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="Lines answered"><span style="transform:scaleX(${pct})"></span></div>
        <p class="p-muted">${t.answered} of ${t.count} lines${t.total ? ` · ${money(t.total)}` : ""}${t.perSf ? ` · $${Math.round(t.perSf)}/SF` : ""}${t.budget && t.budget.pricedBudget ? ` · <span class="${t.budget.variance > 0 ? "is-over" : "is-under"}">${t.budget.variance > 0 ? "+" : "−"}${money(Math.abs(t.budget.variance))} vs budget on priced lines</span>` : ""}</p></li>`;
    }).join("")}</ul>
  </section>`;
}

function projectCard() {
  const sm = room.modelSummary;
  if (!sm) return "";
  const r = sm.result, y2 = r.years[1];
  const open = sm.inputs.filter((i) => i.status !== "confirmed").length;
  const mine = sm.inputs.filter((i) => i.owner_id === me() && i.status !== "confirmed").length;
  return `<section class="p-card p-card--navy home-pm" aria-label="Project model"><h2 class="p-kicker">The project</h2>
    <p class="home-pm__total">${money(r.total)}</p><p class="home-pm__sub">total project cost${r.perSf ? ` · $${Math.round(r.perSf)}/SF` : ""}</p>
    <dl class="home-pm__figs"><div><dt>Loan</dt><dd>${money(r.loan)}</dd></div><div><dt>Equity</dt><dd>${money(r.equity)}</dd></div>
      <div><dt>Coverage, year 2</dt><dd>${y2.dscr == null ? "—" : `${y2.dscr.toFixed(2)}×`}</dd></div></dl>
    <p class="home-pm__open">${open ? `${open} assumption${open > 1 ? "s" : ""} still open${mine ? ` · <b>${mine} for you</b>` : ""}` : "Every assumption confirmed"}</p>
    <a class="btn btn--gold btn--sm" href="#project">Open the model</a>
  </section>`;
}

function ownerCard() {
  const sm = room.ownerSummary;
  if (!sm) return "";
  const r = sm.result, g = r.global;
  const mine = sm.inputs.filter((i) => i.owner_id === me() && i.status !== "confirmed").length + sm.findings.filter((f) => f.owner_id === me() && !["resolved", "dismissed"].includes(f.status)).length;
  return `<section class="p-card p-card--navy home-pm" aria-label="Owner model"><h2 class="p-kicker">Books and tax</h2>
    <p class="home-pm__total">${g.cfads == null ? "—" : money(g.cfads)}</p><p class="home-pm__sub">recurring cash flow from the businesses</p>
    <dl class="home-pm__figs"><div><dt>Coverage</dt><dd>${g.dscr == null ? "—" : `${g.dscr.toFixed(2)}×`}</dd></div><div><dt>Cost seg., yr 1</dt><dd>${money(r.seg.extra)}</dd></div>
      <div><dt>Open findings</dt><dd>${r.findings.open}</dd></div></dl>
    <p class="home-pm__open">${r.findings.critical ? `${r.findings.critical} critical finding${r.findings.critical > 1 ? "s" : ""} open` : "No critical findings open"}${mine ? ` · <b>${mine} for you</b>` : ""}</p>
    <a class="btn btn--gold btn--sm" href="#owner">Open books and tax</a>
  </section>`;
}

function recentCard() {
  const items = (room.activity || []).filter((a) => TIMELINE[a.kind]);
  if (!items.length) return "";
  const row = (a) => { const [text, icon] = TIMELINE[a.kind](a.detail || {}); return `<li class="timeline__item timeline__item--${icon}"><span class="timeline__dot" aria-hidden="true"></span><p class="timeline__text">${esc(text)}</p><p class="timeline__when"><time datetime="${esc(a.created_at)}">${esc(relTime(a.created_at))}</time></p></li>`; };
  return `<section class="p-card" aria-label="Recent activity"><h2 class="p-kicker">Recent activity</h2>
    <ol class="timeline timeline--compact">${items.slice(0, 6).map(row).join("")}</ol>
    ${items.length > 6 ? `<details class="room-older"><summary>The full timeline (${items.length})</summary>${viewTimeline(true)}</details>` : ""}
  </section>`;
}

function viewHome() {
  if (isMember()) {
    return `<div class="p-grid">
      <div class="p-stack">${attentionCard()}${waitingCard()}</div>
      <div class="p-stack">${newCard()}${projectCard()}${ownerCard()}${pricingCard()}
        ${myMembership()?.can_message ? `<section class="p-card room-msgpeek"><h2 class="p-kicker">Team thread</h2>
          ${room.teamMessages.length ? (() => { const l = room.teamMessages[room.teamMessages.length - 1]; return `<p class="room-msgpeek__who">${esc(personName(l.author_id))} · ${esc(relTime(l.created_at))}${unread.team ? ` <span class="pill pill--gold">${unread.team} new</span>` : ""}</p><p class="room-msgpeek__body">${esc(l.body.length > 180 ? `${l.body.slice(0, 180)}…` : l.body)}</p>`; })() : `<p class="p-muted">No messages yet.</p>`}
          <a class="btn btn--ghost btn--sm" href="#messages">Open the thread</a></section>` : ""}
        ${principalCard()}</div>
    </div>`;
  }
  return `<div class="p-grid">
    <div class="p-stack">${attentionCard()}${waitingCard()}${newCard()}${updatesCard()}${recentCard()}</div>
    <div class="p-stack">${meetingCard()}${projectCard()}${whereThingsStand()}${pricingCard()}${latestMessageCard()}${teamPeek()}${principalCard()}</div>
  </div>`;
}

/* -------------------------------------------------------------- project */
function viewProject() {
  return `<div class="pm-root" id="pm-root" data-model="${esc(room.models[0].id)}"><div class="p-loading">Loading the model…</div></div>`;
}
async function mountProject() {
  const root = document.getElementById("pm-root");
  if (!root) return;
  pm?.destroy();
  pm = null;
  const r = room.roster || {};
  const people = [r.client && { id: r.client.user_id, name: `${r.client.name} (client)` }, ...(r.members || []).filter((m) => m.status === "active" && m.can_model).map((m) => ({ id: m.user_id, name: m.name }))].filter(Boolean);
  try {
    pm = await mountModel(root, { modelId: root.dataset.model, role: isMember() ? "viewer" : "owner", me: me(), nameOf: realName, people, pricingHref: room.sheets.length ? "#pricing" : "#project" });
  } catch (err) { root.innerHTML = `<p class="p-empty">${esc(err.message)}</p>`; }
}

/* ---------------------------------------------------------------- owner */
let om = null;
function viewOwner() {
  return `<div class="pm-root" id="om-root" data-model="${esc(room.owners[0].id)}"><div class="p-loading">Loading the model…</div></div>`;
}
async function mountOwnerTab() {
  const root = document.getElementById("om-root");
  if (!root) return;
  om?.destroy();
  om = null;
  const r = room.roster || {};
  const people = [r.client && { id: r.client.user_id, name: `${r.client.name} (client)` }, ...(r.members || []).filter((m) => m.status === "active" && m.can_model).map((m) => ({ id: m.user_id, name: m.name }))].filter(Boolean);
  // The model's own section bar sticks under the room tabs.
  const tabsEl = document.querySelector(".room-tabs");
  if (tabsEl) root.style.setProperty("--om-bar-top", `${(document.getElementById("p-header")?.offsetHeight || 74) + tabsEl.offsetHeight}px`);
  try {
    om = await mountOwner(root, { modelId: root.dataset.model, role: isMember() ? "viewer" : "owner", me: me(), nameOf: realName, people, projectHref: "#project" });
  } catch (err) { root.innerHTML = `<p class="p-empty">${esc(err.message)}</p>`; }
}

/* -------------------------------------------------------------- pricing */
function currentSheet() {
  let id = null;
  try { id = sessionStorage.getItem(SHEET_KEY); } catch (_) { /* ignore */ }
  return room.sheets.find((s) => s.id === id) || room.sheets.find(sheetNeedsMe) || room.sheets[0];
}
function viewPricing() {
  const cur = currentSheet();
  return `${room.sheets.length > 1 ? `<nav class="sov-pick" aria-label="Pricing sheets">${room.sheets.map((s) => `<button type="button" class="sov-pick__btn"${s.id === cur.id ? ' aria-current="true"' : ""} data-sheet-pick="${esc(s.id)}">${esc(s.title)} ${sheetPill(s.status)}</button>`).join("")}</nav>` : ""}
    <div class="sov-root" id="sov-root" data-sheet="${esc(cur.id)}"><div class="p-loading">Loading the sheet…</div></div>`;
}
async function mountPricing() {
  const root = document.getElementById("sov-root");
  if (!root) return;
  grid?.destroy();
  grid = null;
  try {
    grid = await mountSov(root, {
      sheetId: root.dataset.sheet, role: !isMember() ? "owner" : room.sheets.find((x) => x.id === root.dataset.sheet)?.contractor_id === me() ? "contractor" : "viewer", me: me(), nameOf: realName,
      onStatus: ({ sheet }) => {
        const s = room.sheets.find((x) => x.id === sheet.id);
        if (s && s.status !== sheet.status) { Object.assign(s, sheet); refreshTabs(); }
      },
    });
  } catch (err) { root.innerHTML = `<p class="p-empty">${esc(err.message)}</p>`; }
}

/* ----------------------------------------------------------- client: plan */
function deliverableRow(d, { badge = false } = {}) {
  return `<li class="doc">
    <span class="doc__icon" aria-hidden="true">${ext(d.name)}</span>
    <div class="doc__body"><p class="doc__title">${fileLabel(d.title || d.name)}${badge && d.shared_with_team ? ` <span class="pill pill--teal">Shared with team</span>` : ""}</p>
      ${d.note ? `<p class="doc__note">${esc(d.note)}</p>` : ""}
      <p class="doc__meta">${esc(fmtDate(d.created_at, { month: "short", day: "numeric", year: "numeric" }))}${d.size ? ` · ${esc(fmtSize(d.size))}` : ""}</p></div>
    <button type="button" class="btn btn--ghost btn--sm" data-open-file="${esc(d.path)}" aria-label="Open ${esc(d.title || d.name)}">Open</button>
  </li>`;
}

function viewPlan() {
  const ms = room.milestones;
  const byMs = (id) => room.deliverables.filter((d) => d.milestone_id === id);
  const track = ms.length ? `<ol class="room-track">${ms.map((m) => {
    const docs = byMs(m.id);
    return `<li class="is-${esc(m.status)}">
      <span class="room-track__dot" aria-hidden="true"></span>
      <div><p class="room-track__when">${esc(m.due_label || (m.due_date ? fmtDate(m.due_date, { month: "short", day: "numeric" }) : ""))}${m.status === "current" ? `<span class="room-track__now">In progress</span>` : m.status === "done" ? `<span class="room-track__done">Complete</span>` : ""}</p>
      <h3>${esc(m.title)}</h3>${m.note ? `<p class="p-muted">${esc(m.note)}</p>` : ""}
      ${docs.length ? `<ul class="doc-list doc-list--inline">${docs.map((d) => deliverableRow(d)).join("")}</ul>` : ""}</div></li>`;
  }).join("")}</ol>` : `<p class="p-muted">Milestones appear here once the plan is agreed.</p>`;
  const done = ms.filter((m) => m.status === "done").length;
  const ds = room.decisions;
  return `<div class="p-grid">
    <section class="p-card p-card--accent" aria-label="The plan"><h2 class="p-kicker">The plan</h2>
      ${ms.length ? `<p class="room-track__count"><b>${done}</b> of ${ms.length} milestones complete</p>` : ""}${track}</section>
    <section class="p-card" aria-label="Decision log"><h2 class="p-kicker">Decision log</h2>
      ${ds.length ? `<ol class="room-log">${ds.map((d) => `<li>
        <p class="room-log__date">${esc(fmtDate(d.decided_on, { month: "short", day: "numeric", year: "numeric" }))}</p>
        <div><p class="room-log__what">${esc(d.decision)}</p>${d.rationale ? `<p class="p-muted">${esc(d.rationale)}</p>` : ""}${d.owner ? `<p class="room-log__owner">Owner: ${esc(d.owner)}</p>` : ""}</div>
      </li>`).join("")}</ol>` : `<p class="p-muted">Decisions you and Michael agree on are recorded here, with the reason, so nobody has to remember why.</p>`}
    </section>
  </div>`;
}

/* ------------------------------------------------------ client: documents */
function agreementCard() {
  const a = room.agreement;
  if (!a) return "";
  const o = (a.content?.options || []).find((x) => x.id === a.accepted_option);
  return `<section class="p-card p-card--navy room-agree" aria-label="Your agreement">
    <h2 class="p-kicker">Your agreement</h2>
    <h3>${esc(a.title)}</h3>
    ${o ? `<p class="room-agree__opt">${esc(o.name)}${o.fee ? ` · ${esc(o.fee)}` : ""}</p>` : ""}
    <p class="room-agree__sig">Signed by ${esc(a.signer_name)}${a.signer_title ? `, ${esc(a.signer_title)}` : ""} · ${esc(fmtDate(a.responded_at))}</p>
    <a class="btn btn--gold btn--sm" href="../for/?e=${encodeURIComponent(eng.id)}">Read the agreement</a>
  </section>`;
}

function groupedDeliverables(list, emptyText) {
  const ms = new Map((room.milestones || []).map((m) => [m.id, m]));
  const groups = [];
  for (const d of list) {
    const key = d.milestone_id && ms.has(d.milestone_id) ? d.milestone_id : "";
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, title: key ? ms.get(key).title : "General", pos: key ? ms.get(key).position : 1e9, items: [] }; groups.push(g); }
    g.items.push(d);
  }
  groups.sort((a, b) => a.pos - b.pos);
  if (!groups.length) return `<p class="p-empty">${emptyText}</p>`;
  if (groups.length === 1 && !groups[0].key) return `<ul class="doc-list">${groups[0].items.map((d) => deliverableRow(d, { badge: !isMember() })).join("")}</ul>`;
  return groups.map((g) => `<div class="doc-group"><h3 class="room-sub">${esc(g.title)}</h3><ul class="doc-list">${g.items.map((d) => deliverableRow(d, { badge: !isMember() })).join("")}</ul></div>`).join("");
}

/* -------------------------------------------------------------- billing */
/** Invoice amounts are in cents; shown to the cent. */
const usd = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100);
const INVOICE_STATUS = { open: ["Due", "pill--gold"], paid: ["Paid", "pill--navy"], void: ["Cancelled", ""], uncollectible: ["Written off", ""] };
const openInvoices = () => (isMember() ? [] : (room.invoices || []).filter((i) => i.status === "open" && (i.amount_remaining ?? 1) > 0));
function invoiceRow(inv) {
  const [label, cls] = INVOICE_STATUS[inv.status] || [inv.status, ""];
  const late = inv.status === "open" && overdue(inv.due_date);
  const tax = Number(inv.tax || 0);
  return `<li class="inv${late ? " is-late" : ""}">
    <div class="inv__body"><p class="inv__title">${esc(inv.description || "Invoice")}${inv.number ? ` <span class="p-muted">${esc(inv.number)}</span>` : ""}</p>
      <p class="inv__meta">${usd(inv.total)}${tax ? ` <span class="p-muted">including ${usd(tax)} sales tax</span>` : ""}
        · ${inv.status === "paid" ? `paid ${esc(fmtDate(inv.paid_at, { month: "short", day: "numeric", year: "numeric" }))}` : inv.due_date ? `<span class="${late ? "is-late" : ""}">due ${esc(fmtDate(inv.due_date, { month: "short", day: "numeric", year: "numeric" }))}</span>` : ""}
        ${inv.refunded ? ` · ${usd(inv.refunded)} refunded` : ""}${inv.credited ? ` · ${usd(inv.credited)} credited` : ""}</p></div>
    <span class="pill pill--dot ${late ? "pill--red" : cls}">${esc(late ? "Overdue" : label)}</span>
    <div class="btn-row inv__acts">${inv.status === "open" && inv.hosted_invoice_url ? `<a class="btn btn--navy btn--sm" href="${esc(inv.hosted_invoice_url)}" target="_blank" rel="noopener">Pay ${usd(inv.amount_remaining ?? inv.total)}</a>` : ""}
      ${inv.invoice_pdf ? `<a class="p-linkbtn" href="${esc(inv.invoice_pdf)}" target="_blank" rel="noopener">${inv.status === "paid" ? "Receipt (PDF)" : "PDF"}</a>` : ""}</div></li>`;
}
function viewBilling() {
  const all = room.invoices || [];
  const open = all.filter((i) => i.status === "open"), done = all.filter((i) => i.status !== "open");
  const b = room.billing || {};
  const addr = b.line1 ? `${esc([b.line1, b.line2].filter(Boolean).join(", "))}<br>${esc(`${b.city || ""}${b.state ? `, ${b.state}` : ""} ${b.postal_code || ""}`.trim())}` : "";
  return `<div class="p-grid">
    <section class="p-card p-card--accent" aria-label="Invoices"><h2 class="p-kicker">Invoices</h2>
      <p class="p-muted">Invoices from Sypher Solutions for <em>${esc(eng.title)}</em>. Pay by card or bank account on Stripe's secure page; a receipt is emailed, and kept here.</p>
      ${open.length ? `<h3 class="room-sub">To pay <span class="room-sub__n">${open.length}</span></h3><ul class="inv-list">${open.map(invoiceRow).join("")}</ul>` : `<p class="p-empty">Nothing to pay right now.</p>`}
      ${done.length ? `<h3 class="room-sub">Paid and past</h3><ul class="inv-list">${done.map(invoiceRow).join("")}</ul>` : ""}
    </section>
    <section class="p-card" aria-label="Billing address"><h2 class="p-kicker">Billing address</h2>
      <p class="p-muted">Shown on your invoices. Stripe uses it to work out any sales tax.</p>
      ${addr ? `<p class="bill-addr"><strong>${esc(b.billing_name || "")}</strong>${b.billing_name ? "<br>" : ""}${addr}${b.billing_email ? `<br><span class="p-muted">${esc(b.billing_email)}</span>` : ""}</p>` : `<p class="p-empty">No billing address yet.</p>`}
      <details class="room-add"${addr ? "" : " open"}><summary class="p-linkbtn">${addr ? "Change it" : "Add it"}</summary>
        <form class="p-form p-form--2" id="billing-form">
          <div class="p-field p-span"><label for="bl-name">Name or company</label><input class="p-input" id="bl-name" name="billing_name" value="${esc(b.billing_name || "")}" required></div>
          <div class="p-field p-span"><label for="bl-email">Email for invoices</label><input class="p-input" id="bl-email" name="billing_email" type="email" value="${esc(b.billing_email || session.user.email || "")}"></div>
          <div class="p-field p-span"><label for="bl-l1">Street</label><input class="p-input" id="bl-l1" name="line1" value="${esc(b.line1 || "")}" required autocomplete="address-line1"></div>
          <div class="p-field p-span"><label for="bl-l2">Suite (optional)</label><input class="p-input" id="bl-l2" name="line2" value="${esc(b.line2 || "")}" autocomplete="address-line2"></div>
          <div class="p-field"><label for="bl-city">City</label><input class="p-input" id="bl-city" name="city" value="${esc(b.city || "")}" required autocomplete="address-level2"></div>
          <div class="p-field"><label for="bl-state">State</label><input class="p-input" id="bl-state" name="state" value="${esc(b.state || "")}" required maxlength="2" placeholder="TX" autocomplete="address-level1"></div>
          <div class="p-field"><label for="bl-zip">ZIP code</label><input class="p-input" id="bl-zip" name="postal_code" value="${esc(b.postal_code || "")}" required autocomplete="postal-code"></div>
          <div class="p-span"><button class="btn btn--navy btn--sm" type="submit">Save</button></div>
        </form></details>
    </section>
  </div>`;
}

function viewDocuments() {
  const files = room.files;
  return `<div class="p-grid">
    <section class="p-card p-card--accent" aria-label="From Michael"><h2 class="p-kicker">From Michael</h2>
      ${groupedDeliverables(room.deliverables, "Reports, models and documents Michael shares will appear here, filed by milestone.")}
    </section>
    <div class="p-stack">
      ${agreementCard()}
      <section class="p-card" aria-label="Documents you’ve shared"><h2 class="p-kicker">You’ve shared</h2>
        ${files.length ? `<ul class="doc-list">${files.map((f) => `<li class="doc">
          <span class="doc__icon doc__icon--mine" aria-hidden="true">${ext(f.name)}</span>
          <div class="doc__body"><p class="doc__title">${fileLabel(f.name)}</p><p class="doc__meta">${esc(relTime(f.created_at))}${f.size ? ` · ${esc(fmtSize(f.size))}` : ""}</p></div>
          <button type="button" class="p-linkbtn" data-open-file="${esc(f.path)}" aria-label="Open ${esc(f.name)}">Open</button></li>`).join("")}</ul>`
          : `<p class="p-muted">Files you attach to questionnaire answers are listed here.</p>`}
        ${room.teamFiles?.length ? `<p class="p-muted" style="margin-top:1rem">Files your team shares are in the <a class="accent" href="#team">Team</a> tab.</p>` : ""}
      </section>
    </div>
  </div>`;
}

/* ---------------------------------------------------------- threads */
function threadHtml(list, thread) {
  if (!list.length) {
    return thread === "team"
      ? `<div class="thread__empty"><p>The team thread for <em>${esc(eng.title)}</em>.</p><p class="p-muted">Everyone on the team can read and write here: ${isMember() ? "the client, Michael and the other advisers" : "you, Michael and the people you’ve added"}. Your private thread with Michael stays separate.</p></div>`
      : `<div class="thread__empty"><p>This is your private line to Michael for <em>${esc(eng.title)}</em>.</p><p class="p-muted">Ask anything between meetings. Michael is emailed when you write, and you’re emailed when he replies.${room.roster?.members?.length ? " Nobody you add to your team can see this thread." : ""}</p></div>`;
  }
  let day = "";
  return list.map((m) => {
    const mine = m.author_id === me();
    const d = fmtDate(m.created_at, { weekday: "long", month: "long", day: "numeric" });
    const sep = d !== day ? `<li class="thread__day"><span>${esc(d)}</span></li>` : "";
    day = d;
    const role = thread === "team" && !mine ? personRole(m.author_id) : "";
    return `${sep}<li class="msg${mine ? " msg--mine" : ""}">
      ${mine ? "" : avatar(m.author_id)}
      <div class="msg__bubble"><p class="msg__who">${esc(personName(m.author_id))}${role ? `<span class="msg__role">${esc(role)}</span>` : ""}<time datetime="${esc(m.created_at)}">${esc(new Date(m.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</time></p>
      <div class="msg__body">${paragraphs(m.body)}</div></div></li>`;
  }).join("");
}

function threadCard(thread) {
  const list = thread === "team" ? room.teamMessages : room.messages;
  const team = thread === "team";
  const people = team ? [room.roster?.client?.name, ADMIN_CONTACT.name, ...(room.roster?.members || []).filter((m) => m.status === "active" && m.can_message).map((m) => m.name)].filter(Boolean) : [];
  const head = team
    ? `<div class="thread-card__head"><span class="thread-card__icon" aria-hidden="true">${people.length}</span><div><h2 class="thread-card__name">Team thread</h2><p class="p-muted">${esc(people.join(", "))}</p></div></div>`
    : `<div class="thread-card__head"><img src="../assets/img/michael-furth-avatar.webp" alt="" width="44" height="44"><div><h2 class="thread-card__name">${esc(ADMIN_CONTACT.name)}</h2><p class="p-muted">${esc(ADMIN_CONTACT.title)} · Private${ADMIN_CONTACT.response_promise ? ` · ${esc(ADMIN_CONTACT.response_promise)}` : ""}</p></div></div>`;
  return `<section class="p-card thread-card" aria-label="${team ? "Team thread" : `Messages with ${esc(ADMIN_CONTACT.name)}`}">
    ${head}
    <ol class="thread" data-thread="${thread}" aria-live="polite">${threadHtml(list, thread)}</ol>
    <form class="composer" data-composer="${thread}">
      <label class="visually-hidden" for="composer-${thread}">${team ? "Message to the team" : "Message to Michael"}</label>
      <textarea class="p-textarea composer__text" id="composer-${thread}" name="body" rows="3" maxlength="8000" placeholder="${team ? "Write to the team…" : "Write to Michael…"}" required></textarea>
      <div class="composer__bar"><span class="p-muted composer__hint">Ctrl + Enter to send</span>
        <button class="btn btn--navy btn--sm" type="submit">Send
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M1 8h13M9 3l5 5-5 5"/></svg></button></div>
    </form>
  </section>`;
}

function viewMessages() {
  return `<div class="thread-wrap">${threadCard(isMember() ? "team" : "private")}</div>`;
}

function scrollThreads() {
  document.querySelectorAll(".thread").forEach((t) => { t.scrollTop = t.scrollHeight; });
}

async function markReadIfNeeded() {
  if (document.hidden) return;
  const t = tab();
  try {
    if (!isMember() && t === "messages" && unread.private) {
      await store.markRead(eng.id);
      room.messages.forEach((m) => { if (m.author_id !== me()) m.read_at = m.read_at || new Date().toISOString(); });
    }
    if (((isMember() && t === "messages") || (!isMember() && t === "team")) && unread.team) {
      await store.markTeamRead(eng.id);
      room.teamLastRead = new Date().toISOString();
    }
    const before = unread.private + unread.team;
    countUnread();
    if (unread.private + unread.team !== before) refreshTabs();
  } catch (err) { console.warn(err); }
}

function refreshTabs() {
  const nav = document.querySelector(".room-tabs");
  if (nav) nav.outerHTML = tabs();
  // On a narrow screen the strip scrolls sideways: keep the current tab in sight.
  const inner = document.querySelector(".room-tabs__inner"), cur = inner?.querySelector('[aria-current="page"]');
  if (inner && cur) { const a = cur.getBoundingClientRect(), b = inner.getBoundingClientRect(); if (a.left < b.left || a.right > b.right) inner.scrollLeft += a.left - b.left - 16; }
}
/** The scroll position that puts the tabs just under the header: the top of a tab's content. */
function tabsTop() {
  const cover = document.querySelector(".room-cover");
  return cover ? cover.offsetTop + cover.offsetHeight - (document.getElementById("p-header")?.offsetHeight || 0) : 0;
}

async function poll() {
  if (document.hidden || !eng || !room) return;
  try {
    const canTeam = isMember() ? myMembership()?.can_message : true;
    const [priv, team] = await Promise.all([isMember() ? [] : store.messages(eng.id), canTeam ? store.messages(eng.id, "team") : []]);
    const changed = priv.length !== (room.messages || []).length || team.length !== (room.teamMessages || []).length;
    if (!changed) return;
    room.messages = priv; room.teamMessages = team;
    countUnread();
    for (const el of document.querySelectorAll(".thread[data-thread]")) {
      el.innerHTML = threadHtml(el.dataset.thread === "team" ? room.teamMessages : room.messages, el.dataset.thread);
    }
    scrollThreads();
    refreshTabs();
    await markReadIfNeeded();
  } catch (err) { console.warn(err); }
}

/* --------------------------------------------------------- team (client) */
function accessText(m) {
  if (m.status === "revoked") return "Access removed";
  if (m.status === "expired") return `Access ended ${fmtDate(m.expires_at, { month: "short", day: "numeric" })}`;
  return m.expires_at ? `Until ${fmtDate(m.expires_at, { month: "short", day: "numeric", year: "numeric" })}` : "Until the engagement ends";
}

function peopleCard() {
  const r = room.roster || { members: [] };
  const members = r.members || [];
  const fixed = `<li class="person"><span class="msg__avatar msg__avatar--initials" aria-hidden="true">${esc(initials(r.client?.name || session.profile.full_name))}</span>
      <div class="person__body"><p class="person__name">${esc(r.client?.name || "You")} <span class="p-muted">(you)</span></p><p class="person__role">Client · full access</p></div></li>
    <li class="person"><img class="msg__avatar" src="../assets/img/michael-furth-avatar.webp" alt="" width="36" height="36">
      <div class="person__body"><p class="person__name">${esc(ADMIN_CONTACT.name)}</p><p class="person__role">Sypher Solutions · full access</p></div></li>`;
  const row = (m) => `<li class="person${m.status !== "active" ? " is-off" : ""}">
    <span class="msg__avatar msg__avatar--initials" aria-hidden="true">${esc(initials(m.name))}</span>
    <div class="person__body">
      <p class="person__name">${esc(m.name)}</p>
      <p class="person__role">${esc([m.role_label, m.organization].filter(Boolean).join(", ") || m.email || "")}</p>
      <p class="person__access">${esc(accessText(m))} · ${[m.can_message && "messages", m.can_files && "files", m.can_model && "the models", "requests"].filter(Boolean).join(", ")}${m.last_seen_at ? ` · last in ${esc(relTime(m.last_seen_at))}` : m.status === "active" ? " · hasn’t signed in yet" : ""}</p>
    </div>
    <details class="person__manage"><summary class="p-linkbtn">Manage</summary>
      <div class="person__menu">
        ${m.status === "active" ? `
          <label class="p-check"><input type="checkbox" data-member-perm="can_message" data-member="${esc(m.id)}"${m.can_message ? " checked" : ""}> Team messages</label>
          <label class="p-check"><input type="checkbox" data-member-perm="can_files" data-member="${esc(m.id)}"${m.can_files ? " checked" : ""}> Files</label>
          ${(room.models?.length || room.owners?.length) && !room.sheets.some((sh) => sh.contractor_id === m.user_id) ? `<label class="p-check"><input type="checkbox" data-member-model="${esc(m.id)}"${m.can_model ? " checked" : ""}> ${[room.models?.length && "Project model (budget, financing, cash flow)", room.owners?.length && "Books and tax (the owner model)"].filter(Boolean).join(" and ")}</label>` : ""}
          <div class="btn-row" style="gap:.5rem 1rem">
            <button type="button" class="p-linkbtn" data-member-extend="${esc(m.id)}">Extend 30 days</button>
            <button type="button" class="p-linkbtn p-linkbtn--danger" data-member-revoke="${esc(m.id)}">Remove access</button>
          </div>`
          : `<button type="button" class="p-linkbtn" data-member-restore="${esc(m.id)}">Restore for 30 days</button>`}
      </div></details>
  </li>`;
  return `<section class="p-card" aria-label="People"><h2 class="p-kicker">People</h2>
    <ul class="people">${fixed}${members.map(row).join("")}</ul>
    <details class="room-add"${members.length ? "" : " open"}><summary class="p-linkbtn">Add someone</summary>
      <p class="p-muted room-add__lede">They’ll get an email to set up access. They can see the team thread, team files and their own tasks. They can’t see your private messages with Michael, questionnaires, updates or the plan. Michael is told when you add someone.</p>
      <form class="p-form p-form--2" id="member-form">
        <div class="p-field"><label for="mb-name">Name</label><input class="p-input" id="mb-name" name="full_name" required maxlength="120" autocomplete="off"></div>
        <div class="p-field"><label for="mb-email">Email</label><input class="p-input" id="mb-email" name="email" type="email" required autocomplete="off"></div>
        <div class="p-field"><label for="mb-role">Role</label><select class="p-select" id="mb-role" name="role_label">${ROLES.map((r) => `<option>${esc(r)}</option>`).join("")}</select></div>
        <div class="p-field"><label for="mb-org">Firm (optional)</label><input class="p-input" id="mb-org" name="organization" maxlength="160"></div>
        <div class="p-field p-span"><label for="mb-len">Access</label><select class="p-select" id="mb-len" name="length">
          <option value="30">30 days</option><option value="90" selected>90 days</option><option value="">Until the engagement ends</option></select></div>
        <div class="p-span room-add__perms"><label class="p-check"><input type="checkbox" name="can_message" checked> Can message the team</label>
          <label class="p-check"><input type="checkbox" name="can_files" checked> Can see and add files</label></div>
        <div class="p-span"><button class="btn btn--navy btn--sm" type="submit">Send invitation</button></div>
      </form></details>
  </section>`;
}

function teamFileRow(f) {
  const canRemove = f.uploaded_by === me() || !isMember();
  return `<li class="doc">
    <span class="doc__icon doc__icon--mine" aria-hidden="true">${ext(f.name)}</span>
    <div class="doc__body"><p class="doc__title">${fileLabel(f.name)}</p>${f.note ? `<p class="doc__note">${esc(f.note)}</p>` : ""}
      <p class="doc__meta">${esc(personName(f.uploaded_by))} · ${esc(relTime(f.created_at))}${f.size ? ` · ${esc(fmtSize(f.size))}` : ""}</p></div>
    <div class="doc__actions"><button type="button" class="btn btn--ghost btn--sm" data-open-file="${esc(f.path)}" aria-label="Open ${esc(f.name)}">Open</button>
      ${canRemove ? `<button type="button" class="p-linkbtn" data-team-file-delete="${esc(f.id)}">Remove</button>` : ""}</div>
  </li>`;
}

function teamFilesCard({ withShared = false } = {}) {
  const shared = withShared ? room.deliverables : [];
  return `<section class="p-card" aria-label="Team files"><h2 class="p-kicker">Team files</h2>
    ${shared.length ? `<h3 class="room-sub">Shared by Michael</h3><ul class="doc-list">${shared.map((d) => deliverableRow(d)).join("")}</ul><h3 class="room-sub">From the team</h3>` : ""}
    ${room.teamFiles.length ? `<ul class="doc-list">${room.teamFiles.map(teamFileRow).join("")}</ul>` : `<p class="p-muted">Files anyone on the team adds appear here. Up to 50 MB each.</p>`}
    <form class="team-upload" id="team-file-form">
      <label class="btn btn--ghost btn--sm file-btn">Choose a file<input type="file" name="file" accept="${FILE_ACCEPT}" required></label>
      <span class="team-upload__name p-muted" aria-live="polite"></span>
      <input class="p-input team-upload__note" name="note" maxlength="300" placeholder="Note (optional)" aria-label="Note about the file">
      <button class="btn btn--navy btn--sm" type="submit">Upload</button>
    </form>
  </section>`;
}

function teamTasksCard() {
  const items = room.actions.filter((a) => a.assignee_id && a.assignee_id !== me());
  return `<section class="p-card" aria-label="Team tasks"><h2 class="p-kicker">Team tasks</h2>
    ${items.length ? actionList(items, { showAssignee: true, canDelete: true }) : `<p class="p-muted">Give anyone on the team a task, with a due date. They’re emailed and tick it off when it’s done.</p>`}
    ${(room.roster?.members || []).some((m) => m.status === "active") ? taskForm() : ""}
  </section>`;
}

function viewTeam() {
  return `<div class="p-grid">
    <div class="p-stack">${threadCard("team")}${teamTasksCard()}</div>
    <div class="p-stack">${peopleCard()}${teamFilesCard()}</div>
  </div>`;
}

/* ------------------------------------------------------- member views */
function viewMemberFiles() {
  return `<div class="thread-wrap">${teamFilesCard({ withShared: true })}</div>`;
}

/* ------------------------------------------------------------ timeline */
const TIMELINE = {
  client_invited: () => ["Your client room opened", "room"],
  proposal_accepted: (d) => [`Proposal accepted${d.title ? `: ${d.title}` : ""}`, "sign"],
  assignment_created: () => ["A questionnaire was shared with you", "ask"],
  assignment_submitted: () => ["You submitted your answers", "ask"],
  update_published: (d) => [`Update from Michael${d.title ? `: ${d.title}` : ""}`, "update"],
  message_posted: (d) => [d.thread === "team"
    ? (d.from === "client" ? "You wrote in the team thread" : d.from === "principal" ? "Michael wrote in the team thread" : "A team member wrote in the team thread")
    : (d.from === "principal" ? "Michael sent a message" : "You wrote to Michael"), "msg"],
  deliverable_shared: (d) => [`Document shared: ${d.title || ""}`, "doc"],
  team_file_shared: (d) => [`Team file added: ${d.title || ""}`, "doc"],
  action_assigned: (d) => [`New task${d.assignee_id ? "" : " for you"}: ${d.title || ""}`, "todo"],
  action_done: (d) => [`Done: ${d.title || ""}`, "check"],
  decision_recorded: (d) => [`Decision recorded: ${d.title || ""}`, "decide"],
  milestone_current: (d) => [`Under way: ${d.title || ""}`, "ms"],
  milestone_done: (d) => [`Milestone complete: ${d.title || ""}`, "check"],
  member_invited: (d) => [`Joined the team: ${d.title || ""}`, "room"],
  member_revoked: (d) => [`Team access removed: ${d.title || ""}`, "room"],
  request_submitted: (d) => [`Answered: ${d.title || ""}`, "todo"],
  request_accepted: (d) => [`Accepted: ${d.title || ""}`, "check"],
  request_changes: (d) => [`Changes asked for: ${d.title || ""}`, "todo"],
  pricing_submitted: (d) => [`Pricing submitted: ${d.title || ""}${d.version ? ` (version ${d.version})` : ""}`, "doc"],
  pricing_accepted: (d) => [`Pricing accepted: ${d.title || ""}`, "check"],
  pricing_changes: (d) => [`Pricing sent back: ${d.title || ""}`, "todo"],
  invoice_sent: (d) => [`Invoice sent: ${d.title || ""}${d.number ? ` (${d.number})` : ""}`, "doc"],
  invoice_paid: (d) => [`Invoice paid: ${d.title || ""}${d.number ? ` (${d.number})` : ""}`, "check"],
  invoice_payment_failed: (d) => [`A payment didn't go through: ${d.title || ""}`, "todo"],
  invoice_voided: (d) => [`Invoice cancelled: ${d.title || ""}`, "check"],
  invoice_refunded: (d) => [`Refund issued: ${d.title || ""}`, "check"],
  invoice_credited: (d) => [`Credit issued: ${d.title || ""}`, "check"],
};

function viewTimeline(inner = false) {
  const items = room.activity.filter((a) => TIMELINE[a.kind]);
  if (!items.length) return `<section class="p-card"><p class="p-empty">The story of the engagement will build up here.</p></section>`;
  let month = "";
  const wrap = (html) => (inner ? html : `<section class="p-card p-card--accent" aria-label="Timeline"><h2 class="p-kicker">Timeline</h2>${html}</section>`);
  return wrap(`<ol class="timeline">${items.map((a) => {
    const [text, icon] = TIMELINE[a.kind](a.detail || {});
    const m = fmtDate(a.created_at, { month: "long", year: "numeric" });
    const head = m !== month ? `<li class="timeline__month">${esc(m)}</li>` : "";
    month = m;
    return `${head}<li class="timeline__item timeline__item--${icon}"><span class="timeline__dot" aria-hidden="true"></span>
      <p class="timeline__text">${esc(text)}</p><p class="timeline__when"><time datetime="${esc(a.created_at)}">${esc(fmtDate(a.created_at, { month: "short", day: "numeric" }))} · ${esc(new Date(a.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</time></p></li>`;
  }).join("")}</ol>`);
}

/* -------------------------------------------------------------- render */
// Opening a tab marks the alerts that point at it as seen.
const SEEN = { requests: ["requests"], pricing: ["pricing"], project: ["project"], owner: ["owner"], documents: ["documents"], messages: ["messages"], plan: ["plan"], team: ["files"], files: ["files", "documents"] };
/** The tab an alert's link opens, for this person. */
function linkTab(link) {
  const t = isMember() ? { documents: "files", plan: "home", files: "files" }[link] || link : { files: "team" }[link] || link;
  return tabList().some(([k]) => k === t) ? t : "home";
}

function renderTab(focus = false) {
  const views = isMember()
    ? { home: viewHome, requests: viewRequests, pricing: viewPricing, project: viewProject, owner: viewOwner, messages: viewMessages, files: viewMemberFiles }
    : { home: viewHome, requests: viewRequests, pricing: viewPricing, project: viewProject, owner: viewOwner, plan: viewPlan, documents: viewDocuments, billing: viewBilling, messages: viewMessages, team: viewTeam };
  const t = tab();
  if (location.hash.slice(1) && location.hash.slice(1) !== t && ALIASES[location.hash.slice(1)]) history.replaceState(null, "", `#${t}`);
  if (t !== "pricing" && grid) { grid.destroy(); grid = null; }
  if (t !== "project" && pm) { pm.destroy(); pm = null; }
  if (t !== "owner" && om) { om.destroy(); om = null; }
  bell?.markSeen(eng.id, SEEN[t] || []);
  refreshTabs();
  // Stick the tabs just under the portal header, whatever height it renders at.
  const header = document.getElementById("p-header");
  if (header) document.documentElement.style.setProperty("--p-header-h", `${header.offsetHeight}px`);
  const body = document.getElementById("room-body");
  body.classList.toggle("room-body--wide", t === "pricing" || t === "project" || t === "owner");
  if (t === "project" && pm && document.getElementById("pm-root")) return; // already showing
  if (t === "owner" && om && document.getElementById("om-root")) return;
  if (t === "pricing" && grid && document.getElementById("sov-root")?.dataset.sheet === currentSheet()?.id) return; // already showing
  body.innerHTML = views[t]();
  // Switching tabs from further down the page starts the new tab at its top, not partway down.
  if (focus && window.scrollY > tabsTop()) window.scrollTo({ top: tabsTop() });
  scrollThreads();
  markReadIfNeeded();
  if (t === "project") mountProject();
  if (t === "owner") mountOwnerTab();
  if (t === "pricing") {
    // The sheet is the work: once it's drawn, bring it up under the tabs.
    mountPricing().then(() => {
      const tabsEl = document.querySelector(".room-tabs");
      if (tabsEl && focus && window.scrollY < tabsEl.offsetTop) window.scrollTo({ top: tabsEl.offsetTop - (document.getElementById("p-header")?.offsetHeight || 0) });
    });
  }
  if (focusReq) {
    const el = document.getElementById(`req-${focusReq}`);
    focusReq = null;
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("is-flash"); (el.querySelector("textarea, .btn") || el).focus({ preventScroll: true }); return; }
  }
  if (focus) body.focus({ preventScroll: true });
}

function mount() {
  main.innerHTML = `${cover()}${tabs()}<div class="p-shell room-body" id="room-body" tabindex="-1"></div>`;
  renderTab();
}

async function render() {
  session = await requireSession();
  if (!session) return;
  renderChrome(session, { active: "dashboard", admin: session.profile.role === "admin" });

  engagements = await store.myEngagements();
  if (!engagements.length) {
    const first = (session.profile.full_name || "").split(" ")[0];
    main.innerHTML = `<div class="p-shell"><div class="p-greeting"><h1>${esc(greeting())}${first ? `, <em>${esc(first)}.</em>` : "."}</h1>
      <p>Nothing is shared with you right now. If you were added to a team, your access may have ended; the person who invited you can renew it.</p></div></div>`;
    return;
  }
  let saved = null;
  try { saved = sessionStorage.getItem(ENG_KEY); } catch (_) { /* ignore */ }
  eng = engagements.find((e) => e.id === saved) || engagements.find((e) => e.status === "active" && e.access !== "member") || engagements[0];
  await loadRoom();
  mount();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
  bell = await mountBell({
    me: me(),
    titleOf: (id) => (engagements.length > 1 ? engagements.find((e) => e.id === id)?.title || "" : ""),
    open: openAlert,
    onChange: onAlert,
  }).catch((err) => { console.warn("Alerts unavailable:", err.message); return null; });
  // A payment made on Stripe's page (another tab) shows here as soon as Stripe tells the portal.
  if (engagements.some((e) => e.access !== "member")) {
    store.subscribe("billing", [{ table: "invoices", filter: `client_id=eq.${me()}` }], ({ new: row, old }) => {
      if ((row?.engagement_id || old?.engagement_id) !== eng?.id) return;
      if (row?.status === "paid" && room?.invoices?.some((i) => i.id === row.id && i.status !== "paid")) toast("Payment received. Thank you.");
      clearTimeout(softTimer);
      softTimer = setTimeout(softReload, 600);
    }).catch((err) => console.warn("Live billing updates unavailable:", err.message));
  }
  refreshTabs();
  if (tab() === "home") repaintNew();
}

async function switchTo(id) {
  try { sessionStorage.setItem(ENG_KEY, id); } catch (_) { /* ignore */ }
  grid?.destroy(); grid = null;
  pm?.destroy(); pm = null;
  eng = engagements.find((x) => x.id === id);
  main.innerHTML = `<div class="p-loading">Loading…</div>`;
  history.replaceState(null, "", location.pathname);
  await loadRoom();
  mount();
}

async function openAlert(n) {
  if (n.engagement_id && n.engagement_id !== eng.id && engagements.some((e) => e.id === n.engagement_id)) await switchTo(n.engagement_id);
  const t = linkTab(n.link);
  if (location.hash.slice(1) === t) renderTab(true); else location.hash = t;
}

function repaintNew() {
  const el = document.getElementById("home-new");
  if (el) el.outerHTML = newCard();
}

/** Something new arrived (or alerts were read). Refresh what's on screen, unless the person is typing. */
function onAlert(row) {
  refreshTabs();
  if (tab() === "home") repaintNew();
  if (!row || row.engagement_id !== eng?.id) return;
  clearTimeout(softTimer);
  softTimer = setTimeout(softReload, 600);
}
async function softReload() {
  const body = document.getElementById("room-body");
  const typing = body && body.contains(document.activeElement) && document.activeElement.matches("input, textarea, select");
  try {
    await loadRoom();
    refreshTabs();
    if (tab() === "pricing" || tab() === "project" || tab() === "owner" || typing) return; // the grid keeps itself current; never wipe what someone is typing
    const y = window.scrollY;
    renderTab();
    window.scrollTo(0, y);
  } catch (err) { console.warn(err); }
}

async function reload() {
  await loadRoom();
  const y = window.scrollY;
  grid?.destroy(); grid = null;
  pm?.destroy(); pm = null;
  mount();
  window.scrollTo(0, y);
}

/* -------------------------------------------------------------- events */
function ics() {
  const start = new Date(eng.next_meeting_at);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(start.getTime() + 3600_000);
  const text = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (m) => `\\${m}`);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sypher Solutions//Client Room//EN", "BEGIN:VEVENT",
    `UID:${eng.id}-${stamp(start)}@sypher.solutions`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${text(`${eng.title} · Sypher Solutions`)}`, `DESCRIPTION:${text(eng.next_meeting_note || "")}`,
    eng.meeting_link ? `URL:${text(eng.meeting_link)}` : "", `ORGANIZER;CN=${text(ADMIN_CONTACT.name)}:mailto:${ADMIN_CONTACT.email}`,
    "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
}

const memberById = (id) => room.roster?.members?.find((m) => m.id === id);

window.addEventListener("hashchange", () => { if (room) renderTab(true); });
// Choosing the tab you're already on takes you back to its top.
document.addEventListener("click", (e) => {
  const a = e.target.closest(".room-tabs__link[aria-current='page']");
  if (a && room && window.scrollY > tabsTop() + 4) { e.preventDefault(); window.scrollTo({ top: tabsTop(), behavior: "smooth" }); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

main.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  try {
    if (t.hasAttribute("data-ics")) { download("sypher-meeting.ics", ics(), "text/calendar"); return; }
    if (t.dataset.compose) {
      e.preventDefault();
      location.hash = "messages";
      setTimeout(() => { const box = document.getElementById("composer-private"); if (box) { box.value = t.dataset.compose; box.focus(); } }, 0);
      return;
    }
    if (t.dataset.openFile) {
      const win = window.open("", "_blank"); // open synchronously so pop-up blockers allow it
      try {
        const url = await store.fileUrl(t.dataset.openFile);
        if (win) win.location.href = url; else location.href = url;
      } catch (err) { if (win) win.close(); throw new Error(`Couldn’t open the file: ${err.message}`); }
      return;
    }
    if (t.dataset.gotoReq) { focusReq = t.dataset.gotoReq; if (location.hash === "#requests") { e.preventDefault(); renderTab(); } return; }
    if (t.dataset.gotoSheet) { try { sessionStorage.setItem(SHEET_KEY, t.dataset.gotoSheet); } catch (_) { /* ignore */ } if (location.hash === "#pricing") { e.preventDefault(); grid?.destroy(); grid = null; renderTab(); } return; }
    if (t.dataset.sheetPick) { try { sessionStorage.setItem(SHEET_KEY, t.dataset.sheetPick); } catch (_) { /* ignore */ } await grid?.flush(); grid?.destroy(); grid = null; renderTab(); return; }
    if (t.dataset.alert) { e.preventDefault(); const n = bell?.list.find((x) => x.id === t.dataset.alert); if (n) { await bell.markRead([n.id]); openAlert(n); } return; }
    if (t.hasAttribute("data-alerts-read")) { const ids = bell?.unread(eng.id).map((n) => n.id) || []; if (ids.length) await bell.markRead(ids); repaintNew(); return; }
    if (t.dataset.reqDone) {
      t.disabled = true;
      await store.submitRequest(t.dataset.reqDone);
      toast("Marked done. Everyone on it can see.");
      await reload();
      return;
    }
    if (t.dataset.reqUndo) { await store.setActionDone(t.dataset.reqUndo, false); toast("Moved back to the list."); await reload(); return; }
    if (t.dataset.reqReview) {
      const a = room.actions.find((x) => x.id === t.dataset.req);
      if (!a) return;
      if (t.dataset.reqReview === "accept") {
        await store.reviewRequest(a.id, true);
        toast(`Accepted. ${askedName(a)} has been told.`);
      } else {
        const note = await promptDialog({ title: "Ask for changes", body: `<p class="p-muted">${esc(a.title)}</p>`, label: "What needs to change", required: true, confirmLabel: "Send back" });
        if (!note) return;
        await store.reviewRequest(a.id, false, note);
        toast("Sent back with your note.");
      }
      const n = await store.notify("request_update", a.id);
      if (n?.reason === "email failed") toastNotice(n, "", t.dataset.reqReview === "accept" ? "Accepted." : "Sent back.");
      await reload();
      return;
    }
    if (t.dataset.reqFileDelete) {
      const f = room.requestFiles.find((x) => x.id === t.dataset.reqFileDelete);
      if (f && await confirmDialog({ title: "Remove this file?", body: `<p><strong>${esc(f.name)}</strong> is removed from the request.</p>`, confirmLabel: "Remove" })) { await store.deleteRequestFile(f); await reload(); }
      return;
    }
    if (t.dataset.taskDelete) {
      if (await confirmDialog({ title: "Remove this request?", body: "<p>It disappears for everyone.</p>", confirmLabel: "Remove" })) {
        await store.deleteActionItem(t.dataset.taskDelete); await reload();
      }
      return;
    }
    if (t.dataset.teamFileDelete) {
      const f = room.teamFiles.find((x) => x.id === t.dataset.teamFileDelete);
      if (f && await confirmDialog({ title: "Remove this file?", body: `<p><strong>${esc(f.name)}</strong> is deleted for everyone on the team.</p>`, confirmLabel: "Remove" })) {
        await store.deleteTeamFile(f); toast("File removed."); await reload();
      }
      return;
    }
    const m = memberById(t.dataset.memberExtend || t.dataset.memberRevoke || t.dataset.memberRestore);
    if (!m) return;
    if (t.dataset.memberExtend) {
      const base = m.expires_at && new Date(m.expires_at).getTime() > Date.now() ? new Date(m.expires_at).getTime() : Date.now();
      await store.setMemberAccess(m, { expires_at: new Date(base + 30 * 864e5).toISOString(), status: "active" });
      toast(`${m.name}’s access extended by 30 days.`);
    } else if (t.dataset.memberRevoke) {
      if (!await confirmDialog({ title: `Remove ${esc(m.name)}?`, body: "<p>Their access ends immediately. Messages and files they shared stay with the engagement. You can restore them later.</p>", confirmLabel: "Remove access" })) return;
      await store.setMemberAccess(m, { status: "revoked" });
      toast(`${m.name} no longer has access.`);
    } else if (t.dataset.memberRestore) {
      await store.setMemberAccess(m, { expires_at: daysFromNow(30), status: "active" });
      toast(`${m.name} has access again for 30 days.`);
    }
    await reload();
  } catch (err) { toast(err.message, true); }
});

main.addEventListener("change", async (e) => {
  if (e.target.matches("[data-switch]")) { await switchTo(e.target.value); return; }
  if (e.target.matches(".req__respond input[type=file]")) {
    const files = [...e.target.files];
    let note = files.map((f) => `${f.name} · ${fmtSize(f.size)}`).join(", ");
    try { files.forEach(checkFile); } catch (err) { note = err.message; e.target.value = ""; }
    e.target.closest("form").querySelector(".req__picked").textContent = note;
    return;
  }
  if (e.target.matches('#team-file-form input[type="file"]')) {
    const f = e.target.files[0];
    let note = f ? `${f.name} · ${fmtSize(f.size)}` : "";
    if (f) { try { checkFile(f); } catch (err) { note = err.message; e.target.value = ""; } }
    e.target.form.querySelector(".team-upload__name").textContent = note;
    return;
  }
  const modelBox = e.target.closest("[data-member-model]");
  if (modelBox) {
    const m = memberById(modelBox.dataset.memberModel);
    try {
      await store.setMemberModel(m.id, modelBox.checked);
      m.can_model = modelBox.checked;
      toast(modelBox.checked ? `${m.name} can now see the models.` : `${m.name} no longer sees the models.`);
    } catch (err) { modelBox.checked = !modelBox.checked; toast(err.message, true); }
    return;
  }
  const perm = e.target.closest("[data-member-perm]");
  if (perm) {
    const m = memberById(perm.dataset.member);
    try {
      await store.setMemberAccess(m, { [perm.dataset.memberPerm]: perm.checked, status: "active" });
      m[perm.dataset.memberPerm] = perm.checked;
      toast("Access updated.");
    } catch (err) { perm.checked = !perm.checked; toast(err.message, true); }
    return;
  }
  const box = e.target.closest("[data-action]");
  if (!box) return;
  const item = room.actions.find((a) => a.id === box.dataset.action);
  box.disabled = true;
  try {
    await store.setActionDone(item.id, box.checked);
    item.done_at = box.checked ? new Date().toISOString() : null;
    toast(box.checked ? "Marked done. The team can see it." : "Moved back to the list.");
    renderTab();
  } catch (err) { box.checked = !box.checked; box.disabled = false; toast(err.message, true); }
});

main.addEventListener("submit", async (e) => {
  const form = e.target;
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const label = btn?.innerHTML;
  if (btn) btn.disabled = true;
  try {
    if (form.dataset.composer) {
      const thread = form.dataset.composer;
      const text = form.body.value.trim();
      if (!text) return;
      const row = await store.postMessage(eng.id, text, thread);
      if (row.notice?.reason === "email failed") toastNotice(row.notice, "", "Sent.");
      (thread === "team" ? room.teamMessages : room.messages).push(row);
      if (thread === "team") room.teamLastRead = new Date().toISOString();
      form.body.value = "";
      const el = document.querySelector(`.thread[data-thread="${thread}"]`);
      el.innerHTML = threadHtml(thread === "team" ? room.teamMessages : room.messages, thread);
      scrollThreads();
      form.body.focus();
    } else if (form.dataset.respond) {
      const a = room.actions.find((x) => x.id === form.dataset.respond);
      const note = form.note.value.trim();
      const files = [...form.files.files];
      files.forEach(checkFile);
      const had = room.requestFiles.some((f) => f.request_id === a.id);
      if (a.kind === "document" && !files.length && !had) throw new Error("Attach the document first.");
      if (a.kind === "answer" && !note && !files.length) throw new Error("Write your answer first.");
      for (let i = 0; i < files.length; i++) {
        if (btn) btn.textContent = files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : "Uploading…";
        await store.uploadRequestFile(eng.id, a.id, files[i]);
      }
      if (btn) btn.textContent = "Sending…";
      await store.submitRequest(a.id, note);
      const n = await store.notify("request_update", a.id);
      toastNotice(n, `Sent. ${fromName(a)} has been told.`, "Sent.");
      await reload();
    } else if (form.id === "ask-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const kind = v("kind");
      const row = await store.addActionItem({ engagement_id: eng.id, kind, title: v("title"), detail: v("detail") || null, due_date: v("due_date") || null, assignee_id: v("assignee_id") || null, position: room.actions.length + 1 });
      const self = !row.assignee_id && !isMember();
      const n = self ? null : await store.notify("action_item", row.id);
      toastNotice(n, self ? "Added to your list." : `Sent to ${askedName(row)}. They’ve been emailed.`, `Sent to ${askedName(row)}.`);
      await reload();
    } else if (form.id === "task-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const row = await store.addActionItem({ engagement_id: eng.id, title: v("title"), detail: v("detail") || null, due_date: v("due_date") || null, assignee_id: v("assignee_id") || null, position: room.actions.length + 1 });
      const n = row.assignee_id ? await store.notify("action_item", row.id) : null;
      toastNotice(n, row.assignee_id ? `Task added. ${personName(row.assignee_id)} has been emailed.` : "Added to your list.", "Task added.");
      await reload();
    } else if (form.id === "member-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const days = v("length");
      if (btn) btn.textContent = "Sending…";
      const r = await store.inviteMember({
        engagement_id: eng.id, email: v("email"), full_name: v("full_name"), organization: v("organization") || null, role_label: v("role_label"),
        can_message: form.can_message.checked, can_files: form.can_files.checked, expires_at: days ? daysFromNow(Number(days)) : null,
      });
      if (r.emailed === false) toastNotice({ reason: "email failed" }, "", `${v("full_name")} has been added.`);
      else toast(r.invited ? `Invitation sent to ${v("email")}.` : `${v("full_name")} already had a portal account and has been added.`);
      await reload();
      location.hash = "team";
    } else if (form.id === "team-file-form") {
      const file = form.file.files[0];
      if (!file) throw new Error("Choose a file first.");
      checkFile(file);
      if (btn) btn.textContent = "Uploading…";
      const row = await store.uploadTeamFile(eng.id, file, form.note.value.trim());
      toastNotice(row.notice, "Shared with the team.", "Shared with the team.");
      await reload();
    } else if (form.id === "billing-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      await store.billing({ action: "save_address", billing_name: v("billing_name"), billing_email: v("billing_email"), line1: v("line1"), line2: v("line2"),
        city: v("city"), state: v("state").toUpperCase(), postal_code: v("postal_code") });
      toast("Billing address saved.");
      await reload();
    }
  } catch (err) { toast(err.message, true); }
  finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = label; } }
});

main.addEventListener("keydown", (e) => {
  if (e.target.matches(".composer__text") && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

render().catch((err) => { console.error(err); toast(err.message, true); });
