// The room, as each person sees it.
//
// The client (six tabs):
//   Overview   what needs them (to-dos, questionnaires), the next conversation, the latest update
//   Plan       the milestone track (with the documents each produced) and the decision log
//   Documents  the signed agreement, deliverables from Michael, and files they've shared
//   Messages   a private thread with Michael
//   Team       outside advisers they've brought in: people, team thread, team tasks, team files
//   Timeline   everything that has happened, newest first
//
// A team member (attorney, CPA …), with access the client or Michael granted, sees only:
//   Tasks      tasks assigned to them (and the rest of the team's, for context)
//   Messages   the team thread                    (if they may message)
//   Files      team files and shared deliverables (if they may see files)
//
// Tabs are hash routes, so the back button and email links work.
import { store } from "./store.js";
import { ADMIN_CONTACT } from "./config.js";
import { esc, paragraphs, fmtDate, relTime, greeting, initials, renderChrome, requireSession, statusPill, progressBar, toast, download, confirmDialog } from "./ui.js";

const main = document.getElementById("main");
const CLIENT_TABS = [["overview", "Overview"], ["plan", "Plan"], ["documents", "Documents"], ["messages", "Messages"], ["team", "Team"], ["timeline", "Timeline"]];
const ROLES = ["Attorney", "CPA", "Bookkeeper", "Lender", "Insurance broker", "Business partner", "Other"];
const ENG_KEY = "sypher-room-engagement";
const POLL_MS = 20000;

let session, engagements = [], eng = null, room = null, pollTimer = null;
const unread = { private: 0, team: 0 };

const isMember = () => eng?.access === "member";
const me = () => session.user.id;
const myMembership = () => room?.roster?.members?.find((m) => m.user_id === me());
function tabList() {
  if (!isMember()) return CLIENT_TABS;
  const m = myMembership() || {};
  return [["tasks", "Tasks"], ...(m.can_message ? [["messages", "Messages"]] : []), ...(m.can_files ? [["files", "Files"]] : [])];
}
const tab = () => {
  const t = location.hash.slice(1);
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
  return m ? m.name : "Former team member";
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
    room = { roster, actions, teamMessages, teamFiles, deliverables, teamLastRead: lastRead };
    store.touchMembership(id).catch(() => {});
  } else {
    const [assignments, pubs, files, milestones, decisions, actions, deliverables, messages, agreement, activity, roster, teamMessages, teamFiles, lastRead] = await Promise.all([
      store.assignmentsFor(id), store.publications(id), store.engagementFiles(id), store.milestones(id), store.decisions(id),
      store.actionItems(id), store.deliverables(id), store.messages(id), store.agreement(id).catch(() => null), store.activity(id, 120),
      store.roster(id).catch(() => null), store.messages(id, "team"), store.teamFiles(id).catch(() => []), store.teamLastRead(id, me()).catch(() => null),
    ]);
    room = { assignments, pubs, files, milestones, decisions, actions, deliverables, messages, agreement, activity, roster, teamMessages, teamFiles, teamLastRead: lastRead };
  }
  countUnread();
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
    if (k === "overview") { const n = myOpenActions().length + openAssignments().length; return n ? soft(n, "for you") : ""; }
    if (k === "tasks") { const n = myOpenActions().length; return n ? soft(n, "open") : ""; }
    return "";
  };
  return `<nav class="room-tabs" aria-label="${isMember() ? "Team space" : "Client room"}"><div class="p-shell room-tabs__inner">
    ${tabList().map(([k, label]) => `<a href="#${k}" class="room-tabs__link"${k === current ? ' aria-current="page"' : ""}>${label}${badge(k)}</a>`).join("")}
  </div></nav>`;
}

/* --------------------------------------------------------------- tasks */
// "Mine": for the client, tasks with no assignee (or assigned to them); for a member, theirs.
const isMine = (a) => (isMember() ? a.assignee_id === me() : !a.assignee_id || a.assignee_id === me());
const myOpenActions = () => (room?.actions || []).filter((a) => isMine(a) && !a.done_at);
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
    <div class="p-progress" role="progressbar" aria-valuenow="${Math.round((done / ms.length) * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="Milestones complete"><span style="width:${(done / ms.length) * 100}%"></span></div>
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

function viewOverview() {
  const mine = room.actions.filter(isMine);
  const asg = room.assignments;
  const nothing = !mine.length && !asg.length;
  const n = myOpenActions().length + openAssignments().length;
  return `<div class="p-grid">
    <div class="p-stack">
      <section class="p-card p-card--accent" aria-label="For you">
        <div class="p-row"><h2 class="p-kicker">For you</h2>${n ? `<span class="p-muted">${n} open</span>` : ""}</div>
        ${nothing ? `<p class="p-empty">Nothing needs you right now.</p>` : ""}
        ${mine.length ? actionList(mine, { canDelete: true }) : ""}
        ${asg.length ? `<h3 class="room-sub">Questionnaires</h3><ul class="p-list">${asg.map(assignmentCard).join("")}</ul>` : ""}
        ${taskForm()}
      </section>
      ${updatesCard()}
    </div>
    <div class="p-stack">
      ${meetingCard()}
      ${whereThingsStand()}
      ${latestMessageCard()}
      ${teamPeek()}
      ${principalCard()}
    </div>
  </div>`;
}

/* ----------------------------------------------------------- client: plan */
function deliverableRow(d, { badge = false } = {}) {
  return `<li class="doc">
    <span class="doc__icon" aria-hidden="true">${ext(d.name)}</span>
    <div class="doc__body"><p class="doc__title">${esc(d.title || d.name)}${badge && d.shared_with_team ? ` <span class="pill pill--teal">Shared with team</span>` : ""}</p>
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
          <div class="doc__body"><p class="doc__title">${esc(f.name)}</p><p class="doc__meta">${esc(relTime(f.created_at))}${f.size ? ` · ${esc(fmtSize(f.size))}` : ""}</p></div>
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
      <p class="person__access">${esc(accessText(m))} · ${[m.can_message && "messages", m.can_files && "files", "tasks"].filter(Boolean).join(", ")}${m.last_seen_at ? ` · last in ${esc(relTime(m.last_seen_at))}` : m.status === "active" ? " · hasn’t signed in yet" : ""}</p>
    </div>
    <details class="person__manage"><summary class="p-linkbtn">Manage</summary>
      <div class="person__menu">
        ${m.status === "active" ? `
          <label class="p-check"><input type="checkbox" data-member-perm="can_message" data-member="${esc(m.id)}"${m.can_message ? " checked" : ""}> Team messages</label>
          <label class="p-check"><input type="checkbox" data-member-perm="can_files" data-member="${esc(m.id)}"${m.can_files ? " checked" : ""}> Files</label>
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
    <div class="doc__body"><p class="doc__title">${esc(f.name)}</p>${f.note ? `<p class="doc__note">${esc(f.note)}</p>` : ""}
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
      <label class="btn btn--ghost btn--sm file-btn">Choose a file<input type="file" name="file" required></label>
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
function viewMemberTasks() {
  const mine = room.actions.filter(isMine);
  const others = room.actions.filter((a) => !isMine(a));
  return `<div class="p-grid">
    <div class="p-stack">
      <section class="p-card p-card--accent" aria-label="Your tasks"><div class="p-row"><h2 class="p-kicker">Your tasks</h2>${myOpenActions().length ? `<span class="p-muted">${myOpenActions().length} open</span>` : ""}</div>
        ${mine.length ? actionList(mine) : `<p class="p-empty">Nothing assigned to you right now.</p>`}</section>
      ${others.length ? `<section class="p-card" aria-label="The rest of the team"><h2 class="p-kicker">The rest of the team</h2>${actionList(others, { showAssignee: true })}</section>` : ""}
    </div>
    <div class="p-stack">
      ${myMembership()?.can_message ? `<section class="p-card room-msgpeek"><h2 class="p-kicker">Team thread</h2>
        ${room.teamMessages.length ? (() => { const l = room.teamMessages[room.teamMessages.length - 1]; return `<p class="room-msgpeek__who">${esc(personName(l.author_id))} · ${esc(relTime(l.created_at))}${unread.team ? ` <span class="pill pill--gold">${unread.team} new</span>` : ""}</p><p class="room-msgpeek__body">${esc(l.body.length > 180 ? `${l.body.slice(0, 180)}…` : l.body)}</p>`; })() : `<p class="p-muted">No messages yet.</p>`}
        <a class="btn btn--ghost btn--sm" href="#messages">Open the thread</a></section>` : ""}
      ${principalCard()}
    </div>
  </div>`;
}

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
};

function viewTimeline() {
  const items = room.activity.filter((a) => TIMELINE[a.kind]);
  if (!items.length) return `<section class="p-card"><p class="p-empty">The story of the engagement will build up here.</p></section>`;
  let month = "";
  return `<section class="p-card p-card--accent" aria-label="Timeline"><h2 class="p-kicker">Timeline</h2><ol class="timeline">${items.map((a) => {
    const [text, icon] = TIMELINE[a.kind](a.detail || {});
    const m = fmtDate(a.created_at, { month: "long", year: "numeric" });
    const head = m !== month ? `<li class="timeline__month">${esc(m)}</li>` : "";
    month = m;
    return `${head}<li class="timeline__item timeline__item--${icon}"><span class="timeline__dot" aria-hidden="true"></span>
      <p class="timeline__text">${esc(text)}</p><p class="timeline__when"><time datetime="${esc(a.created_at)}">${esc(fmtDate(a.created_at, { month: "short", day: "numeric" }))} · ${esc(new Date(a.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</time></p></li>`;
  }).join("")}</ol></section>`;
}

/* -------------------------------------------------------------- render */
function renderTab(focus = false) {
  const views = isMember()
    ? { tasks: viewMemberTasks, messages: viewMessages, files: viewMemberFiles }
    : { overview: viewOverview, plan: viewPlan, documents: viewDocuments, messages: viewMessages, team: viewTeam, timeline: viewTimeline };
  refreshTabs();
  // Stick the tabs just under the portal header, whatever height it renders at.
  const header = document.getElementById("p-header");
  if (header) document.documentElement.style.setProperty("--p-header-h", `${header.offsetHeight}px`);
  const body = document.getElementById("room-body");
  body.innerHTML = views[tab()]();
  scrollThreads();
  markReadIfNeeded();
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
}

async function reload() {
  await loadRoom();
  const y = window.scrollY;
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
    if (t.dataset.taskDelete) {
      if (await confirmDialog({ title: "Remove this task?", body: "<p>It disappears for everyone.</p>", confirmLabel: "Remove" })) {
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
  if (e.target.matches("[data-switch]")) {
    try { sessionStorage.setItem(ENG_KEY, e.target.value); } catch (_) { /* ignore */ }
    eng = engagements.find((x) => x.id === e.target.value);
    main.innerHTML = `<div class="p-loading">Loading…</div>`;
    history.replaceState(null, "", location.pathname);
    await loadRoom();
    mount();
    return;
  }
  if (e.target.matches('#team-file-form input[type="file"]')) {
    const f = e.target.files[0];
    e.target.form.querySelector(".team-upload__name").textContent = f ? `${f.name} · ${fmtSize(f.size)}` : "";
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
      (thread === "team" ? room.teamMessages : room.messages).push(row);
      if (thread === "team") room.teamLastRead = new Date().toISOString();
      form.body.value = "";
      const el = document.querySelector(`.thread[data-thread="${thread}"]`);
      el.innerHTML = threadHtml(thread === "team" ? room.teamMessages : room.messages, thread);
      scrollThreads();
      form.body.focus();
    } else if (form.id === "task-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const row = await store.addActionItem({ engagement_id: eng.id, title: v("title"), detail: v("detail") || null, due_date: v("due_date") || null, assignee_id: v("assignee_id") || null, position: room.actions.length + 1 });
      if (row.assignee_id) store.notify("action_item", row.id);
      toast(row.assignee_id ? `Task added. ${personName(row.assignee_id)} has been emailed.` : "Added to your list.");
      await reload();
    } else if (form.id === "member-form") {
      const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const days = v("length");
      if (btn) btn.textContent = "Sending…";
      const r = await store.inviteMember({
        engagement_id: eng.id, email: v("email"), full_name: v("full_name"), organization: v("organization") || null, role_label: v("role_label"),
        can_message: form.can_message.checked, can_files: form.can_files.checked, expires_at: days ? daysFromNow(Number(days)) : null,
      });
      toast(r.invited ? `Invitation sent to ${v("email")}.` : `${v("full_name")} already had a portal account and has been added.`);
      await reload();
      location.hash = "team";
    } else if (form.id === "team-file-form") {
      const file = form.file.files[0];
      if (!file) throw new Error("Choose a file first.");
      if (file.size > 50 * 1024 * 1024) throw new Error("Files must be under 50 MB.");
      if (btn) btn.textContent = "Uploading…";
      await store.uploadTeamFile(eng.id, file, form.note.value.trim());
      toast("Shared with the team.");
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
