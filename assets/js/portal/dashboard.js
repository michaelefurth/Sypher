// The client's room, in five tabs:
//   Overview   what needs them (to-dos, questionnaires), the next conversation, the latest update
//   Plan       the milestone track (with the documents each produced) and the decision log
//   Documents  the signed agreement, deliverables from Michael, and files they've shared
//   Messages   a private thread with Michael
//   Timeline   everything that has happened, newest first
// Tabs are hash routes (#overview, #plan, …), so the back button and email links work.
import { store } from "./store.js";
import { ADMIN_CONTACT } from "./config.js";
import { esc, paragraphs, fmtDate, relTime, greeting, renderChrome, requireSession, statusPill, progressBar, toast, download } from "./ui.js";

const main = document.getElementById("main");
const TABS = [["overview", "Overview"], ["plan", "Plan"], ["documents", "Documents"], ["messages", "Messages"], ["timeline", "Timeline"]];
const ENG_KEY = "sypher-room-engagement";
const POLL_MS = 20000;

let session, engagements = [], eng = null, room = null, unread = 0, pollTimer = null;

const tab = () => {
  const t = location.hash.slice(1);
  return TABS.some(([k]) => k === t) ? t : "overview";
};
const fmtSize = (n) => (!n ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const dueText = (d) => (d ? fmtDate(d, { month: "short", day: "numeric" }) : "");
const overdue = (d) => d && d < new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------- loading */
async function loadRoom() {
  const id = eng.id;
  const [assignments, pubs, files, milestones, decisions, actions, deliverables, messages, agreement, activity] = await Promise.all([
    store.assignmentsFor(id), store.publications(id), store.engagementFiles(id), store.milestones(id), store.decisions(id),
    store.actionItems(id), store.deliverables(id), store.messages(id), store.agreement(id).catch(() => null), store.activity(id, 120),
  ]);
  room = { assignments, pubs, files, milestones, decisions, actions, deliverables, messages, agreement, activity };
  unread = messages.filter((m) => m.author_id !== session.user.id && !m.read_at).length;
}

/* ----------------------------------------------------------- the frame */
function cover() {
  const first = (session.profile.full_name || "").split(" ")[0];
  const switcher = engagements.length > 1 ? `<label class="room-switch"><span class="visually-hidden">Switch engagement</span>
    <select class="p-select p-select--sm" data-switch>${engagements.map((e) => `<option value="${esc(e.id)}"${e.id === eng.id ? " selected" : ""}>${esc(e.title)}</option>`).join("")}</select></label>` : "";
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
    if (k === "messages" && unread) return `<span class="room-tabs__badge" aria-label="${unread} unread">${unread}</span>`;
    if (k === "overview") {
      const n = openActions().length + openAssignments().length;
      return n ? `<span class="room-tabs__badge room-tabs__badge--soft" aria-label="${n} for you">${n}</span>` : "";
    }
    return "";
  };
  return `<nav class="room-tabs" aria-label="Client room"><div class="p-shell room-tabs__inner">
    ${TABS.map(([k, label]) => `<a href="#${k}" class="room-tabs__link"${k === current ? ' aria-current="page"' : ""}>${label}${badge(k)}</a>`).join("")}
  </div></nav>`;
}

/* ------------------------------------------------------------ overview */
const openActions = () => room.actions.filter((a) => !a.done_at);
const openAssignments = () => room.assignments.filter((a) => ["open", "reopened"].includes(a.status));

function actionList(items, { compact = false } = {}) {
  const open = items.filter((a) => !a.done_at);
  const done = items.filter((a) => a.done_at);
  const row = (a) => `<li class="todo${a.done_at ? " is-done" : ""}">
    <label class="todo__check"><input type="checkbox" data-action="${esc(a.id)}"${a.done_at ? " checked" : ""}>
      <span class="todo__box" aria-hidden="true"></span>
      <span class="todo__text"><span class="todo__title">${esc(a.title)}</span>${a.detail && !compact ? `<span class="todo__detail">${esc(a.detail)}</span>` : ""}</span></label>
    ${a.due_date && !a.done_at ? `<span class="todo__due${overdue(a.due_date) ? " is-late" : ""}">${overdue(a.due_date) ? "Was due" : "Due"} ${esc(dueText(a.due_date))}</span>` : ""}
    ${a.done_at ? `<span class="todo__due">Done ${esc(relTime(a.done_at))}</span>` : ""}
  </li>`;
  return `<ul class="todo-list">${open.map(row).join("")}</ul>
    ${done.length ? `<details class="todo-done"><summary>${done.length} done</summary><ul class="todo-list">${done.map(row).join("")}</ul></details>` : ""}`;
}

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
    <h2 class="p-kicker">Your principal</h2>
    <div class="room-principal__id"><img class="room-principal__photo" src="../assets/img/michael-furth-avatar.webp" alt="" width="64" height="64">
      <div><h3>${esc(c.name)}</h3><p class="p-muted">${esc(c.title)}, Sypher Solutions</p></div></div>
    <ul class="room-principal__lines">
      <li><a href="#messages">Message in the portal</a></li>
      <li><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></li>
      ${c.phone ? `<li><a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></li>` : ""}
    </ul>
    ${c.response_promise ? `<p class="room-principal__promise">${esc(c.response_promise)}</p>` : ""}
  </section>`;
}

function latestMessageCard() {
  const last = room.messages[room.messages.length - 1];
  return `<section class="p-card room-msgpeek"><h2 class="p-kicker">Messages</h2>
    ${last ? `<p class="room-msgpeek__who">${last.author_id === session.user.id ? "You" : esc(ADMIN_CONTACT.name.split(" ")[0])} · ${esc(relTime(last.created_at))}${unread ? ` <span class="pill pill--gold">${unread} new</span>` : ""}</p>
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

function viewOverview() {
  const actions = openActions();
  const asg = room.assignments;
  const nothing = !room.actions.length && !asg.length;
  return `<div class="p-grid">
    <div class="p-stack">
      <section class="p-card p-card--accent" aria-label="For you">
        <div class="p-row"><h2 class="p-kicker">For you</h2>${actions.length + openAssignments().length ? `<span class="p-muted">${actions.length + openAssignments().length} open</span>` : ""}</div>
        ${nothing ? `<p class="p-empty">Nothing needs you right now.</p>` : ""}
        ${room.actions.length ? actionList(room.actions) : ""}
        ${asg.length ? `<h3 class="room-sub">Questionnaires</h3><ul class="p-list">${asg.map(assignmentCard).join("")}</ul>` : ""}
      </section>
      ${updatesCard()}
    </div>
    <div class="p-stack">
      ${meetingCard()}
      ${whereThingsStand()}
      ${latestMessageCard()}
      ${principalCard()}
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- plan */
function deliverableRow(d) {
  return `<li class="doc">
    <span class="doc__icon" aria-hidden="true">${esc((d.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</span>
    <div class="doc__body"><p class="doc__title">${esc(d.title || d.name)}</p>
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
      ${docs.length ? `<ul class="doc-list doc-list--inline">${docs.map(deliverableRow).join("")}</ul>` : ""}</div></li>`;
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

/* ----------------------------------------------------------- documents */
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

function viewDocuments() {
  const ms = new Map(room.milestones.map((m) => [m.id, m]));
  const groups = [];
  for (const d of room.deliverables) {
    const key = d.milestone_id && ms.has(d.milestone_id) ? d.milestone_id : "";
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, title: key ? ms.get(key).title : "General", pos: key ? ms.get(key).position : 1e9, items: [] }; groups.push(g); }
    g.items.push(d);
  }
  groups.sort((a, b) => a.pos - b.pos);
  const files = room.files;
  return `<div class="p-grid">
    <section class="p-card p-card--accent" aria-label="From Michael"><h2 class="p-kicker">From Michael</h2>
      ${groups.length ? groups.map((g) => `<div class="doc-group"><h3 class="room-sub">${esc(g.title)}</h3><ul class="doc-list">${g.items.map(deliverableRow).join("")}</ul></div>`).join("")
        : `<p class="p-empty">Reports, models and documents Michael shares will appear here, filed by milestone.</p>`}
    </section>
    <div class="p-stack">
      ${agreementCard()}
      <section class="p-card" aria-label="Documents you’ve shared"><h2 class="p-kicker">You’ve shared</h2>
        ${files.length ? `<ul class="doc-list">${files.map((f) => `<li class="doc">
          <span class="doc__icon doc__icon--mine" aria-hidden="true">${esc((f.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</span>
          <div class="doc__body"><p class="doc__title">${esc(f.name)}</p><p class="doc__meta">${esc(relTime(f.created_at))}${f.size ? ` · ${esc(fmtSize(f.size))}` : ""}</p></div>
          <button type="button" class="p-linkbtn" data-open-file="${esc(f.path)}" aria-label="Open ${esc(f.name)}">Open</button></li>`).join("")}</ul>`
          : `<p class="p-muted">Files you attach to questionnaire answers are listed here.</p>`}
      </section>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ messages */
function threadHtml() {
  if (!room.messages.length) {
    return `<div class="thread__empty"><p>This is your private line to Michael for <em>${esc(eng.title)}</em>.</p><p class="p-muted">Ask anything between meetings. Michael is emailed when you write, and you’re emailed when he replies.</p></div>`;
  }
  let day = "";
  return room.messages.map((m) => {
    const mine = m.author_id === session.user.id;
    const d = fmtDate(m.created_at, { weekday: "long", month: "long", day: "numeric" });
    const sep = d !== day ? `<li class="thread__day"><span>${esc(d)}</span></li>` : "";
    day = d;
    return `${sep}<li class="msg${mine ? " msg--mine" : ""}">
      ${mine ? "" : `<img class="msg__avatar" src="../assets/img/michael-furth-avatar.webp" alt="" width="36" height="36">`}
      <div class="msg__bubble"><p class="msg__who">${mine ? "You" : esc(ADMIN_CONTACT.name)}<time datetime="${esc(m.created_at)}">${esc(new Date(m.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</time></p>
      <div class="msg__body">${paragraphs(m.body)}</div></div></li>`;
  }).join("");
}

function viewMessages() {
  return `<div class="thread-wrap">
    <section class="p-card thread-card" aria-label="Messages with ${esc(ADMIN_CONTACT.name)}">
      <div class="thread-card__head"><img src="../assets/img/michael-furth-avatar.webp" alt="" width="44" height="44">
        <div><h2 class="thread-card__name">${esc(ADMIN_CONTACT.name)}</h2><p class="p-muted">${esc(ADMIN_CONTACT.title)}${ADMIN_CONTACT.response_promise ? ` · ${esc(ADMIN_CONTACT.response_promise)}` : ""}</p></div></div>
      <ol class="thread" id="thread" aria-live="polite">${threadHtml()}</ol>
      <form class="composer" id="composer">
        <label class="visually-hidden" for="composer-text">Message to Michael</label>
        <textarea class="p-textarea composer__text" id="composer-text" name="body" rows="3" maxlength="8000" placeholder="Write to Michael…" required></textarea>
        <div class="composer__bar"><span class="p-muted composer__hint">Ctrl + Enter to send</span>
          <button class="btn btn--navy btn--sm" type="submit">Send
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M1 8h13M9 3l5 5-5 5"/></svg></button></div>
      </form>
    </section>
  </div>`;
}

function scrollThread() {
  const t = document.getElementById("thread");
  if (t) t.scrollTop = t.scrollHeight;
}

async function markReadIfNeeded() {
  if (tab() !== "messages" || !unread || document.hidden) return;
  try {
    await store.markRead(eng.id);
    room.messages.forEach((m) => { if (m.author_id !== session.user.id) m.read_at = m.read_at || new Date().toISOString(); });
    unread = 0;
    const nav = document.querySelector(".room-tabs");
    if (nav) nav.outerHTML = tabs();
  } catch (err) { console.warn(err); }
}

async function poll() {
  if (document.hidden || !eng) return;
  try {
    const msgs = await store.messages(eng.id);
    if (msgs.length === room.messages.length) return;
    room.messages = msgs;
    unread = msgs.filter((m) => m.author_id !== session.user.id && !m.read_at).length;
    if (tab() === "messages") {
      const t = document.getElementById("thread");
      if (t) { t.innerHTML = threadHtml(); scrollThread(); }
      await markReadIfNeeded();
    }
    const nav = document.querySelector(".room-tabs");
    if (nav) nav.outerHTML = tabs();
  } catch (err) { console.warn(err); }
}

/* ------------------------------------------------------------ timeline */
const TIMELINE = {
  client_invited: () => ["Your client room opened", "room"],
  proposal_accepted: (d) => [`Proposal accepted${d.title ? `: ${d.title}` : ""}`, "sign"],
  assignment_created: () => ["A questionnaire was shared with you", "ask"],
  assignment_submitted: () => ["You submitted your answers", "ask"],
  update_published: (d) => [`Update from Michael${d.title ? `: ${d.title}` : ""}`, "update"],
  message_posted: (d) => [d.from === "principal" ? "Michael sent a message" : "You wrote to Michael", "msg"],
  deliverable_shared: (d) => [`Document shared: ${d.title || ""}`, "doc"],
  action_assigned: (d) => [`New item for you: ${d.title || ""}`, "todo"],
  action_done: (d) => [`Done: ${d.title || ""}`, "check"],
  decision_recorded: (d) => [`Decision recorded: ${d.title || ""}`, "decide"],
  milestone_current: (d) => [`Under way: ${d.title || ""}`, "ms"],
  milestone_done: (d) => [`Milestone complete: ${d.title || ""}`, "check"],
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
  const views = { overview: viewOverview, plan: viewPlan, documents: viewDocuments, messages: viewMessages, timeline: viewTimeline };
  const nav = document.querySelector(".room-tabs");
  if (nav) nav.outerHTML = tabs();
  // Stick the tabs just under the portal header, whatever height it renders at.
  const header = document.getElementById("p-header");
  if (header) document.documentElement.style.setProperty("--p-header-h", `${header.offsetHeight}px`);
  const body = document.getElementById("room-body");
  body.innerHTML = views[tab()]();
  if (tab() === "messages") { scrollThread(); markReadIfNeeded(); }
  if (focus) body.focus({ preventScroll: true });
}

async function render() {
  session = await requireSession();
  if (!session) return;
  renderChrome(session, { active: "dashboard", admin: session.profile.role === "admin" });

  engagements = await store.myEngagements();
  if (!engagements.length) {
    const first = (session.profile.full_name || "").split(" ")[0];
    main.innerHTML = `<div class="p-shell"><div class="p-greeting"><h1>${esc(greeting())}${first ? `, <em>${esc(first)}.</em>` : "."}</h1>
      <p>Your room is being prepared. Michael will be in touch shortly.</p></div></div>`;
    return;
  }
  let saved = null;
  try { saved = sessionStorage.getItem(ENG_KEY); } catch (_) { /* ignore */ }
  eng = engagements.find((e) => e.id === saved) || engagements.find((e) => e.status === "active") || engagements[0];
  await loadRoom();
  main.innerHTML = `${cover()}${tabs()}<div class="p-shell room-body" id="room-body" tabindex="-1"></div>`;
  renderTab();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
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

window.addEventListener("hashchange", () => { if (room) renderTab(true); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

main.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.hasAttribute("data-ics")) { download("sypher-meeting.ics", ics(), "text/calendar"); return; }
  if (t.dataset.compose) {
    e.preventDefault();
    location.hash = "messages";
    setTimeout(() => { const box = document.getElementById("composer-text"); if (box) { box.value = t.dataset.compose; box.focus(); } }, 0);
    return;
  }
  if (t.dataset.openFile) {
    const win = window.open("", "_blank"); // open synchronously so pop-up blockers allow it
    try {
      const url = await store.fileUrl(t.dataset.openFile);
      if (win) win.location.href = url; else location.href = url;
    } catch (err) { if (win) win.close(); toast(`Couldn’t open the file: ${err.message}`, true); }
  }
});

main.addEventListener("change", async (e) => {
  if (e.target.matches("[data-switch]")) {
    try { sessionStorage.setItem(ENG_KEY, e.target.value); } catch (_) { /* ignore */ }
    eng = engagements.find((x) => x.id === e.target.value);
    main.innerHTML = `<div class="p-loading">Loading…</div>`;
    await loadRoom();
    main.innerHTML = `${cover()}${tabs()}<div class="p-shell room-body" id="room-body" tabindex="-1"></div>`;
    renderTab();
    return;
  }
  const box = e.target.closest("[data-action]");
  if (!box) return;
  const item = room.actions.find((a) => a.id === box.dataset.action);
  box.disabled = true;
  try {
    await store.setActionDone(item.id, box.checked);
    item.done_at = box.checked ? new Date().toISOString() : null;
    toast(box.checked ? "Marked done. Michael can see it." : "Moved back to your list.");
    renderTab();
  } catch (err) { box.checked = !box.checked; box.disabled = false; toast(err.message, true); }
});

main.addEventListener("submit", async (e) => {
  if (e.target.id !== "composer") return;
  e.preventDefault();
  const form = e.target;
  const text = form.body.value.trim();
  if (!text) return;
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const row = await store.postMessage(eng.id, text);
    room.messages.push(row);
    form.body.value = "";
    document.getElementById("thread").innerHTML = threadHtml();
    scrollThread();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; form.body.focus(); }
});

main.addEventListener("keydown", (e) => {
  if (e.target.id === "composer-text" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

render().catch((err) => { console.error(err); toast(err.message, true); });
