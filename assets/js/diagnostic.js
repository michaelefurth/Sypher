// The contact page diagnostic: a short guided conversation that becomes
// Michael's notes for the first call. One question per screen, worded for the
// kind of organization the visitor runs, with a live "Notes for Michael" panel
// that fills in as they answer. Answers are kept in this tab (sessionStorage)
// until sent, so a refresh doesn't lose them.
//
// The payload sent to submit-inquiry is unchanged in shape:
//   { name, email, company, role, phone, website, practices[], answers[{ key, section, question, answer }], started_at }
import { store } from "./portal/store.js";

const root = document.querySelector("[data-diagnostic]");
const notesHost = document.querySelector("[data-dx-notes]");
const page = root?.closest(".contact");

/* ------------------------------------------------------------------------ */
/* Content                                                                   */
/* ------------------------------------------------------------------------ */
const PROFILES = [
  { id: "owner", label: "I run an operating business", line: "Customers, staff and a payroll to meet", note: "Runs an operating business" },
  { id: "founder", label: "I’m starting something", line: "An idea, a launch, or the first year or two", note: "Founder, early stage" },
  { id: "nonprofit", label: "I lead a nonprofit", line: "Or another mission-driven organization", note: "Leads a nonprofit or mission-driven organization" },
  { id: "research", label: "I’m developing a product", line: "A device, a formulation or a research spin-out", note: "Developing a product or technology" },
  { id: "other", label: "Something else", line: "An advisor, an investor, or a situation that doesn’t fit a box", note: "Something else" },
];

// What the visitor sees is worded for their kind of organization; each problem
// maps to one practice behind the scenes. `pick` is a quick tap question and
// `open` the question in their own words. Either can vary by profile, and the
// open question can also change with what they tapped.
const PROBLEMS = {
  launch: {
    practice: "Launch",
    label: {
      owner: ["A new line or location to test", "Is it worth it before the money goes in?"],
      founder: ["Find out if the idea is a business", "Before the lease, the loan or the hires"],
      nonprofit: ["A new program or earned-revenue idea", "Whether it can pay for itself"],
      research: ["Is there a business in it?", "Market, price and a plan to get there"],
      other: ["Testing whether an idea is a business", "Before the money is committed"],
    },
    pick: { key: "launch_stage", q: "Where is it now?", type: "radio", options: ["Still an idea", "Numbers on paper", "Money or a lease committed", "Open and testing"] },
    open: {
      key: "launch_1", q: "What has to be true for it to work?",
      examples: ["Enough wholesale accounts to fill a second kitchen", "A price people will pay that still leaves a margin", "A lender willing to wait through the first year"],
      variants: {
        "Money or a lease committed": { q: "What’s committed so far, and what has to be true for it to pay back?" },
        "Open and testing": { q: "What are the early numbers telling you?", examples: ["Sales are fine but margins are thin", "People like it; repeat orders are slow", "Costs came in higher than the plan"] },
      },
    },
    focus: "the few numbers that decide go or no-go",
  },
  customers: {
    practice: "Grow",
    label: {
      owner: ["Not enough of the right customers", "Or leads that don’t turn into work"],
      founder: ["Getting the first customers", "Who buys, and how they find you"],
      nonprofit: ["Reaching more people or donors", "The right people don’t know about us"],
      research: ["Finding the first buyers or partners", "Who pays, and how to reach them"],
      other: ["Need more of the right customers", "Or leads that stall"],
    },
    pick: { key: "grow_sources", q: "Where do your best customers come from today?", type: "checkbox", options: ["Referrals", "Search and our website", "Social media", "Outbound calls or email", "Partners", "Not sure yet"] },
    open: {
      key: "grow_2", q: "What happens to a lead between first contact and a signed deal?",
      examples: ["Calls go to voicemail and nobody follows up", "We send a quote and don’t hear back", "It depends on who picks up the phone"],
      byProfile: {
        founder: { q: "Who is the first customer, and what would make them say yes?", examples: ["Independent restaurants within an hour of us", "Clinics already buying something similar", "There’s interest, but nobody has paid yet"] },
        research: { q: "Who is the first customer, and what would make them say yes?", examples: ["Clinics already buying a similar device", "A distributor in our category", "There’s interest, but nobody has paid yet"] },
        nonprofit: { q: "Who do you most need to reach, and what gets in the way today?", examples: ["Families who qualify but never hear about us", "Donors give once and don’t come back", "We rely on two foundations for most of the budget"] },
      },
    },
    focus: "where your best customers come from, and where the rest are lost",
  },
  depends: {
    practice: "Run",
    label: {
      owner: ["Too much depends on me", "Or on one or two key people"],
      founder: ["Setting up how the work gets done", "Roles, routines and handoffs"],
      nonprofit: ["Too much depends on one or two people", "Programs run on goodwill and memory"],
      research: ["Running the business side", "As the team and partners grow"],
      other: ["Too much depends on one person", "Processes that live in someone’s head"],
    },
    pick: {
      key: "run_breaks", q: "What slips when the key person is out for a week?", type: "checkbox",
      options: ["Scheduling", "Quotes and pricing", "Billing and collections", "Hiring and onboarding", "Customer problems", "Most of it"],
      byProfile: { founder: { q: "What needs a system first?", options: ["Scheduling and delivery", "Quotes and pricing", "Billing", "Hiring the first people", "Customer service", "Not sure"] } },
    },
    open: { key: "run_2", q: "Which processes live only in someone’s head?", examples: ["How we price a job", "Month-end, which only our office manager knows", "Who to call when equipment breaks"] },
    focus: "what would break first if you stepped away, and what to write down first",
  },
  systems: {
    practice: "Modernize",
    label: {
      owner: ["Tools and systems that don’t talk", "The same information typed twice"],
      founder: ["Choosing the right tools from the start", "Before habits set in"],
      nonprofit: ["Systems and data that don’t talk", "Donor, program and finance records apart"],
      research: ["Data and systems for the team", "Lab, quality and business records"],
      other: ["Tools and systems that don’t talk", "Or a question about AI"],
    },
    pick: { key: "modernize_where", q: "Where does it show up?", type: "checkbox", options: ["Same data typed twice", "Tools nobody uses", "Reports take days", "Security and access", "Wondering about AI"] },
    open: {
      key: "modernize_1", q: "Which tools do you pay for, and which do people actually use?",
      examples: ["QuickBooks, a CRM nobody updates, and a lot of spreadsheets", "Microsoft 365, but files live on personal drives", "Three scheduling apps, one per team"],
      variants: { "Wondering about AI": { q: "Where would AI save the most time, if it worked?", examples: ["Drafting quotes from site notes", "Answering the same customer questions", "Summarizing intake calls"] } },
    },
    focus: "where the same work gets done twice, and which tools earn their keep",
  },
  funding: {
    practice: "Fund",
    label: {
      owner: ["Grants or programs we might qualify for", "Training funds, incentives, public contracts"],
      founder: ["Grants or programs for early funding", "Without giving up equity"],
      nonprofit: ["Grants and public funding", "Finding them, applying and reporting"],
      research: ["SBIR, STTR or other grants", "Non-dilutive funding for the work"],
      other: ["Grants or programs we might qualify for", "Public money we may be missing"],
    },
    pick: { key: "fund_2", q: "Is the organization registered on SAM.gov?", type: "radio", options: ["Registered and funded before", "Registered, not funded yet", "Not registered", "Not sure"] },
    open: {
      key: "fund_1", q: "Which grants or programs are you looking at, and is there a deadline?",
      examples: ["Nothing specific yet, just a sense there’s money we’re missing", "A state workforce training grant, due in March", "SBIR Phase I, next submission window"],
    },
    focus: "which programs you qualify for and what the deadlines allow",
  },
  seat: {
    practice: "Lead",
    label: {
      owner: ["A senior role we can’t fill full-time", "Operations, marketing or finance"],
      founder: ["Senior help without a full-time hire", "Someone who has done it before"],
      nonprofit: ["Leadership we can’t afford full-time", "An interim or part-time executive"],
      research: ["Someone to run the business side", "While the science moves forward"],
      other: ["A senior seat we can’t fill full-time", "Part-time, but accountable"],
    },
    pick: { key: "lead_seat", q: "Which seat is empty?", type: "checkbox", options: ["Operations", "Marketing", "Finance", "General management", "Something else"] },
    open: { key: "lead_2", q: "What would that person own in their first ninety days?", examples: ["A weekly scorecard and a hiring plan", "Monthly books and a cash forecast", "A sales process that doesn’t depend on me"] },
    focus: "what the seat would own, and how much of it a part-time lead can cover",
  },
  product: {
    practice: "Invent",
    label: {
      owner: ["A product, device or formulation to develop", "Alongside the current business"],
      founder: ["Developing a device or formulation", "From concept toward a regulatory plan"],
      research: ["Moving the device or formulation forward", "Design, testing and the regulatory path"],
      other: ["A device or formulation to develop", "From concept toward a plan"],
    },
    pick: { key: "invent_2", q: "How far along is it?", type: "radio", options: ["Concept", "Early prototype", "Testing with users", "Planning the regulatory pathway"] },
    open: { key: "invent_1", q: "What is the product, and who uses it?", examples: ["A wound dressing for home-care nurses", "A topical formulation for a skin condition", "A small diagnostic device for clinics"] },
    focus: "where the product stands, and the next decision in design or testing",
  },
  books: {
    practice: "Recover",
    label: {
      owner: ["Books that don’t tie out, or money owed", "Or margins you can’t see"],
      founder: ["Books I can’t rely on yet", "Set up right, or cleaned up"],
      nonprofit: ["Books or grant reporting that don’t tie out", "Restricted funds, reimbursements, audits"],
      other: ["Books that don’t tie out, or money owed", "Or margins you can’t see"],
    },
    pick: { key: "recover_what", q: "What’s slipping most?", type: "checkbox", options: ["Books don’t tie out", "Can’t see margins by job or product", "Money owed to us", "A system switch went wrong", "Tax or payroll filings"] },
    open: {
      key: "recover_1", q: "What doesn’t tie out, and since when?",
      examples: ["Bank balances haven’t matched since we moved to QuickBooks Online", "We can’t tell which jobs make money", "Customer credits and vendor refunds nobody has chased"],
      variants: { "Money owed to us": { q: "Who owes you, roughly how much, and how old is it?", examples: ["About $40,000 in unpaid invoices, some over a year old", "Overpayments to two vendors last year", "A tax credit we think we never claimed"] } },
    },
    focus: "the books from the last month that tied out, and what’s owed back to you",
  },
  unsure: {
    practice: "Not sure",
    label: { all: ["Not sure yet", "Something’s wrong; I can’t name it yet"] },
    open: { key: "unsure_1", q: "Describe the problem the way you’d describe it to a friend.", examples: ["We’re busier than ever and making less", "Everyone works hard and things still fall through", "I know something has to change, not what"] },
    focus: "what’s going on, in your words, and where to look first",
  },
};

const ORDER = {
  owner: ["customers", "depends", "books", "systems", "seat", "funding", "launch", "product", "unsure"],
  founder: ["launch", "customers", "funding", "systems", "depends", "seat", "product", "books", "unsure"],
  nonprofit: ["funding", "customers", "depends", "books", "systems", "seat", "launch", "unsure"],
  research: ["product", "funding", "launch", "customers", "seat", "systems", "unsure"],
  other: ["launch", "customers", "depends", "systems", "funding", "seat", "product", "books", "unsure"],
};

const FIT = {
  Launch: "feasibility and launch planning", Grow: "marketing and sales", Run: "operations",
  Modernize: "IT, AI and systems", Fund: "grants and public programs", Lead: "fractional leadership",
  Invent: "product R&D planning", Recover: "forensic bookkeeping and money owed",
};

const STAGE = {
  owner: { q: "How long has it been operating?", options: ["Under 3 years", "3 to 10 years", "More than 10 years"] },
  founder: { q: "Where are you?", options: ["Still an idea", "Pre-launch", "Launched in the last year", "One to three years in"] },
  nonprofit: { q: "Annual operating budget", options: ["Under $500,000", "$500,000 to $2 million", "$2 to $10 million", "More than $10 million", "Rather not say"] },
  research: { q: "Where does it sit?", options: ["University or lab", "Spin-out company", "Independent inventor", "Established company"] },
};
const TEAM = { q: "How many people?", options: ["Just me", "2–10", "11–50", "51–200", "More than 200"] };
const TIMELINE = { q: "When would you like to start?", options: ["As soon as possible", "Within 1–3 months", "3–6 months", "Exploring for now"] };
const BUDGET = { q: "Budget set aside", options: ["Not set yet", "Under $10,000", "$10,000–$25,000", "$25,000–$75,000", "More than $75,000", "Rather discuss it"] };
const TRIED = { key: "tried", q: "What have you already tried?", examples: ["A bookkeeper cleaned it up once, but it slipped again", "We hired an agency for six months", "Nothing yet. This is the first step"] };
const GOOD = { key: "good", q: "If this goes well, what’s different in twelve months?", examples: ["I can take two weeks off and nothing breaks", "We know which jobs make money", "The grant is funded and reporting is under control"] };

// Rough seconds per screen, for the "about X min left" estimate.
const SECONDS = { who: 10, problems: 15, problem: 45, org: 15, timing: 15, tried: 35, good: 30, about: 40 };

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */
const KEY = "sypher-diagnostic";
const startedAt = Date.now();
const fresh = () => ({ v: 2, i: 0, profile: "", problems: [], picks: {}, text: {}, chips: {}, about: {}, revealed: {} });
let state = fresh();
try {
  const saved = JSON.parse(sessionStorage.getItem(KEY) || "{}");
  if (saved.v === 2) state = { ...state, ...saved };
} catch (_) { /* fresh start */ }
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* best effort */ } };

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
let peekOpen = false;

const profile = () => PROFILES.find((p) => p.id === state.profile);
const labelFor = (id) => { const l = PROBLEMS[id].label; return l[state.profile] || l.all || l.other; };
const resolve = (spec) => (spec ? { ...spec, ...(spec.byProfile?.[state.profile] || {}) } : null);
function openFor(id) {
  const base = resolve(PROBLEMS[id].open);
  const picked = state.picks[id] || [];
  const variant = picked.map((v) => base.variants?.[v]).find(Boolean);
  return { ...base, ...(variant || {}) };
}

function screens() {
  const list = [{ id: "who" }, { id: "problems" }];
  const picks = state.problems.length ? state.problems : [null, null];
  for (const p of picks) list.push({ id: "problem", problem: p });
  list.push({ id: "org" }, { id: "timing" }, { id: "tried" }, { id: "good" }, { id: "about" });
  return list;
}
const current = () => screens()[Math.min(state.i, screens().length - 1)];

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */
function chipGroup(name, opts, selected, type = "radio", labelledBy = "") {
  const sel = Array.isArray(selected) ? selected : selected ? [selected] : [];
  return `<div class="dx__chips" role="group"${labelledBy ? ` aria-labelledby="${labelledBy}"` : ""}>${opts.map((o) => `<label class="dx__chip">
    <input type="${type}" name="${esc(name)}" value="${esc(o)}"${sel.includes(o) ? " checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`;
}

function examples(key, list) {
  if (!list?.length) return "";
  return `<div class="dx__ex"><span class="dx__ex-label" aria-hidden="true">For example</span>${list.map((x) => `<button type="button" class="dx__ex-btn" data-example="${esc(x)}" data-for="${esc(key)}" aria-label="Use example: ${esc(x)}">${esc(x)}</button>`).join("")}</div>`;
}

function textBlock(key, q, list, hidden = false, labelTag = "label") {
  const id = `dx-${key}`;
  const labelEl = labelTag === "label" ? `<label class="dx__open-q" for="${id}" id="${id}-q">${esc(q)}</label>` : "";
  return `<div class="dx__open${hidden ? " is-hidden" : ""}" data-open="${esc(key)}"${hidden ? " hidden" : ""}>
    ${labelEl}
    <textarea id="${id}" class="dx__textarea" data-text="${esc(key)}" rows="4"${labelTag === "label" ? "" : ` aria-labelledby="dx-legend"`}>${esc(state.text[key] || "")}</textarea>
    <div data-examples>${examples(key, list)}</div>
  </div>`;
}

function screenBody(s) {
  if (s.id === "who") {
    return `<fieldset class="dx__fs"><legend class="dx__legend" id="dx-legend">Let’s start with you. <span>Which is closest? It shapes the questions that follow.</span></legend>
      <div class="dx__cards dx__cards--profile">${PROFILES.map((p) => `<label class="dx__card" data-tap>
        <input type="radio" name="profile" value="${p.id}"${state.profile === p.id ? " checked" : ""}>
        <span><b>${esc(p.label)}</b>${esc(p.line)}</span></label>`).join("")}</div></fieldset>`;
  }
  if (s.id === "problems") {
    const ids = ORDER[state.profile] || ORDER.other;
    return `<fieldset class="dx__fs"><legend class="dx__legend" id="dx-legend">What would you most like to fix? <span>Choose up to three. You can change this later.</span></legend>
      <div class="dx__cards">${ids.map((id) => { const [t, line] = labelFor(id); return `<label class="dx__card${id === "unsure" ? " dx__card--quiet" : ""}">
        <input type="checkbox" name="problem" value="${id}"${state.problems.includes(id) ? " checked" : ""}>
        <span><b>${esc(t)}</b>${esc(line)}</span></label>`; }).join("")}</div>
      <p class="dx__count" aria-live="polite">${countText()}</p></fieldset>`;
  }
  if (s.id === "problem") {
    const id = s.problem;
    const [title] = labelFor(id);
    const n = state.problems.indexOf(id) + 1;
    const kicker = `<p class="dx__about">${state.problems.length > 1 ? `${n} of ${state.problems.length} · ` : ""}${esc(title)}</p>`;
    const pick = resolve(PROBLEMS[id].pick);
    const open = openFor(id);
    if (!pick) {
      return `${kicker}<fieldset class="dx__fs"><legend class="dx__legend" id="dx-legend">${esc(open.q)} <span>A few sentences is plenty.</span></legend>${textBlock(open.key, open.q, open.examples, false, "legend")}</fieldset>`;
    }
    const picked = state.picks[id] || [];
    const show = picked.length || state.text[open.key] || state.revealed[id];
    return `${kicker}<fieldset class="dx__fs"><legend class="dx__legend" id="dx-legend">${esc(pick.q)} <span>${pick.type === "checkbox" ? "Tap all that apply." : "Tap one."}</span></legend>
      ${chipGroup(`pick-${id}`, pick.options, picked, pick.type)}
      ${show ? "" : `<button type="button" class="dx__reveal" data-reveal="${id}">Skip the options and write it instead</button>`}
      ${textBlock(open.key, open.q, open.examples, !show)}
    </fieldset>`;
  }
  if (s.id === "org") {
    const stage = STAGE[state.profile];
    return `<fieldset class="dx__fs"><legend class="dx__legend" id="dx-legend">A little about the organization <span>Tap whatever fits. Skip anything you’d rather discuss.</span></legend>
      ${stage ? `<p class="dx__sub" id="dx-stage-q">${esc(stage.q)}</p>${chipGroup("stage", stage.options, state.chips.stage, "radio", "dx-stage-q")}` : ""}
      <p class="dx__sub" id="dx-team-q">${esc(TEAM.q)}</p>${chipGroup("team", TEAM.options, state.chips.team, "radio", "dx-team-q")}
    </fieldset>`;
  }
  if (s.id === "timing") {
    return `<fieldset class="dx__fs"><legend class="dx__legend" id="dx-legend">Timing and budget <span>Ranges are fine. Nothing here is binding.</span></legend>
      <p class="dx__sub" id="dx-timeline-q">${esc(TIMELINE.q)}</p>${chipGroup("timeline", TIMELINE.options, state.chips.timeline, "radio", "dx-timeline-q")}
      <p class="dx__sub" id="dx-budget-q">${esc(BUDGET.q)}</p>${chipGroup("budget", BUDGET.options, state.chips.budget, "radio", "dx-budget-q")}
    </fieldset>`;
  }
  if (s.id === "tried" || s.id === "good") {
    const spec = s.id === "tried" ? TRIED : GOOD;
    const sub = s.id === "tried" ? "Including what didn’t work. That often says the most." : "A sentence is plenty.";
    return `<fieldset class="dx__fs"><legend class="dx__legend" id="dx-legend">${esc(spec.q)} <span>${sub}</span></legend>${textBlock(spec.key, spec.q, spec.examples, false, "legend")}</fieldset>`;
  }
  const a = state.about;
  const input = (k, label, type, auto, req) => `<div class="field"><label for="dx-${k}">${label}${req ? "" : ` <span class="dx__opt">optional</span>`}</label>
    <input id="dx-${k}" data-about="${k}" type="${type}" autocomplete="${auto}" value="${esc(a[k] || "")}"${req ? " required" : ""}></div>`;
  return `<fieldset class="dx__fs"><legend class="dx__legend" id="dx-legend">Last, where should Michael reply? <span>He writes back himself, from michael@sypher.solutions.</span></legend>
    <div class="form dx__form">
      ${input("name", "Name", "text", "name", true)}${input("email", "Email", "email", "email", true)}
      ${input("company", "Organization", "text", "organization", false)}${input("role", "Your role", "text", "organization-title", false)}
      ${input("phone", "Phone", "tel", "tel", false)}
      <div class="hp" aria-hidden="true"><label for="dx-website">Website</label><input id="dx-website" data-about="website" type="text" tabindex="-1" autocomplete="off"></div>
      <p class="form__note form__full">Your answers are used only to prepare for the conversation. <a class="accent" href="privacy.html">Privacy</a></p>
    </div></fieldset>`;
}

function countText() {
  const n = state.problems.length;
  return n ? `${n} of 3 chosen` : "";
}

function progress() {
  const list = screens();
  const i = Math.min(state.i, list.length - 1);
  const secs = list.slice(i).reduce((sum, s) => sum + (SECONDS[s.id] || 20), 0);
  const mins = Math.round(secs / 60);
  const left = mins < 1 ? "Under a minute left" : `About ${mins} min left`;
  return { label: `Question ${i + 1} of ${state.problems.length ? "" : "~"}${list.length}`, left, pct: Math.round((i / list.length) * 100) };
}

function hasAnswer(s) {
  if (s.id === "who") return !!state.profile;
  if (s.id === "problems") return state.problems.length > 0;
  if (s.id === "problem") return (state.picks[s.problem] || []).length > 0 || !!state.text[openFor(s.problem).key];
  if (s.id === "org") return !!(state.chips.stage || state.chips.team);
  if (s.id === "timing") return !!(state.chips.timeline || state.chips.budget);
  if (s.id === "tried" || s.id === "good") return !!state.text[s.id];
  return true;
}
const required = (s) => ["who", "problems", "about"].includes(s.id);

function buttonLabel(s) {
  if (s.id === "about") return "Send to Michael";
  return hasAnswer(s) || required(s) ? "Continue" : "Skip for now";
}

function render(focus = false) {
  const s = current();
  const pr = progress();
  const isText = ["tried", "good", "problem"].includes(s.id);
  root.innerHTML = `<form class="dx__shell" novalidate>
    <div class="dx__head">
      <p class="dx__step"><span>${esc(pr.label)}</span><span class="dx__eta">${esc(pr.left)}</span></p>
      <div class="dx__bar" aria-hidden="true"><span style="width:${pr.pct}%"></span></div>
    </div>
    ${state.profile ? `<details class="dx__peek"${peekOpen ? " open" : ""}><summary>Your notes so far</summary><div class="dx__peek-body" data-peek></div></details>` : ""}
    <div class="dx__screen${reduced() ? "" : " is-entering"}" data-screen="${esc(s.id)}">${screenBody(s)}</div>
    <p class="dx__error" role="alert"></p>
    <div class="dx__nav">
      ${state.i ? `<button type="button" class="btn btn--ghost btn--sm" data-back>Back</button>` : "<span></span>"}
      <span class="dx__hint" aria-hidden="true">${s.id === "about" ? "" : isText ? `${isMac ? "⌘" : "Ctrl"} + Enter to continue` : "or press Enter"}</span>
      <button type="submit" class="btn btn--navy" data-next>${esc(buttonLabel(s))}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M1 8h13M9 3l5 5-5 5"/></svg></button>
    </div>
  </form>`;
  root.querySelector(".dx__peek")?.addEventListener("toggle", (e) => { peekOpen = e.target.open; });
  renderNotes();
  if (focus) {
    const legend = root.querySelector(".dx__legend");
    legend.setAttribute("tabindex", "-1");
    legend.focus({ preventScroll: true });
    const top = root.getBoundingClientRect().top;
    if (top < 0 || top > innerHeight * 0.35) root.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
  }
}

function updateNext() {
  const btn = root.querySelector("[data-next]");
  if (btn) btn.firstChild.textContent = `${buttonLabel(current())} `;
}

/* ------------------------------------------------------------------------ */
/* Notes for Michael (live)                                                  */
/* ------------------------------------------------------------------------ */
const clipText = (t, n = 150) => { const s = String(t || "").trim().replace(/\s+/g, " "); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };
function practices() {
  const out = [];
  for (const id of state.problems) { const p = PROBLEMS[id]?.practice; if (p && !out.includes(p)) out.push(p); }
  return out.slice(0, 3);
}

function notesHTML() {
  const p = profile();
  if (!p) return `<p class="dxn__empty">Your answers will appear here, the way Michael will read them.</p>`;
  const who = [p.note, state.chips.stage, state.chips.team ? `${state.chips.team} ${state.chips.team === "Just me" ? "" : "people"}`.trim() : ""].filter(Boolean).join(" · ");
  const items = state.problems.map((id) => {
    const [title] = labelFor(id);
    const picked = (state.picks[id] || []).join(", ");
    const said = state.text[openFor(id).key];
    return `<li><b>${esc(title)}</b>${picked ? `<span>${esc(picked)}</span>` : ""}${said ? `<q>${esc(clipText(said))}</q>` : ""}</li>`;
  }).join("");
  const timing = [state.chips.timeline, state.chips.budget && state.chips.budget !== "Rather discuss it" ? `budget ${state.chips.budget}` : state.chips.budget].filter(Boolean).join(" · ");
  const fit = practices().filter((x) => x !== "Not sure");
  const first = state.problems.find((id) => id !== "unsure") || state.problems[0];
  const extra = [];
  if (state.text.tried) extra.push(`<div><dt>Tried so far</dt><dd>${esc(clipText(state.text.tried, 120))}</dd></div>`);
  if (state.text.good) extra.push(`<div><dt>A good outcome</dt><dd>${esc(clipText(state.text.good, 120))}</dd></div>`);
  return `<dl class="dxn__list">
    <div><dt>Who</dt><dd>${esc(who)}</dd></div>
    ${items ? `<div><dt>What’s going on</dt><dd><ul class="dxn__items">${items}</ul></dd></div>` : ""}
    ${timing ? `<div><dt>Timing</dt><dd>${esc(timing)}</dd></div>` : ""}
    ${extra.join("")}
    ${state.problems.length ? `<div><dt>Likely fit</dt><dd>${fit.length ? fit.map((x) => `<span class="dxn__fit"><b>${esc(x)}</b> ${esc(FIT[x])}</span>`).join("") : "To be worked out together on the call"}</dd></div>` : ""}
    ${first ? `<div><dt>First call</dt><dd>Thirty minutes on ${esc(PROBLEMS[first].focus)}${state.chips.timeline === "As soon as possible" ? ", and what has to happen first" : ""}.</dd></div>` : ""}
  </dl>`;
}

function renderNotes() {
  const html = notesHTML();
  const peek = root.querySelector("[data-peek]");
  if (peek) peek.innerHTML = html;
  if (notesHost) {
    notesHost.hidden = !state.profile;
    notesHost.innerHTML = `<div class="dxn"><p class="dxn__kicker">Notes for Michael</p><p class="dxn__sub">Builds as you answer. Only Michael reads it.</p>${html}</div>`;
  }
  page?.classList.toggle("is-dx-live", !!state.profile);
}
let notesTimer;
const notesSoon = () => { clearTimeout(notesTimer); notesTimer = setTimeout(renderNotes, 160); };

/* ------------------------------------------------------------------------ */
/* Input handling                                                            */
/* ------------------------------------------------------------------------ */
function collect() {
  const s = current();
  root.querySelectorAll("[data-text]").forEach((el) => { state.text[el.dataset.text] = el.value.trim(); });
  root.querySelectorAll("[data-about]").forEach((el) => { state.about[el.dataset.about] = el.value.trim(); });
  if (s.id === "who") {
    const next = root.querySelector('input[name="profile"]:checked')?.value || "";
    if (next !== state.profile) delete state.chips.stage; // stage options differ by profile
    state.profile = next;
  }
  if (s.id === "problems") {
    state.problems = [...root.querySelectorAll('input[name="problem"]:checked')].map((b) => b.value);
  }
  if (s.id === "problem") state.picks[s.problem] = [...root.querySelectorAll(`input[name="pick-${s.problem}"]:checked`)].map((b) => b.value);
  for (const k of ["stage", "team", "timeline", "budget"]) {
    const el = root.querySelector(`input[name="${k}"]:checked`);
    if (el) state.chips[k] = el.value;
  }
  save();
}

function validate() {
  const s = current();
  if (s.id === "who" && !state.profile) return "Choose the closest one. “Something else” is fine.";
  if (s.id === "problems" && !state.problems.length) return "Choose at least one, or “Not sure yet”.";
  if (s.id === "about") {
    if ((state.about.name || "").length < 2) return "Please add your name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(state.about.email || "")) return "Please add a valid email so Michael can reply.";
  }
  return "";
}

function go(delta) {
  state.i = Math.max(0, Math.min(state.i + delta, screens().length - 1));
  save();
  render(true);
}

// When the problem list changes, keep only what still applies.
function tidyProblems() {
  const allowed = ORDER[state.profile] || ORDER.other;
  state.problems = state.problems.filter((id) => allowed.includes(id)).slice(0, 3);
}

/* ------------------------------------------------------------------------ */
/* Payload and confirmation                                                  */
/* ------------------------------------------------------------------------ */
function payload() {
  const answers = [];
  const add = (key, section, question, answer) => { if (answer) answers.push({ key, section, question, answer }); };
  const p = profile();
  add("profile", "Who they are", "Which is closest?", p?.label);
  add("problems", "Who they are", "What would you most like to fix?", state.problems.map((id) => labelFor(id)[0]).join("; "));
  if (state.chips.stage) add("stage", "Who they are", STAGE[state.profile]?.q || "Stage", state.chips.stage);
  add("team", "Who they are", "Team size", state.chips.team);
  for (const id of state.problems) {
    const def = PROBLEMS[id];
    const pick = resolve(def.pick);
    if (pick) add(pick.key, def.practice, pick.q, (state.picks[id] || []).join(", "));
    const open = openFor(id);
    add(open.key, def.practice, open.q, state.text[open.key]);
  }
  add("timeline", "The shape of it", "Timeline", state.chips.timeline);
  add("budget", "The shape of it", "Budget set aside", state.chips.budget);
  add("tried", "The shape of it", TRIED.q, state.text.tried);
  add("good", "The shape of it", GOOD.q, state.text.good);
  const { name, email, company, role, phone, website } = state.about;
  return { name, email, company, role, phone, website, practices: practices(), answers, started_at: startedAt };
}

function memo(p) {
  const date = new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  const groups = [];
  const group = (title, items) => { const list = items.filter((x) => x.a); if (list.length) groups.push({ title, items: list }); };
  for (const id of state.problems) {
    const pick = resolve(PROBLEMS[id].pick);
    const open = openFor(id);
    group(labelFor(id)[0], [
      { q: pick?.q, a: (state.picks[id] || []).join(", ") },
      { q: open.q, a: state.text[open.key] },
    ]);
  }
  group("The shape of it", [
    { q: "Which is closest?", a: profile()?.label },
    { q: STAGE[state.profile]?.q, a: state.chips.stage }, { q: "Team size", a: state.chips.team },
    { q: "Timeline", a: state.chips.timeline }, { q: "Budget set aside", a: state.chips.budget },
    { q: TRIED.q, a: state.text.tried }, { q: GOOD.q, a: state.text.good },
  ]);
  return `<article class="memo" tabindex="-1">
    <p class="memo__kicker">Received · ${esc(date)}</p>
    <h2 class="memo__title">Thank you, <em>${esc(p.name.split(/\s+/)[0])}.</em></h2>
    <p class="memo__lede">Here are your notes as Michael will read them before you speak. He’ll reply from michael@sypher.solutions to set a time.</p>
    <div class="memo__sheet">
      <dl class="memo__meta">
        <div><dt>For</dt><dd>Michael Furth</dd></div>
        <div><dt>From</dt><dd>${esc([p.name, p.role, p.company].filter(Boolean).join(", "))}</dd></div>
        <div><dt>Regarding</dt><dd>${esc(state.problems.map((id) => labelFor(id)[0]).join("; "))}</dd></div>
      </dl>
      ${groups.map((g) => `<section class="memo__group"><h3>${esc(g.title)}</h3>${g.items.map((x) => `<p class="memo__q">${esc(x.q)}</p><p class="memo__a">${esc(x.a)}</p>`).join("")}</section>`).join("")}
    </div>
    <div class="btn-row memo__actions">
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
  if (current().id !== "about") { go(1); return; }

  const btn = root.querySelector("[data-next]");
  btn.disabled = true;
  btn.firstChild.textContent = "Sending… ";
  const p = payload();
  try {
    await store.submitInquiry(p);
    try { sessionStorage.removeItem(KEY); } catch (_) { /* ignore */ }
    root.innerHTML = memo(p);
    if (notesHost) notesHost.hidden = true;
    page?.classList.remove("is-dx-live");
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
    if (e.target.closest("[data-back]")) { collect(); go(-1); return; }
    if (e.target.closest("[data-print]")) { window.print(); return; }
    const ex = e.target.closest("[data-example]");
    if (ex) {
      const ta = root.querySelector(`[data-text="${CSS.escape(ex.dataset.for)}"]`);
      if (!ta) return;
      // End the starter as a sentence, so whatever they type next reads on naturally.
      const starter = /[.?!]$/.test(ex.dataset.example) ? `${ex.dataset.example} ` : `${ex.dataset.example}. `;
      ta.value = ta.value.trim() ? `${ta.value.trim()}\n${starter}` : starter;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const reveal = e.target.closest("[data-reveal]");
    if (reveal) {
      state.revealed[reveal.dataset.reveal] = true;
      save();
      const block = root.querySelector(".dx__open");
      block.hidden = false;
      block.classList.remove("is-hidden");
      reveal.remove();
      block.querySelector("textarea").focus();
      return;
    }
    // A tap (not a keypress) on a profile card moves straight on.
    // (The label forwards a second click to its radio; count only the first.)
    const tap = e.target.closest("[data-tap]");
    if (tap && e.detail > 0 && !e.target.matches("input")) {
      setTimeout(() => { collect(); if (state.profile) { tidyProblems(); go(1); } }, reduced() ? 0 : 260);
    }
  });

  root.addEventListener("input", (e) => {
    if (e.target.matches("[data-text], [data-about]")) { collect(); notesSoon(); updateNext(); }
  });

  root.addEventListener("change", (e) => {
    const t = e.target;
    const box = root.querySelector(".dx__error");
    if (t.name === "problem") {
      const checked = root.querySelectorAll('input[name="problem"]:checked');
      if (checked.length > 3) { t.checked = false; if (box) box.textContent = "Three is the limit. Pick the ones that matter most."; return; }
      if (box) box.textContent = "";
      const count = root.querySelector(".dx__count");
      collect();
      if (count) count.textContent = countText();
    } else if (t.name === "profile") {
      collect();
      tidyProblems();
      if (box) box.textContent = "";
    } else {
      collect();
    }
    // On a problem screen, the open question follows what was tapped.
    const s = current();
    if (s.id === "problem" && t.name === `pick-${s.problem}`) {
      const open = openFor(s.problem);
      const block = root.querySelector(".dx__open");
      if (block) {
        block.querySelector(".dx__open-q").textContent = open.q;
        block.querySelector("[data-examples]").innerHTML = examples(open.key, open.examples);
        if (block.hidden) {
          block.hidden = false;
          block.classList.remove("is-hidden");
          root.querySelector("[data-reveal]")?.remove();
        }
      }
    }
    renderNotes();
    updateNext();
  });

  // Enter moves on from taps and short fields; Cmd/Ctrl + Enter from a textarea.
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const t = e.target;
    if (t.matches("textarea")) {
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); root.querySelector("form")?.requestSubmit(); }
      return;
    }
    if (t.matches('input[type="radio"], input[type="checkbox"]')) {
      e.preventDefault();
      root.querySelector("form")?.requestSubmit();
    }
  });

  if (state.i >= screens().length) state.i = screens().length - 1;
  if (state.i > 0 && !state.profile) state.i = 0;
  if (state.i > 1 && !state.problems.length) state.i = 1;
  render();
}
