// The contact page diagnostic: four short steps that become Michael's notes
// for the first call. Answers are kept in this tab (sessionStorage) until sent,
// so a refresh doesn't lose them.
import { store, isDemo } from "./portal/store.js";

const root = document.querySelector("[data-diagnostic]");

const SITUATIONS = [
  ["Launch", "Testing whether an idea is a business"],
  ["Grow", "Need more of the right customers"],
  ["Run", "Too much depends on one person"],
  ["Modernize", "Tools and systems that don’t talk"],
  ["Fund", "Grants or programs we might qualify for"],
  ["Lead", "A senior seat we can’t fill full-time"],
  ["Invent", "A device or formulation to develop"],
  ["Recover", "Books that don’t tie out, or money owed"],
  ["Not sure", "Something’s wrong; I can’t name it yet"],
];

// Two questions per practice, in the language owners use.
const QUESTIONS = {
  Launch: [
    ["launch_1", "What are you launching, and what has to be true for it to work?"],
    ["launch_2", "What’s committed so far: money, a lease, equipment, customers?"],
  ],
  Grow: [
    ["grow_1", "Where do your best customers come from today?"],
    ["grow_2", "What happens to a lead between first contact and a signed deal?"],
  ],
  Run: [
    ["run_1", "What breaks when you’re out for a week?"],
    ["run_2", "Which processes live only in someone’s head?"],
  ],
  Modernize: [
    ["modernize_1", "Which tools do you pay for, and which do people actually use?"],
    ["modernize_2", "Where does the same information get typed in twice?"],
  ],
  Fund: [
    ["fund_1", "Which grants or programs are you looking at, and is there a deadline?"],
    ["fund_2", "Is the business registered on SAM.gov, and has it received public funds before?", ["Yes, registered and funded before", "Registered, not funded yet", "Not registered", "Not sure"]],
  ],
  Lead: [
    ["lead_1", "Which seat is empty: operations, marketing, finance or something else?"],
    ["lead_2", "What would that person own in their first ninety days?"],
  ],
  Invent: [
    ["invent_1", "What is the product, and who uses it?"],
    ["invent_2", "How far along is it?", ["Concept", "Early prototype", "Testing with users", "Planning the regulatory pathway"]],
  ],
  Recover: [
    ["recover_1", "What doesn’t tie out, and since when?"],
    ["recover_2", "Which system holds the books, and who keeps them?"],
  ],
  "Not sure": [
    ["unsure_1", "Describe the problem the way you’d describe it to a friend."],
  ],
};

const SHAPE = [
  ["tried", "What have you already tried?", null, "textarea"],
  ["good", "If this goes well, what’s different in twelve months?", null, "textarea"],
  ["stage", "Stage", ["Idea or pre-launch", "Startup (0–3 years)", "Established small business", "Mid-sized company", "Nonprofit or mission-driven", "Research or life-science venture"]],
  ["team", "Team size", ["Just me", "2–10", "11–50", "51–200", "More than 200"]],
  ["timeline", "Timeline", ["As soon as possible", "Within 1–3 months", "3–6 months", "Exploring for now"]],
  ["budget", "Budget set aside", ["Not yet", "Under $10,000", "$10,000–$25,000", "$25,000–$75,000", "More than $75,000", "Prefer to discuss"]],
];

const STEPS = ["Where you are", "In your words", "The shape of it", "About you"];
const KEY = "sypher-diagnostic";
const startedAt = Date.now();

let state = { step: 0, practices: [], answers: {}, about: {} };
try { state = { ...state, ...JSON.parse(sessionStorage.getItem(KEY) || "{}") }; } catch (_) { /* fresh start */ }
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* best effort */ } };

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function field([key, label, options, kind], value, required = false) {
  const id = `dx-${key}`;
  if (options) {
    return `<div class="field${kind === "full" ? " form__full" : ""}"><label for="${id}">${esc(label)}</label>
      <select id="${id}" data-key="${key}"><option value="">Select…</option>${options.map((o) => `<option${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`;
  }
  return `<div class="field form__full"><label for="${id}">${esc(label)}</label>
    <textarea id="${id}" data-key="${key}" rows="3"${required ? " required" : ""}>${esc(value || "")}</textarea></div>`;
}

function stepBody() {
  if (state.step === 0) {
    return `<fieldset class="dx__fs"><legend class="dx__legend">What brings you here? <span>Choose up to three.</span></legend>
      <div class="dx__cards">${SITUATIONS.map(([p, line]) => `<label class="dx__card">
        <input type="checkbox" value="${esc(p)}"${state.practices.includes(p) ? " checked" : ""}>
        <span><b>${esc(p)}</b>${esc(line)}</span></label>`).join("")}</div></fieldset>`;
  }
  if (state.step === 1) {
    const qs = state.practices.flatMap((p) => (QUESTIONS[p] || []).map(([key, label, options]) => [key, label, options || null, p]));
    return `<fieldset class="dx__fs"><legend class="dx__legend">In your words <span>A sentence or two each is plenty. Skip any that don’t apply.</span></legend>
      <div class="form dx__form">${qs.map(([key, label, options, p]) => `<div class="dx__q form__full"><span class="dx__tag">${esc(p)}</span>${field([key, label, options, "full"], state.answers[key])}</div>`).join("")}</div></fieldset>`;
  }
  if (state.step === 2) {
    return `<fieldset class="dx__fs"><legend class="dx__legend">The shape of it <span>Ranges are fine. Nothing here is binding.</span></legend>
      <div class="form dx__form">${SHAPE.map((q) => field(q, state.answers[q[0]])).join("")}</div></fieldset>`;
  }
  const a = state.about;
  const input = (k, label, type, auto, req) => `<div class="field"><label for="dx-${k}">${label}${req ? "" : ` <span class="dx__opt">optional</span>`}</label>
    <input id="dx-${k}" data-about="${k}" type="${type}" autocomplete="${auto}" value="${esc(a[k] || "")}"${req ? " required" : ""}></div>`;
  return `<fieldset class="dx__fs"><legend class="dx__legend">About you <span>So Michael knows who he’s writing to.</span></legend>
    <div class="form dx__form">
      ${input("name", "Name", "text", "name", true)}${input("email", "Email", "email", "email", true)}
      ${input("company", "Organization", "text", "organization", false)}${input("role", "Your role", "text", "organization-title", false)}
      ${input("phone", "Phone", "tel", "tel", false)}
      <div class="hp" aria-hidden="true"><label for="dx-website">Website</label><input id="dx-website" data-about="website" type="text" tabindex="-1" autocomplete="off"></div>
      <p class="form__note form__full">Your answers are used only to prepare for the conversation. <a class="accent" href="privacy.html">Privacy</a></p>
    </div></fieldset>`;
}

function render(focus = false) {
  const last = state.step === STEPS.length - 1;
  root.innerHTML = `<form class="dx__shell" novalidate>
    <div class="dx__head">
      <p class="dx__step">Step ${state.step + 1} of ${STEPS.length} · ${esc(STEPS[state.step])}</p>
      <ol class="dx__bar" aria-hidden="true">${STEPS.map((_, i) => `<li class="${i < state.step ? "is-done" : i === state.step ? "is-on" : ""}"></li>`).join("")}</ol>
    </div>
    ${stepBody()}
    <p class="dx__error" role="alert"></p>
    <div class="dx__nav">
      ${state.step ? `<button type="button" class="btn btn--ghost btn--sm" data-back>Back</button>` : "<span></span>"}
      <button type="submit" class="btn btn--navy">${last ? "Send to Michael" : "Continue"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M1 8h13M9 3l5 5-5 5"/></svg></button>
    </div>
  </form>`;
  if (focus) {
    const legend = root.querySelector(".dx__legend");
    legend.setAttribute("tabindex", "-1");
    legend.focus({ preventScroll: true });
    root.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }
}

function collect() {
  root.querySelectorAll("[data-key]").forEach((el) => { state.answers[el.dataset.key] = el.value.trim(); });
  root.querySelectorAll("[data-about]").forEach((el) => { state.about[el.dataset.about] = el.value.trim(); });
  const boxes = root.querySelectorAll(".dx__cards input");
  if (boxes.length) state.practices = [...boxes].filter((b) => b.checked).map((b) => b.value);
  save();
}

function validate() {
  if (state.step === 0 && !state.practices.length) return "Choose at least one, or “Not sure”.";
  if (state.step === 1) {
    const keys = state.practices.flatMap((p) => (QUESTIONS[p] || []).map((q) => q[0]));
    if (!keys.some((k) => state.answers[k])) return "Answer at least one question, even briefly.";
  }
  if (state.step === 3) {
    if ((state.about.name || "").length < 2) return "Please add your name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(state.about.email || "")) return "Please add a valid email so Michael can reply.";
  }
  return "";
}

function payload() {
  const answers = [];
  for (const p of state.practices) {
    for (const [key, question] of QUESTIONS[p] || []) {
      if (state.answers[key]) answers.push({ key, section: p, question, answer: state.answers[key] });
    }
  }
  for (const [key, question] of SHAPE) {
    if (state.answers[key]) answers.push({ key, section: "The shape of it", question, answer: state.answers[key] });
  }
  const { name, email, company, role, phone, website } = state.about;
  return { name, email, company, role, phone, website, practices: state.practices, answers, started_at: startedAt };
}

function memo(p) {
  const date = new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  const groups = [];
  for (const a of p.answers) {
    let g = groups.find((x) => x.section === a.section);
    if (!g) { g = { section: a.section, items: [] }; groups.push(g); }
    g.items.push(a);
  }
  const mailBody = [`From: ${p.name}${p.role ? `, ${p.role}` : ""}${p.company ? `, ${p.company}` : ""}`, `Email: ${p.email}`, "",
    ...p.answers.map((a) => `${a.question}\n${a.answer}\n`)].join("\n");
  const mailto = `mailto:michael@sypher.solutions?subject=${encodeURIComponent(`First conversation: ${p.company || p.name}`)}&body=${encodeURIComponent(mailBody.slice(0, 1800))}`;
  return `<article class="memo" tabindex="-1">
    <p class="memo__kicker">Received · ${esc(date)}</p>
    <h2 class="memo__title">Thank you, <em>${esc(p.name.split(/\s+/)[0])}.</em></h2>
    <p class="memo__lede">Here are your notes as Michael will read them before you speak. ${isDemo ? "" : "He’ll reply from michael@sypher.solutions to set a time."}</p>
    ${isDemo ? `<p class="memo__demo"><strong>Preview mode.</strong> This site isn’t connected to its inbox yet, so these notes are saved only in this browser. To send them now, use “Email these notes”.</p>` : ""}
    <div class="memo__sheet">
      <dl class="memo__meta">
        <div><dt>For</dt><dd>Michael Furth</dd></div>
        <div><dt>From</dt><dd>${esc([p.name, p.role, p.company].filter(Boolean).join(", "))}</dd></div>
        <div><dt>Regarding</dt><dd>${esc(p.practices.join(", "))}</dd></div>
      </dl>
      ${groups.map((g) => `<section class="memo__group"><h3>${esc(g.section)}</h3>${g.items.map((a) => `<p class="memo__q">${esc(a.question)}</p><p class="memo__a">${esc(a.answer)}</p>`).join("")}</section>`).join("")}
    </div>
    <div class="btn-row memo__actions">
      ${isDemo ? `<a class="btn btn--navy btn--sm" href="${mailto}">Email these notes</a>` : ""}
      <button type="button" class="btn btn--ghost btn--sm" data-print>Print or save a copy</button>
    </div>
  </article>`;
}

async function onSubmit(e) {
  e.preventDefault();
  collect();
  const err = validate();
  const box = root.querySelector(".dx__error");
  if (err) { box.textContent = err; return; }
  box.textContent = "";
  if (state.step < STEPS.length - 1) { state.step += 1; save(); render(true); return; }

  const btn = root.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.firstChild.textContent = "Sending… ";
  const p = payload();
  try {
    await store.submitInquiry(p);
    try { sessionStorage.removeItem(KEY); } catch (_) { /* ignore */ }
    root.innerHTML = memo(p);
    root.querySelector(".memo").focus({ preventScroll: true });
    root.scrollIntoView({ block: "start" });
  } catch (error) {
    box.textContent = error.message;
    btn.disabled = false;
    btn.firstChild.textContent = "Send to Michael ";
  }
}

if (root) {
  root.addEventListener("submit", onSubmit);
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-back]")) { collect(); state.step -= 1; save(); render(true); }
    if (e.target.closest("[data-print]")) window.print();
  });
  // Cap the situation cards at three.
  root.addEventListener("change", (e) => {
    if (!e.target.matches(".dx__cards input")) return;
    const checked = root.querySelectorAll(".dx__cards input:checked");
    if (checked.length > 3) { e.target.checked = false; root.querySelector(".dx__error").textContent = "Three is the limit. Pick the ones that matter most."; }
    else root.querySelector(".dx__error").textContent = "";
  });
  if (state.step > 0 && !state.practices.length) state.step = 0;
  render();
}
