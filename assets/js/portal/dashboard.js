// The client's room: where the engagement stands, what's needed from them,
// what's been decided, when they next meet, and every update from Michael.
import { store } from "./store.js";
import { ADMIN_CONTACT } from "./config.js";
import { esc, paragraphs, fmtDate, relTime, greeting, renderChrome, requireSession, statusPill, progressBar, toast, download } from "./ui.js";

const main = document.getElementById("main");

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

function milestoneTrack(ms) {
  if (!ms.length) return `<p class="p-muted">Milestones appear here once the plan is agreed.</p>`;
  const done = ms.filter((m) => m.status === "done").length;
  return `<p class="room-track__count"><b>${done}</b> of ${ms.length} milestones complete</p>
    <ol class="room-track">${ms.map((m) => `<li class="is-${esc(m.status)}">
      <span class="room-track__dot" aria-hidden="true"></span>
      <div><p class="room-track__when">${esc(m.due_label || (m.due_date ? fmtDate(m.due_date, { month: "short", day: "numeric" }) : ""))}${m.status === "current" ? `<span class="room-track__now">In progress</span>` : m.status === "done" ? `<span class="visually-hidden"> (complete)</span>` : ""}</p>
      <h3>${esc(m.title)}</h3>${m.note ? `<p class="p-muted">${esc(m.note)}</p>` : ""}</div></li>`).join("")}</ol>`;
}

function decisionLog(ds) {
  if (!ds.length) return `<p class="p-muted">Decisions you and Michael agree on are recorded here, with the reason, so nobody has to remember why.</p>`;
  return `<ol class="room-log">${ds.map((d) => `<li>
    <p class="room-log__date">${esc(fmtDate(d.decided_on, { month: "short", day: "numeric", year: "numeric" }))}</p>
    <div><p class="room-log__what">${esc(d.decision)}</p>${d.rationale ? `<p class="p-muted">${esc(d.rationale)}</p>` : ""}${d.owner ? `<p class="room-log__owner">Owner: ${esc(d.owner)}</p>` : ""}</div>
  </li>`).join("")}</ol>`;
}

function meetingCard(eng) {
  if (!eng.next_meeting_at) {
    return `<section class="p-card room-meet"><h2 class="p-kicker">Next conversation</h2><p>Not scheduled yet. <a class="accent" href="mailto:${esc(ADMIN_CONTACT.email)}?subject=${encodeURIComponent(`Next meeting: ${eng.title}`)}">Suggest a time</a>.</p></section>`;
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
      ${past ? "" : `<button type="button" class="p-linkbtn room-meet__cal" data-ics="${esc(eng.id)}">Add to calendar</button>`}
    </div>
  </section>`;
}

function principalCard() {
  const c = ADMIN_CONTACT;
  return `<section class="p-card room-principal">
    <h2 class="p-kicker">Your principal</h2>
    <div class="room-principal__id"><span class="room-principal__mono" aria-hidden="true">MF</span>
      <div><h3>${esc(c.name)}</h3><p class="p-muted">${esc(c.title)}, Sypher Solutions</p></div></div>
    <ul class="room-principal__lines">
      <li><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></li>
      ${c.phone ? `<li><a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></li>` : ""}
    </ul>
    ${c.response_promise ? `<p class="room-principal__promise">${esc(c.response_promise)}</p>` : ""}
  </section>`;
}

function ics(eng) {
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

async function render() {
  const session = await requireSession();
  if (!session) return;
  renderChrome(session, { active: "dashboard", admin: session.profile.role === "admin" });

  const engagements = await store.myEngagements();
  const first = (session.profile.full_name || "").split(" ")[0];
  const hello = `${esc(greeting())}${first ? `, <em>${esc(first)}.</em>` : "."}`;
  if (!engagements.length) {
    main.innerHTML = `<div class="p-shell"><div class="p-greeting"><h1>${hello}</h1>
      <p>Your room is being prepared. Michael will be in touch shortly.</p></div></div>`;
    return;
  }

  const blocks = await Promise.all(engagements.map(async (eng) => {
    const [assignments, pubs, files, milestones, decisions] = await Promise.all([
      store.assignmentsFor(eng.id), store.publications(eng.id), store.engagementFiles(eng.id), store.milestones(eng.id), store.decisions(eng.id),
    ]);
    return { eng, assignments, pubs, files, milestones, decisions };
  }));
  window.__room = blocks;

  main.innerHTML = blocks.map(({ eng, assignments, pubs, files, milestones, decisions }, i) => `
  <section class="room-cover" aria-labelledby="eng-${esc(eng.id)}">
    <img class="room-cover__mark" src="../assets/img/sypher-mark-480.webp" alt="" width="375" height="483">
    <div class="p-shell room-cover__inner">
      <p class="room-cover__kicker">Client room${session.profile.company ? ` · ${esc(session.profile.company)}` : ""}</p>
      ${i === 0 ? `<p class="room-cover__hello">${hello}</p>` : ""}
      <${i === 0 ? "h1" : "h2"} class="room-cover__title" id="eng-${esc(eng.id)}">${esc(eng.title)}</${i === 0 ? "h1" : "h2"}>
      ${eng.summary ? `<p class="room-cover__summary">${esc(eng.summary)}</p>` : ""}
      <dl class="room-cover__meta">
        ${eng.kickoff_date ? `<div><dt>Began</dt><dd>${esc(fmtDate(eng.kickoff_date))}</dd></div>` : ""}
        <div><dt>Status</dt><dd>${eng.status === "active" ? "Under way" : eng.status === "complete" ? "Complete" : "Archived"}</dd></div>
        <div><dt>Principal</dt><dd>${esc(ADMIN_CONTACT.name)}</dd></div>
      </dl>
    </div>
  </section>
  <div class="p-shell room-body">
    <div class="p-grid">
      <div class="p-stack">
        <section class="p-card p-card--accent" aria-label="Where things stand"><h2 class="p-kicker">Where things stand</h2>${milestoneTrack(milestones)}</section>
        <section class="p-card" aria-label="For you to complete">
          <h2 class="p-kicker">For you to complete</h2>
          ${assignments.length ? `<ul class="p-list">${assignments.map(assignmentCard).join("")}</ul>` : `<p class="p-empty">Nothing needs you right now.</p>`}
        </section>
        <section class="p-card" aria-label="Updates from Michael">
          <h2 class="p-kicker">Updates from Michael</h2>
          ${pubs.length ? `<ul class="p-list">${pubs.map((p) => `<li><div class="p-row"><h3>${esc(p.title)}</h3><span class="p-muted">${esc(fmtDate(p.published_at))}</span></div><div class="room-update">${paragraphs(p.body)}</div></li>`).join("")}</ul>` : `<p class="p-empty">Updates will appear here as the work moves.</p>`}
        </section>
        <section class="p-card" aria-label="Decision log"><h2 class="p-kicker">Decision log</h2>${decisionLog(decisions)}</section>
      </div>
      <div class="p-stack">
        ${meetingCard(eng)}
        ${principalCard()}
        <section class="p-card" aria-label="Documents">
          <h2 class="p-kicker">Documents you’ve shared</h2>
          ${files.length ? `<ul class="p-list">${files.map((f) => `<li class="p-row"><span>${esc(f.name)}</span><span class="p-muted">${esc(relTime(f.created_at))}</span></li>`).join("")}</ul>` : `<p class="p-muted">Files you attach to answers are listed here.</p>`}
        </section>
      </div>
    </div>
  </div>`).join("");
}

main.addEventListener("click", (e) => {
  const b = e.target.closest("[data-ics]");
  if (!b) return;
  const block = (window.__room || []).find((x) => x.eng.id === b.dataset.ics);
  if (block) download("sypher-meeting.ics", ics(block.eng), "text/calendar");
});

render().catch((err) => { console.error(err); toast(err.message, true); });
