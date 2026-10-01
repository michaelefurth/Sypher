// Questionnaire: section rail, autosaving answers, "don't know yet" + notes,
// file attachments, filters, and a review-and-submit step that locks answers.
import { store } from "./store.js";
import { esc, $, $$, fmtDate, renderChrome, requireSession, toast, confirmDialog, statusPill } from "./ui.js";

const main = document.getElementById("main");
const assignmentId = new URLSearchParams(location.search).get("a");
const pending = new Map(); // questionId -> timer
let saving = 0;
let data, editable, answers;

const PRIORITY = {
  rerun: `<span class="pill pill--gold">High impact · updates the model</span>`,
  critical: `<span class="pill pill--gold">Critical next step</span>`,
};

function answerOf(q) { return answers.get(q.id) || { value: "", state: "answered", note: "" }; }
function isAnswered(a) { return a.state !== "unknown" && (a.value || "").trim().length > 0; }
function isPending(a) { return a.state === "unknown"; }

function sections(questions) {
  const out = [];
  for (const q of questions) {
    const key = q.section_code || q.section_title || "_";
    let s = out.find((x) => x.key === key);
    if (!s) { s = { key, code: q.section_code, title: q.section_title || "Questions", questions: [] }; out.push(s); }
    s.questions.push(q);
  }
  return out;
}

function inputFor(q, a) {
  const ro = editable ? "" : "readonly";
  const id = `ans-${q.id}`;
  const val = esc(a.value || "");
  const label = `aria-labelledby="prompt-${esc(q.id)}"`;
  switch (q.answer_type) {
    case "short_text": return `<input class="p-input" id="${id}" data-field="value" ${label} value="${val}" ${ro}>`;
    case "number":
    case "currency": return `<input class="p-input" id="${id}" data-field="value" ${label} inputmode="decimal" value="${val}" placeholder="${q.answer_type === "currency" ? "$" : ""}" ${ro}>`;
    case "date": return `<input class="p-input" id="${id}" data-field="value" ${label} type="date" value="${val}" ${ro}>`;
    case "yes_no": return `<select class="p-select" id="${id}" data-field="value" ${label} ${editable ? "" : "disabled"}>
        ${["", "Yes", "No", "Not sure"].map((o) => `<option value="${o}" ${a.value === o ? "selected" : ""}>${o || "Select…"}</option>`).join("")}</select>`;
    default: return `<textarea class="p-textarea" id="${id}" data-field="value" ${label} placeholder="${editable ? "Your answer. Approximate figures are fine; note any assumptions." : ""}" ${ro}>${val}</textarea>`;
  }
}

function card(q) {
  const a = answerOf(q);
  const files = data.files.filter((f) => f.question_id === q.id);
  const hasNote = (a.note || "").trim().length > 0;
  return `<article class="qcard ${q.priority ? "qcard--priority" : ""} ${isPending(a) ? "is-unknown" : ""}" id="q-${esc(q.id)}" data-q="${esc(q.id)}" data-priority="${q.priority ? 1 : 0}">
    <div class="qcard__top">
      <span class="qcard__num">${esc(q.number || q.position)}</span>
      <div class="qcard__body">
        ${q.priority ? `<div class="qcard__badges">${PRIORITY[q.priority]}</div>` : ""}
        <h3 class="qcard__prompt" id="prompt-${esc(q.id)}">${esc(q.prompt)}</h3>
        ${q.why ? `<details class="qcard__why"><summary>Why we ask</summary><p>${esc(q.why)}</p></details>` : ""}
        <div class="qcard__answer">${inputFor(q, a)}</div>
        <div class="qcard__note" ${hasNote ? "" : "hidden"}>
          <label class="p-label" for="note-${esc(q.id)}">Note for Michael</label>
          <textarea class="p-textarea" id="note-${esc(q.id)}" data-field="note" rows="2" placeholder="Context, caveats, or when you'll have the answer" ${editable ? "" : "readonly"}>${esc(a.note || "")}</textarea>
        </div>
        <div class="qcard__files">${files.map((f) => `<span>${esc(f.name)}</span>`).join("")}</div>
        ${editable ? `<div class="qcard__tools">
          <label class="p-check"><input type="checkbox" data-field="unknown" ${isPending(a) ? "checked" : ""}> I don't know yet</label>
          <button type="button" class="p-linkbtn" data-add-note ${hasNote ? "hidden" : ""}>Add a note</button>
          <span class="p-linkbtn file-btn">Attach a file<input type="file" data-file aria-label="Attach a file to question ${esc(q.number || q.position)}"></span>
          <span class="qcard__state" aria-live="polite"></span>
        </div>` : ""}
      </div>
    </div>
  </article>`;
}

function counts() {
  let answered = 0, unknown = 0;
  for (const q of data.questions) { const a = answerOf(q); if (isAnswered(a)) answered++; else if (isPending(a)) unknown++; }
  return { answered, unknown, blank: data.questions.length - answered - unknown, total: data.questions.length };
}

function refreshMeters() {
  const c = counts();
  const meter = $("#qn-meter-num");
  if (meter) meter.innerHTML = `${c.answered + c.unknown}<small> / ${c.total}</small>`;
  for (const s of sections(data.questions)) {
    const link = $(`.qn-rail a[data-section="${CSS.escape(s.key)}"]`);
    if (!link) continue;
    const done = s.questions.filter((q) => { const a = answerOf(q); return isAnswered(a) || isPending(a); }).length;
    link.lastElementChild.textContent = `${done}/${s.questions.length}`;
    link.classList.toggle("is-done", done === s.questions.length);
  }
  const stats = $("#qn-stats");
  if (stats) stats.innerHTML = `<div><b>${c.answered}</b><span>Answered</span></div><div><b>${c.unknown}</b><span>Pending</span></div><div><b>${c.blank}</b><span>Not started</span></div>`;
  const open = $("#qn-open");
  if (open) {
    const blanks = data.questions.filter((q) => { const a = answerOf(q); return !isAnswered(a) && !isPending(a); });
    open.innerHTML = blanks.length
      ? `Not started: ${blanks.slice(0, 14).map((q) => `<button type="button" data-jump="${esc(q.id)}">${esc(q.number || q.position)}</button>`).join(" ")}${blanks.length > 14 ? " …" : ""}`
      : "Every question has an answer or a note. Thank you.";
  }
}

function setSaveState(text, busy = false) {
  const el = $("#qn-save");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-saving", busy);
}

function queueSave(qId) {
  clearTimeout(pending.get(qId));
  setSaveState("Saving…", true);
  pending.set(qId, setTimeout(() => flush(qId), 700));
}

async function flush(qId) {
  clearTimeout(pending.get(qId));
  pending.delete(qId);
  const el = $(`.qcard[data-q="${CSS.escape(qId)}"]`);
  const a = answerOf({ id: qId });
  saving++;
  const stateEl = el?.querySelector(".qcard__state");
  try {
    const row = await store.saveAnswer(assignmentId, qId, { value: a.value ?? "", state: a.state || "answered", note: a.note || null });
    answers.set(qId, { ...a, ...row });
    if (stateEl) { stateEl.textContent = "Saved"; stateEl.classList.add("is-saved"); }
  } catch (err) {
    if (stateEl) { stateEl.textContent = "Not saved"; stateEl.classList.remove("is-saved"); }
    toast(`Couldn't save: ${err.message}`, true);
  } finally {
    saving--;
    if (!saving && !pending.size) setSaveState(`All changes saved · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  }
}

async function flushAll() { await Promise.all([...pending.keys()].map(flush)); }

function bind() {
  main.addEventListener("input", (e) => {
    const cardEl = e.target.closest(".qcard");
    if (!cardEl || !editable) return;
    const qId = cardEl.dataset.q;
    const a = { ...answerOf({ id: qId }) };
    if (e.target.dataset.field === "value") a.value = e.target.value;
    if (e.target.dataset.field === "note") a.note = e.target.value;
    answers.set(qId, a);
    queueSave(qId);
    refreshMeters();
  });
  main.addEventListener("change", async (e) => {
    const cardEl = e.target.closest(".qcard");
    if (!cardEl || !editable) return;
    const qId = cardEl.dataset.q;
    if (e.target.dataset.field === "unknown") {
      const a = { ...answerOf({ id: qId }), state: e.target.checked ? "unknown" : "answered" };
      answers.set(qId, a);
      cardEl.classList.toggle("is-unknown", e.target.checked);
      if (e.target.checked) { cardEl.querySelector(".qcard__note").hidden = false; cardEl.querySelector("[data-add-note]")?.setAttribute("hidden", ""); cardEl.querySelector('[data-field="note"]').focus(); }
      queueSave(qId);
      refreshMeters();
    }
    if (e.target.dataset.field === "value" && e.target.tagName === "SELECT") {
      answers.set(qId, { ...answerOf({ id: qId }), value: e.target.value });
      queueSave(qId);
      refreshMeters();
    }
    if (e.target.matches("[data-file]") && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 50 * 1024 * 1024) { toast("Files must be under 50 MB.", true); return; }
      const stateEl = cardEl.querySelector(".qcard__state");
      stateEl.textContent = "Uploading…";
      try {
        const row = await store.uploadFile(data.assignment.engagement_id, assignmentId, qId, file);
        data.files.push(row);
        cardEl.querySelector(".qcard__files").insertAdjacentHTML("beforeend", `<span>${esc(row.name)}</span>`);
        stateEl.textContent = row.demo ? "Attached (demo: file not stored)" : "Attached";
      } catch (err) { stateEl.textContent = ""; toast(`Upload failed: ${err.message}`, true); }
      e.target.value = "";
    }
  });
  main.addEventListener("click", async (e) => {
    const add = e.target.closest("[data-add-note]");
    if (add) { const c = add.closest(".qcard"); c.querySelector(".qcard__note").hidden = false; add.hidden = true; c.querySelector('[data-field="note"]').focus(); }
    const jump = e.target.closest("[data-jump]");
    if (jump) { const target = $(`#q-${CSS.escape(jump.dataset.jump)}`); target?.scrollIntoView({ behavior: "smooth", block: "center" }); target?.querySelector("textarea, input, select")?.focus({ preventScroll: true }); }
    const filter = e.target.closest("[data-qfilter]");
    if (filter) {
      $$("[data-qfilter]").forEach((b) => { const on = b === filter; b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on)); });
      const mode = filter.dataset.qfilter;
      $$(".qcard").forEach((c) => {
        const a = answerOf({ id: c.dataset.q });
        c.hidden = (mode === "open" && (isAnswered(a) || isPending(a))) || (mode === "priority" && c.dataset.priority !== "1");
      });
      $$(".qn-section").forEach((s) => { s.hidden = !s.querySelector(".qcard:not([hidden])"); });
    }
    if (e.target.closest("[data-submit]")) submit();
  });
  window.addEventListener("beforeunload", (e) => { if (pending.size || saving) { e.preventDefault(); e.returnValue = ""; } });

  const links = $$(".qn-rail a");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) links.forEach((l) => l.classList.toggle("is-active", l.getAttribute("href") === `#${en.target.id}`)); });
    }, { rootMargin: "-30% 0px -60% 0px" });
    $$(".qn-section").forEach((s) => io.observe(s));
  }
}

async function submit() {
  await flushAll();
  const c = counts();
  const ok = await confirmDialog({
    title: "Submit your answers?",
    body: `<p>You've answered <strong>${c.answered}</strong> of ${c.total} questions${c.unknown ? ` and marked <strong>${c.unknown}</strong> as pending` : ""}${c.blank ? `; <strong>${c.blank}</strong> are not started` : ""}.</p>
      <p class="p-muted">Submitting sends everything to Michael for review and locks your answers. If anything changes, he can reopen the questionnaire for you.</p>`,
    confirmLabel: "Submit to Michael",
  });
  if (!ok) return;
  try {
    await store.submit(assignmentId);
    toast("Submitted. Thank you. Michael will review your answers.");
    await load();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) { toast(err.message, true); }
}

async function load() {
  data = await store.assignment(assignmentId);
  editable = ["open", "reopened"].includes(data.assignment.status);
  answers = new Map(data.answers.map((a) => [a.question_id, a]));
  const secs = sections(data.questions);
  const a = data.assignment;

  main.innerHTML = `<div class="p-shell">
    <p class="breadcrumb"><a href="dashboard.html">Overview</a><span>/</span>${esc(data.engagement?.title || "Engagement")}</p>
    <header class="qn-head">
      <div>
        <div class="p-row" style="justify-content:flex-start">${statusPill(a.status)}${a.due_date ? `<span class="p-muted">Due ${esc(fmtDate(a.due_date))}</span>` : ""}</div>
        <h1 style="margin-top:.75rem">${esc(data.questionnaire.title)}</h1>
        ${data.questionnaire.intro ? `<p class="lede">${esc(data.questionnaire.intro)}</p>` : ""}
        ${a.message ? `<p class="qn-note">${esc(a.message)}</p>` : ""}
      </div>
      <div class="qn-meter"><div class="qn-meter__num" id="qn-meter-num"></div><p class="p-label">Answered</p><p class="qn-save" id="qn-save" aria-live="polite">${editable ? "Answers save automatically" : ""}</p></div>
    </header>
    ${editable ? "" : `<p class="qn-locked">Submitted${a.submitted_at ? ` on ${esc(fmtDate(a.submitted_at))}` : ""}. Your answers are with Michael. If something has changed, email him and he can reopen the questionnaire.</p>`}
    <div class="qn-layout">
      <nav class="qn-rail" aria-label="Sections"><ol>
        ${secs.map((s) => `<li><a href="#sec-${esc(s.key)}" data-section="${esc(s.key)}"><span>${s.code ? `${esc(s.code)}. ` : ""}${esc(s.title)}</span><span></span></a></li>`).join("")}
      </ol></nav>
      <div>
        <div class="qn-filter" role="group" aria-label="Show questions">
          <button type="button" class="pfilter is-active" data-qfilter="all" aria-pressed="true">All</button>
          <button type="button" class="pfilter" data-qfilter="open" aria-pressed="false">Not started</button>
          <button type="button" class="pfilter" data-qfilter="priority" aria-pressed="false">High impact</button>
        </div>
        ${secs.map((s) => `<section class="qn-section" id="sec-${esc(s.key)}" aria-labelledby="sec-h-${esc(s.key)}">
          <div class="qn-section__title">${s.code ? `<span>${esc(s.code)}</span>` : ""}<h2 id="sec-h-${esc(s.key)}">${esc(s.title)}</h2></div>
          ${s.questions.map(card).join("")}
        </section>`).join("")}
        ${editable ? `<section class="qn-submit" aria-labelledby="submit-h">
          <div>
            <h2 id="submit-h">Ready when <em>you are.</em></h2>
            <div class="qn-submit__stats" id="qn-stats"></div>
            <p class="qn-submit__open" id="qn-open"></p>
          </div>
          <div><p>Your answers are saved as you go, so you can come back any time. Submit when you're ready for Michael to review them.</p>
          <button class="btn btn--gold" type="button" data-submit style="margin-top:1.25rem">Review &amp; submit</button></div>
        </section>` : ""}
      </div>
    </div>
  </div>`;
  refreshMeters();
}

(async () => {
  const session = await requireSession();
  if (!session) return;
  renderChrome(session, { active: "dashboard", admin: session.profile.role === "admin" });
  if (!assignmentId) { location.replace("dashboard.html"); return; }
  try {
    await load();
    bind();
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="p-shell"><p class="p-empty">We couldn't open this questionnaire. ${esc(err.message)}</p></div>`;
  }
})();
