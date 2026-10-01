// Client overview: engagement, questionnaires, updates from Michael, documents.
import { store } from "./store.js";
import { ADMIN_CONTACT } from "./config.js";
import { esc, paragraphs, fmtDate, relTime, greeting, renderChrome, requireSession, statusPill, progressBar, toast } from "./ui.js";

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

async function render() {
  const session = await requireSession();
  if (!session) return;
  renderChrome(session, { active: "dashboard", admin: session.profile.role === "admin" });

  const engagements = await store.myEngagements();
  const first = (session.profile.full_name || "").split(" ")[0];
  if (!engagements.length) {
    main.innerHTML = `<div class="p-shell"><div class="p-greeting"><h1>${esc(greeting())}${first ? `, <em>${esc(first)}.</em>` : "."}</h1>
      <p>Your workspace is being prepared. Michael will be in touch shortly.</p></div></div>`;
    return;
  }

  const blocks = await Promise.all(engagements.map(async (eng) => {
    const [assignments, pubs, files] = await Promise.all([store.assignmentsFor(eng.id), store.publications(eng.id), store.engagementFiles(eng.id)]);
    return { eng, assignments, pubs, files };
  }));

  main.innerHTML = `<div class="p-shell">
    <div class="p-greeting">
      <p class="eyebrow">${esc(session.profile.company || "Client Portal")}</p>
      <h1>${esc(greeting())}${first ? `, <em>${esc(first)}.</em>` : "."}</h1>
      <p>Everything for your engagement in one place: questions to answer, updates from Michael and the documents you've shared.</p>
    </div>
    ${blocks.map(({ eng, assignments, pubs, files }) => `
    <div class="p-grid">
      <div class="p-stack">
        <section class="p-card p-card--accent" aria-labelledby="eng-${esc(eng.id)}">
          <div class="p-row"><p class="p-kicker">Engagement</p>${statusPill(eng.status)}</div>
          <h2 id="eng-${esc(eng.id)}">${esc(eng.title)}</h2>
          ${eng.summary ? `<p>${esc(eng.summary)}</p>` : ""}
        </section>
        <section class="p-card" aria-label="Questionnaires">
          <p class="p-kicker">For you to complete</p>
          ${assignments.length ? `<ul class="p-list">${assignments.map(assignmentCard).join("")}</ul>` : `<p class="p-empty">Nothing to complete right now.</p>`}
        </section>
        <section class="p-card" aria-label="Updates from Michael">
          <p class="p-kicker">Updates from Michael</p>
          ${pubs.length ? `<ul class="p-list">${pubs.map((p) => `<li><div class="p-row"><h3>${esc(p.title)}</h3><span class="p-muted">${esc(fmtDate(p.published_at))}</span></div><div class="p-muted" style="margin-top:.5rem">${paragraphs(p.body)}</div></li>`).join("")}</ul>` : `<p class="p-empty">Updates will appear here as your engagement progresses.</p>`}
        </section>
      </div>
      <div class="p-stack">
        <section class="p-card p-card--navy">
          <p class="p-kicker">Your principal</p>
          <h3>${esc(ADMIN_CONTACT.name)}</h3>
          <p>${esc(ADMIN_CONTACT.title)}, Sypher Solutions</p>
          <p style="margin-top:1rem"><a class="link-arrow" style="color:var(--champagne)" href="mailto:${esc(ADMIN_CONTACT.email)}">Email Michael</a></p>
        </section>
        <section class="p-card" aria-label="Your documents">
          <p class="p-kicker">Documents you've shared</p>
          ${files.length ? `<ul class="p-list">${files.map((f) => `<li class="p-row"><span>${esc(f.name)}</span><span class="p-muted">${esc(relTime(f.created_at))}</span></li>`).join("")}</ul>` : `<p class="p-muted">Files you attach to answers will be listed here.</p>`}
        </section>
      </div>
    </div>`).join("")}
  </div>`;
}

render().catch((err) => { console.error(err); toast(err.message, true); });
