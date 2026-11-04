// The project model, on screen. One component for Michael (admin: edits everything), the client
// (owner: reads, sets the items they're asked to confirm, comments) and advisers given access
// (viewer: same as the client). The arithmetic lives in model-calc.js.
//
// Everything recalculates as it changes: a price the contractor types into the pricing sheet,
// a budget line Michael edits, an assumption the accountant confirms. Changes made by others
// arrive live; the screen never redraws a field someone is typing in.
import { store } from "./store.js";
import { esc, fmtDate, relTime, toast, confirmDialog, promptDialog, download } from "./ui.js";
import { money, parseNum } from "./sov.js";
import { calculate, SCENARIOS, monthLabel } from "./model-calc.js";

const NF1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const NF2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const pct = (x) => (x == null ? "—" : `${NF1.format(x * 100)}%`);
const times = (x) => (x == null ? "—" : `${NF2.format(x)}×`);
const CONF = [["firm", "Firm"], ["estimate", "Estimate"], ["unknown", "Unknown"]];
const STATUS = [["confirmed", "Confirmed"], ["estimate", "Estimate"], ["unknown", "Unknown"]];
const TIMING = [["closing", "At closing"], ["design", "Design and permits"], ["construction", "During construction"], ["opening", "At opening"], ["custom", "Custom months"]];
const UNIT_SUFFIX = { pct: "%", months: " mo", years: " yr", x: "×", sf: " SF" };

/** Starting lines and assumptions for a new model (construction project with an SBA-style loan). */
export const MODEL_TEMPLATE = {
  lines: [
    ["land", "Land", null, "closing"],
    ["hard", "Contractor overhead and profit", { calc: "ohp", pct: [5, 6, 8] }, "construction"],
    ["allowance", "Construction contingency", { calc: "pct_hard", pct: [4, 5, 7.5] }, "construction"],
    ["allowance", "Escalation to the bid date", { calc: "pct_hard", pct: [2, 3, 5] }, "construction"],
    ["soft", "Architect: site adaptation and construction administration", null, "design"],
    ["soft", "Civil engineering and drainage", null, "design"],
    ["soft", "Survey, geotechnical and environmental reports", null, "design"],
    ["soft", "City plan review, permits and fees", null, "design"],
    ["soft", "Utility and impact fees", null, "construction"],
    ["soft", "Legal, title and closing", null, "closing"],
    ["soft", "Insurance and property tax during construction", null, "construction"],
    ["soft", "Licenses and certificate of occupancy", null, "opening"],
    ["soft", "Pre-opening: hiring, training, inventory, marketing", null, "opening"],
    ["soft", "Working capital reserve", null, "opening"],
    ["soft", "Soft cost contingency", null, "construction"],
    ["financing", "Loan fees", { calc: "loan_fee", pct: [1.5, 2, 3] }, "closing"],
    ["financing", "Interest during construction", { calc: "interest" }, "construction"],
  ],
  inputs: [
    ["Timing", "close_month", "Closing (month)", "date", null, "unknown", "The month the land and loan close."],
    ["Timing", "design_months", "Design and permits", "months", 2, "estimate", "From closing to the start of construction."],
    ["Timing", "build_months", "Construction", "months", 10, "estimate", "From the start of construction to opening."],
    ["Financing", "loan_ltc", "Loan to cost", "pct", null, "unknown", "The share of total cost the lender will fund."],
    ["Financing", "loan_amount", "Loan amount (if fixed)", "usd", null, "unknown", "Leave blank to size the loan from loan to cost."],
    ["Financing", "loan_rate", "Interest rate", "pct", null, "unknown", "Annual rate during construction and after."],
    ["Financing", "loan_term_years", "Amortization", "years", 25, "estimate", null],
    ["Financing", "io_months", "Interest-only months after opening", "months", 0, "estimate", null],
    ["Financing", "equity_available", "Equity available", "usd", null, "unknown", "Cash (and land equity) the owner can put in, verified."],
    ["Financing", "dscr_target", "Lender's minimum coverage", "x", 1.25, "estimate", null],
    ["Operations", "revenue_full", "Annual revenue at full run rate", "usd", null, "unknown", null],
    ["Operations", "ramp_months", "Months to reach full revenue", "months", 6, "estimate", null],
    ["Operations", "ebitda_margin", "EBITDA margin", "pct", null, "unknown", "Before rent (owner-occupied), interest, taxes and depreciation."],
    ["Existing businesses", "existing_cash_flow", "Normalized cash flow available for debt", "usd", null, "unknown", "Recurring, substantiated, before existing debt service."],
    ["Existing businesses", "existing_debt_service", "Existing annual debt service", "usd", null, "unknown", null],
    ["Existing businesses", "owner_draws", "Required owner draws", "usd", null, "unknown", "What the owners must take out each year to live."],
  ],
};

export async function createFromTemplate({ engagementId, title, sheetId, buildingSf }) {
  const m = await store.pmCreateModel({ engagement_id: engagementId, title, sov_sheet_id: sheetId || null, building_sf: buildingSf || null });
  await store.pmAddLines(MODEL_TEMPLATE.lines.filter(([g, , o]) => sheetId || o?.calc !== "ohp").map(([grp, label, o, timing], i) => ({
    model_id: m.id, engagement_id: engagementId, grp, label, position: i + 1, timing,
    calc: o?.calc || null, pct_low: o?.pct?.[0] ?? null, pct_base: o?.pct?.[1] ?? null, pct_high: o?.pct?.[2] ?? null,
    confidence: o?.calc ? "estimate" : "unknown",
  })));
  await store.pmAddInputs(MODEL_TEMPLATE.inputs.map(([section, key, label, unit, value, status, hint], i) => ({
    model_id: m.id, engagement_id: engagementId, section, key, label, unit, value, status, hint, position: i + 1,
  })));
  return m;
}

/**
 * Mount a model. role: "admin" | "owner" | "viewer". people: [{ id, name }] who can confirm
 * items (the client and advisers with access). Returns { destroy() }.
 */
export async function mountModel(el, { modelId, role, me, nameOf = () => "Someone", people = [], pricingHref = "#pricing" }) {
  const admin = role === "admin";
  let model, lines, inputs, comments, log, snapshots, sov = null, scenario = "forecast", result, live = false, destroyed = false;
  let deferred = false, thread = null;
  const timers = new Map();

  async function load() {
    model = await store.pmModel(modelId);
    [lines, inputs, comments, log, snapshots] = await Promise.all([
      store.pmLines(modelId), store.pmInputs(modelId), store.pmComments(modelId).catch(() => []),
      store.pmInputLog(model.engagement_id).catch(() => []), store.pmSnapshots(modelId).catch(() => []),
    ]);
    sov = null;
    if (model.sov_sheet_id) {
      const [sheet, sl, budget] = await Promise.all([store.sovSheet(model.sov_sheet_id).catch(() => null), store.sovLines(model.sov_sheet_id).catch(() => []), store.sovBudget(model.engagement_id).catch(() => [])]);
      if (sheet) sov = { sheet, lines: sl, budget: new Map(budget.map((b) => [b.line_id, b])) };
    }
  }
  const compute = () => { result = calculate({ model, lines, inputs, sov, scenario }); };
  const canSet = (i) => admin || i.owner_id === me;
  const countFor = (kind, id) => comments.filter((c) => c.target_kind === kind && (c.target_id || null) === (id || null)).length;

  /* -------------------------------------------------------------- pieces */
  function kpis() {
    const r = result, y2 = r.years[1];
    const target = r.dscrTarget;
    const fig = (label, value, sub = "", cls = "") => `<div class="pm-kpi ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    return `<div class="pm-kpis" data-part="kpis">
      ${fig("Total project cost", money(r.total), r.perSf ? `$${NF1.format(r.perSf)} per SF` : "", "pm-kpi--lead")}
      ${fig("Before land", money(r.devCost))}
      ${fig("Loan", money(r.loan), r.ltc != null ? `${pct(r.ltc)} of cost` : "")}
      ${fig("Equity needed", money(r.equity), r.gap != null ? (r.gap > 0 ? `<span class="is-over">${money(r.gap)} short</span>` : `<span class="is-under">${money(-r.gap)} to spare</span>`) : "available: not confirmed")}
      ${fig("Monthly debt service", money(r.payment), `from ${esc(monthLabel(r.close, r.opening + 1))}`)}
      ${fig("Coverage, year 2", times(y2.dscr), y2.globalDscr != null ? `global ${times(y2.globalDscr)}` : r.opsReady ? "global: needs existing figures" : "needs operating figures", y2.dscr != null ? (y2.dscr >= target ? "is-good" : "is-bad") : "")}
    </div>`;
  }

  function openItems() {
    const unknown = inputs.filter((i) => i.status !== "confirmed");
    const lineGaps = lines.filter((l) => !l.calc && l.confidence === "unknown");
    if (!unknown.length && !lineGaps.length) return `<p class="pm-open__done" data-part="open">Every assumption is confirmed.</p>`;
    const chip = (i) => `<li><button type="button" class="pm-chip pm-chip--${esc(i.status)}" data-goto="input-${esc(i.id)}"><b>${esc(i.label)}</b><span>${esc(STATUS.find(([k]) => k === i.status)?.[1])}${i.owner_id ? ` · ${esc(i.owner_id === me ? "you" : nameOf(i.owner_id))}` : ""}</span></button></li>`;
    const mine = unknown.filter((i) => i.owner_id === me);
    return `<div class="pm-open" data-part="open">
      ${mine.length ? `<p class="pm-open__mine"><b>${mine.length} for you to confirm.</b> Set the value and status; it updates the whole model, and Michael is told.</p>` : ""}
      <ul class="pm-chips">${unknown.map(chip).join("")}</ul>
      ${lineGaps.length ? `<p class="p-muted">Costs not yet known: ${lineGaps.map((l) => esc(l.label)).join(", ")}.</p>` : ""}
    </div>`;
  }

  const cell = (line, field, value, opts = {}) => {
    if (!admin || opts.ro) return `<span class="pm-num">${opts.pct ? (value == null ? "" : `${NF2.format(value)}%`) : value == null ? "" : money(Number(value))}</span>`;
    return `<input class="pm-in pm-in--num" data-line="${esc(line.id)}" data-field="${field}" value="${value == null ? "" : esc(NF2.format(Number(value)))}" inputmode="decimal" aria-label="${esc(`${field} for ${line.label}`)}"${opts.pct ? ' data-pct="1"' : ""}>`;
  };
  const talk = (kind, id, label) => {
    const n = countFor(kind, id);
    return `<button type="button" class="pm-talk${n ? " has" : ""}" data-talk="${kind}" data-target="${esc(id || "")}" data-label="${esc(label)}" aria-label="Comments on ${esc(label)}${n ? `, ${n}` : ""}">${n || ""}<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 3h12v8H6l-3 3v-3H2z"/></svg></button>`;
  };

  function lineRow(item) {
    const scen = scenario;
    if (item.kind === "sov") {
      return `<tr class="pm-row pm-row--sov"><td><a href="${esc(pricingHref)}" class="pm-sovlink">${esc(item.label)}</a><span class="pm-sub">Pricing sheet: ${item.priced} of ${item.count} lines priced; the rest at budget</span></td>
        <td class="pm-c-num" colspan="5"><span class="pm-sub">${esc(sov?.sheet?.status === "accepted" ? "Accepted pricing" : "Prices replace budgets as the contractor enters them")}</span></td>
        <td class="pm-c-num pm-c-fc" data-fc="sov">${money(item.value)}</td><td></td><td></td><td>${talk("model", null, "Hard costs")}</td></tr>`;
    }
    const l = item.line;
    const isPct = !!l.calc && l.calc !== "interest";
    const confSel = admin ? `<select class="pm-in pm-in--sel" data-line="${esc(l.id)}" data-field="confidence" aria-label="Confidence for ${esc(l.label)}">${CONF.map(([k, t]) => `<option value="${k}"${l.confidence === k ? " selected" : ""}>${t}</option>`).join("")}</select>` : `<span class="pm-conf pm-conf--${esc(l.confidence)}">${esc(CONF.find(([k]) => k === l.confidence)?.[1])}</span>`;
    const timeSel = admin ? `<select class="pm-in pm-in--sel" data-line="${esc(l.id)}" data-field="timing" aria-label="Timing for ${esc(l.label)}">${TIMING.map(([k, t]) => `<option value="${k}"${l.timing === k ? " selected" : ""}>${t}</option>`).join("")}</select>${l.timing === "custom" ? `<span class="pm-custom">from month <input class="pm-in pm-in--tiny" data-line="${esc(l.id)}" data-field="timing_start" value="${esc(l.timing_start ?? "")}" inputmode="numeric" aria-label="Start month"> for <input class="pm-in pm-in--tiny" data-line="${esc(l.id)}" data-field="timing_months" value="${esc(l.timing_months ?? "")}" inputmode="numeric" aria-label="Months"></span>` : ""}` : `<span class="pm-sub">${esc(TIMING.find(([k]) => k === l.timing)?.[1])}</span>`;
    const label = admin ? `<input class="pm-in pm-in--label" data-line="${esc(l.id)}" data-field="label" value="${esc(l.label)}" aria-label="Line">` : `<span>${esc(l.label)}</span>`;
    const calcNote = l.calc === "interest" ? "Worked out from the monthly draws" : l.calc === "loan_fee" ? "Percent of the loan" : l.calc === "pct_hard" ? "Percent of hard cost" : l.calc === "ohp" ? (sov?.sheet?.ohp_pct != null && result.sovPriced ? `Contractor's ${NF2.format(sov.sheet.ohp_pct)}% in the forecast` : "Percent of the pricing sheet") : "";
    return `<tr class="pm-row is-${esc(l.confidence)}" data-row="${esc(l.id)}">
      <td>${label}${calcNote ? `<span class="pm-sub">${esc(calcNote)}</span>` : ""}${l.note ? `<span class="pm-sub">${esc(l.note)}</span>` : ""}</td>
      ${l.calc === "interest" ? `<td class="pm-c-num" colspan="3"></td>` : isPct
        ? `<td class="pm-c-num${scen === "low" ? " is-scen" : ""}">${cell(l, "pct_low", l.pct_low, { pct: true })}</td><td class="pm-c-num${scen === "base" ? " is-scen" : ""}">${cell(l, "pct_base", l.pct_base, { pct: true })}</td><td class="pm-c-num${scen === "high" ? " is-scen" : ""}">${cell(l, "pct_high", l.pct_high, { pct: true })}</td>`
        : `<td class="pm-c-num${scen === "low" ? " is-scen" : ""}">${cell(l, "low", l.low)}</td><td class="pm-c-num${scen === "base" ? " is-scen" : ""}">${cell(l, "base", l.base)}</td><td class="pm-c-num${scen === "high" ? " is-scen" : ""}">${cell(l, "high", l.high)}</td>`}
      <td class="pm-c-num">${l.calc ? "" : cell(l, "committed", l.committed)}</td>
      <td class="pm-c-num">${l.calc ? "" : cell(l, "paid", l.paid)}</td>
      <td class="pm-c-num pm-c-fc${scen === "forecast" ? " is-scen" : ""}" data-fc="${esc(l.id)}">${money(item.value)}</td>
      <td>${confSel}</td><td class="pm-c-time">${timeSel}</td>
      <td class="pm-c-act">${talk("line", l.id, l.label)}${admin ? `<button type="button" class="sov-icon sov-icon--del" data-del-line="${esc(l.id)}" aria-label="Remove ${esc(l.label)}">×</button>` : ""}</td>
    </tr>`;
  }

  function budgetTable() {
    return `<div class="pm-wrap"><table class="pm-table">
      <thead><tr><th scope="col">Cost</th><th class="pm-c-num" scope="col">Low</th><th class="pm-c-num" scope="col">Base</th><th class="pm-c-num" scope="col">High</th>
        <th class="pm-c-num" scope="col">Committed</th><th class="pm-c-num" scope="col">Paid</th><th class="pm-c-num" scope="col">${esc(SCENARIOS.find(([k]) => k === scenario)[1])}</th>
        <th scope="col">Confidence</th><th scope="col">When</th><th scope="col"><span class="visually-hidden">Comments</span></th></tr></thead>
      ${result.groups.map((g) => `<tbody data-group="${g.key}">
        <tr class="pm-grp"><th scope="colgroup" colspan="6">${esc(g.label)}</th><td class="pm-c-num" data-gt="${g.key}">${money(g.total)}</td><td colspan="3"></td></tr>
        ${g.items.map(lineRow).join("")}
        ${admin ? `<tr class="pm-add"><td colspan="10"><button type="button" class="p-linkbtn" data-add-line="${g.key}">+ Add a ${esc(g.label.toLowerCase().replace(/s$/, ""))} line</button></td></tr>` : ""}
      </tbody>`).join("")}
      <tbody><tr class="pm-total"><th scope="row" colspan="6">Total project cost</th><td class="pm-c-num" data-gt="total">${money(result.total)}</td><td colspan="3"></td></tr></tbody>
    </table></div>`;
  }

  function inputValue(i) {
    if (i.unit === "date") return i.text_value || "";
    return i.value == null ? "" : i.unit === "usd" ? NF2.format(Number(i.value)) : NF2.format(Number(i.value));
  }
  function assumptions() {
    const sections = [...new Set(inputs.map((i) => i.section))];
    const lastBy = new Map();
    for (const e of log) if (!lastBy.has(e.input_id)) lastBy.set(e.input_id, e);
    return sections.map((sec) => `<div class="pm-sec"><h4 class="room-sub">${esc(sec)}</h4><ul class="pm-inputs">${inputs.filter((i) => i.section === sec).map((i) => {
      const e = lastBy.get(i.id);
      const can = canSet(i);
      const valueField = can
        ? `<span class="pm-val"><input class="pm-in pm-in--val" id="input-${esc(i.id)}" data-input="${esc(i.id)}" data-field="value" value="${esc(inputValue(i))}" ${i.unit === "date" ? 'placeholder="YYYY-MM"' : 'inputmode="decimal"'} aria-label="${esc(i.label)}">${UNIT_SUFFIX[i.unit] ? `<em>${UNIT_SUFFIX[i.unit].trim()}</em>` : ""}</span>`
        : `<span class="pm-val pm-val--ro" id="input-${esc(i.id)}" tabindex="-1">${i.unit === "date" ? esc(i.text_value ? monthLabel(i.text_value, 0) : "—") : i.value == null ? "—" : i.unit === "usd" ? money(Number(i.value)) : `${NF2.format(Number(i.value))}${UNIT_SUFFIX[i.unit] || ""}`}</span>`;
      const status = can
        ? `<select class="pm-in pm-in--sel pm-st pm-st--${esc(i.status)}" data-input="${esc(i.id)}" data-field="status" aria-label="Status of ${esc(i.label)}">${STATUS.map(([k, t]) => `<option value="${k}"${i.status === k ? " selected" : ""}>${t}</option>`).join("")}</select>`
        : `<span class="pm-st pm-st--${esc(i.status)}">${esc(STATUS.find(([k]) => k === i.status)?.[1])}</span>`;
      const owner = admin
        ? `<select class="pm-in pm-in--sel" data-input="${esc(i.id)}" data-field="owner_id" aria-label="Who confirms ${esc(i.label)}"><option value="">Michael</option>${people.map((p) => `<option value="${esc(p.id)}"${i.owner_id === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`
        : `<span class="pm-sub">${i.owner_id ? `Confirms: ${esc(i.owner_id === me ? "you" : nameOf(i.owner_id))}` : "Confirms: Michael"}</span>`;
      return `<li class="pm-input${i.owner_id === me && i.status !== "confirmed" ? " is-mine" : ""}" data-input-row="${esc(i.id)}">
        <div class="pm-input__label"><label for="input-${esc(i.id)}">${esc(i.label)}</label>${i.hint ? `<span class="pm-sub">${esc(i.hint)}</span>` : ""}
          ${e ? `<span class="pm-sub pm-sub--log">${esc(nameOf(e.changed_by))} · ${esc(relTime(e.changed_at))}${e.note ? `: “${esc(e.note)}”` : ""}</span>` : ""}</div>
        ${valueField}${status}
        <div class="pm-input__who">${owner}${admin && i.owner_id && i.status !== "confirmed" ? `<button type="button" class="p-linkbtn" data-ask="${esc(i.id)}">Ask</button>` : ""}</div>
        ${talk("input", i.id, i.label)}
      </li>`;
    }).join("")}</ul></div>`).join("");
  }

  function sources() {
    const r = result;
    const uses = r.groups.filter((g) => g.total).map((g) => [g.label, g.total]);
    const src = [["Loan", r.loan], ["Equity", r.equity]];
    const row = ([l, v]) => `<tr><td>${esc(l)}</td><td class="pm-c-num">${money(v)}</td><td class="pm-c-num">${r.total ? pct(v / r.total) : ""}</td></tr>`;
    return `<div class="pm-su" data-part="su">
      <table class="pm-mini"><caption>Uses</caption><tbody>${uses.map(row).join("")}<tr class="pm-total"><td>Total</td><td class="pm-c-num">${money(r.total)}</td><td></td></tr></tbody></table>
      <table class="pm-mini"><caption>Sources</caption><tbody>${src.map(row).join("")}<tr class="pm-total"><td>Total</td><td class="pm-c-num">${money(r.total)}</td><td></td></tr></tbody></table>
      <div class="pm-su__note">${r.equityAvailable != null ? `<p>Equity available <b>${money(r.equityAvailable)}</b>; ${r.gap > 0 ? `<span class="is-over">short by ${money(r.gap)}</span>` : `<span class="is-under">${money(-r.gap)} to spare</span>`}.</p>` : `<p>Equity available isn't confirmed yet, so the funding gap can't be shown.</p>`}
        <p class="p-muted">Equity is spent first; the loan funds the rest month by month, and its interest during construction is part of the cost.</p></div>
    </div>`;
  }

  function chart() {
    const s = result.schedule;
    if (!s.length) return "";
    const W = 640, H = 170, pad = 28, bw = (W - pad * 2) / s.length;
    const maxUse = Math.max(...s.map((x) => x.equity + x.loan), 1);
    const maxBal = Math.max(...s.map((x) => x.balance), 1);
    const y = (v, m) => H - pad - (v / m) * (H - pad * 2);
    const bars = s.map((x, i) => {
      const xe = pad + i * bw + bw * 0.15, w = bw * 0.7;
      const he = (x.equity / maxUse) * (H - pad * 2), hl = (x.loan / maxUse) * (H - pad * 2);
      return `<rect x="${xe.toFixed(1)}" y="${(H - pad - he).toFixed(1)}" width="${w.toFixed(1)}" height="${he.toFixed(1)}" class="pm-bar-eq"><title>${esc(monthLabel(result.close, x.m))}: equity ${money(x.equity)}</title></rect>
        <rect x="${xe.toFixed(1)}" y="${(H - pad - he - hl).toFixed(1)}" width="${w.toFixed(1)}" height="${hl.toFixed(1)}" class="pm-bar-loan"><title>${esc(monthLabel(result.close, x.m))}: loan draw ${money(x.loan)}</title></rect>`;
    }).join("");
    const line = s.map((x, i) => `${i ? "L" : "M"}${(pad + i * bw + bw / 2).toFixed(1)},${y(x.balance, maxBal).toFixed(1)}`).join(" ");
    return `<figure class="pm-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly spending by equity and loan, and the loan balance">
      <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="pm-axis"/>${bars}<path d="${line}" class="pm-bal"/>
      <text x="${pad}" y="${H - 8}" class="pm-tick">${esc(monthLabel(result.close, 0))}</text><text x="${W - pad}" y="${H - 8}" text-anchor="end" class="pm-tick">${esc(monthLabel(result.close, s.length - 1))}</text></svg>
      <figcaption><span class="pm-key pm-key--eq"></span>Equity <span class="pm-key pm-key--loan"></span>Loan draws <span class="pm-key pm-key--bal"></span>Loan balance (peak ${money(maxBal)})</figcaption></figure>`;
  }

  function cashflow() {
    const r = result;
    const t = r.dscrTarget;
    return `<div data-part="cf">
      ${chart()}
      <details class="pm-months"><summary class="p-linkbtn">Month by month to opening (${r.schedule.length} months)</summary>
        <div class="pm-wrap"><table class="pm-table pm-table--months"><thead><tr><th scope="col">Month</th><th class="pm-c-num" scope="col">Spending</th><th class="pm-c-num" scope="col">Interest</th><th class="pm-c-num" scope="col">From equity</th><th class="pm-c-num" scope="col">Loan draw</th><th class="pm-c-num" scope="col">Loan balance</th></tr></thead>
        <tbody>${r.schedule.map((x) => `<tr><td>${esc(monthLabel(r.close, x.m))}${x.m === 0 ? " <span class=\"pm-sub\">closing</span>" : x.m === r.design ? " <span class=\"pm-sub\">construction starts</span>" : ""}</td><td class="pm-c-num">${money(x.uses)}</td><td class="pm-c-num">${money(x.interest)}</td><td class="pm-c-num">${money(x.equity)}</td><td class="pm-c-num">${money(x.loan)}</td><td class="pm-c-num">${money(x.balance)}</td></tr>`).join("")}</tbody></table></div>
      </details>
      <h4 class="room-sub">After opening (${esc(monthLabel(r.close, r.opening))})</h4>
      ${r.opsReady ? "" : `<p class="p-muted">Coverage needs the operating figures: full-run revenue and EBITDA margin.</p>`}
      <div class="pm-wrap"><table class="pm-table pm-table--years"><thead><tr><th scope="col"></th>${r.years.map((y) => `<th class="pm-c-num" scope="col">Year ${y.year}</th>`).join("")}</tr></thead><tbody>
        <tr><th scope="row">Revenue</th>${r.years.map((y) => `<td class="pm-c-num">${y.revenue == null ? "—" : money(y.revenue)}</td>`).join("")}</tr>
        <tr><th scope="row">EBITDA</th>${r.years.map((y) => `<td class="pm-c-num">${y.ebitda == null ? "—" : money(y.ebitda)}</td>`).join("")}</tr>
        <tr><th scope="row">Debt service</th>${r.years.map((y) => `<td class="pm-c-num">${money(y.ds)}</td>`).join("")}</tr>
        <tr><th scope="row">Cash after debt service</th>${r.years.map((y) => `<td class="pm-c-num">${y.ebitda == null ? "—" : money(y.ebitda - y.ds)}</td>`).join("")}</tr>
        <tr class="pm-total"><th scope="row">Coverage (project)</th>${r.years.map((y) => `<td class="pm-c-num ${y.dscr == null ? "" : y.dscr >= t ? "is-under" : "is-over"}">${times(y.dscr)}</td>`).join("")}</tr>
        <tr><th scope="row">Coverage (global, with existing businesses)</th>${r.years.map((y) => `<td class="pm-c-num ${y.globalDscr == null ? "" : y.globalDscr >= t ? "is-under" : "is-over"}">${times(y.globalDscr)}</td>`).join("")}</tr>
      </tbody></table></div>
      <p class="p-muted pm-note">Lender's minimum ${times(t)}. Global coverage adds the existing businesses' normalized cash flow, less required owner draws, against all debt service.</p>
    </div>`;
  }

  function commentsPanel() {
    if (!thread) return "";
    const list = comments.filter((c) => c.target_kind === thread.kind && (c.target_id || null) === (thread.id || null));
    return `<aside class="pm-thread" role="dialog" aria-label="Comments on ${esc(thread.label)}">
      <div class="pm-thread__head"><h3>${esc(thread.label)}</h3><button type="button" class="p-drawer__close" data-close-thread aria-label="Close comments">×</button></div>
      <ol class="pm-thread__list">${list.length ? list.map((c) => `<li><p class="pm-thread__who"><b>${esc(c.author_id === me ? "You" : nameOf(c.author_id))}</b> · ${esc(relTime(c.created_at))}${c.author_id === me ? ` <button type="button" class="p-linkbtn" data-del-comment="${esc(c.id)}">Delete</button>` : ""}</p><p>${esc(c.body)}</p></li>`).join("") : `<li class="p-muted">No comments yet. Questions, sources and caveats go here, beside the number they're about.</li>`}</ol>
      <form class="pm-thread__form" data-comment-form><label class="visually-hidden" for="pm-comment">Comment</label><textarea class="p-textarea" id="pm-comment" rows="3" maxlength="4000" required placeholder="Add a comment for Michael${role === "admin" ? ", the client" : ""} and the team…"></textarea><button class="btn btn--navy btn--sm" type="submit">Comment</button></form>
    </aside>`;
  }

  function render() {
    compute();
    const recent = comments.slice(-4).reverse();
    el.innerHTML = `<div class="pm">
      <header class="pm-head">
        <div class="sov-print-brand" aria-hidden="true"><img src="../assets/img/sypher-mark-sm.webp" alt="" width="46" height="48"><span>SYPHER <small>Solutions</small></span></div>
        <div class="pm-head__row"><div><p class="p-kicker">Project model</p><h2 class="sov-title">${esc(model.title)}</h2>
          <p class="p-muted">Total cost, financing and cash flow, linked to the pricing sheet. Updated ${esc(relTime(model.updated_at))}.</p></div>
          <div class="pm-head__side"><div class="pm-scen" role="radiogroup" aria-label="Scenario">${SCENARIOS.map(([k, t]) => `<button type="button" role="radio" aria-checked="${scenario === k}" data-scen="${k}">${t}</button>`).join("")}</div>
            <span class="sov-live${live ? " is-on" : ""}" data-live>${live ? "Live" : "Connecting…"}</span></div></div>
        ${kpis()}
      </header>
      <section class="pm-part"><div class="p-row"><h3 class="pm-h">Still open</h3><span class="p-muted">${inputs.filter((i) => i.status === "confirmed").length} of ${inputs.length} assumptions confirmed</span></div>${openItems()}</section>
      <section class="pm-part"><div class="p-row"><h3 class="pm-h">Project budget</h3><span class="p-muted">${scenario === "forecast" ? "Forecast: paid, else committed, else the contractor's price, else budget" : `${esc(SCENARIOS.find(([k]) => k === scenario)[1])} case`}</span></div><div data-part="budget">${budgetTable()}</div></section>
      <section class="pm-part"><h3 class="pm-h">Sources and uses</h3>${sources()}</section>
      <section class="pm-part"><h3 class="pm-h">Assumptions</h3><p class="p-muted pm-note">Each has a status and the person who should confirm it. ${admin ? "Assign someone and press Ask: they get a request and set the value here." : "You can set the ones assigned to you; every change is logged."}</p><div data-part="inputs">${assumptions()}</div></section>
      <section class="pm-part"><h3 class="pm-h">Cash flow and coverage</h3>${cashflow()}</section>
      <section class="pm-part pm-foot">
        <div><h3 class="pm-h">Discussion</h3>${recent.length ? `<ul class="pm-recent">${recent.map((c) => `<li><b>${esc(c.author_id === me ? "You" : nameOf(c.author_id))}</b>${c.target_label ? ` on <button type="button" class="p-linkbtn pm-recent__on" data-talk="${esc(c.target_kind)}" data-target="${esc(c.target_id || "")}" data-label="${esc(c.target_label)}">${esc(c.target_label)}</button>` : ""}: ${esc(c.body.length > 140 ? `${c.body.slice(0, 140)}…` : c.body)} <span class="p-muted">${esc(relTime(c.created_at))}</span></li>`).join("")}</ul>` : `<p class="p-muted">Comment on any cost or assumption with the speech-bubble button.</p>`}
          ${talk("model", null, "The model")}</div>
        <div><h3 class="pm-h">Versions</h3>${snapshots.length ? `<ul class="pm-recent">${snapshots.slice(0, 6).map((s) => `<li><b>${esc(s.label)}</b> · ${esc(fmtDate(s.created_at, { month: "short", day: "numeric", year: "numeric" }))} <button type="button" class="p-linkbtn" data-snap-csv="${esc(s.id)}">CSV</button></li>`).join("")}</ul>` : `<p class="p-muted">Save a dated copy before sending figures to the lender.</p>`}
          <div class="btn-row">${role !== "viewer" ? `<button type="button" class="btn btn--ghost btn--sm" data-snapshot>Save a version</button>` : ""}<button type="button" class="p-linkbtn" data-csv>Download CSV</button><button type="button" class="p-linkbtn" data-print>Print / PDF</button></div></div>
      </section>
      ${commentsPanel()}
    </div>`;
  }

  /** Repaint the figures that follow from the inputs, leaving the fields alone. */
  function paintDerived() {
    compute();
    const swap = (part, html) => { const n = el.querySelector(`[data-part="${part}"]`); if (n) n.outerHTML = html; };
    swap("kpis", kpis()); swap("su", sources()); swap("cf", cashflow());
    if (!el.querySelector('[data-part="open"]')?.contains(document.activeElement)) swap("open", openItems());
    for (const g of result.groups) {
      const n = el.querySelector(`[data-gt="${g.key}"]`); if (n) n.textContent = money(g.total);
      for (const i of g.items) { const c = el.querySelector(`[data-fc="${i.kind === "sov" ? "sov" : i.line.id}"]`); if (c) c.textContent = money(i.value); }
    }
    const t = el.querySelector('[data-gt="total"]'); if (t) t.textContent = money(result.total);
  }
  function repaint() {
    if (el.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) { deferred = true; return; }
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  /* ------------------------------------------------------------- editing */
  function queue(key, fn) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(async () => {
      timers.delete(key);
      try { await fn(); } catch (err) { toast(`Couldn’t save: ${err.message}`, true); }
    }, 500));
  }
  function onLineInput(t) {
    const l = lines.find((x) => x.id === t.dataset.line);
    if (!l) return;
    const f = t.dataset.field;
    let value = t.value;
    if (["low", "base", "high", "committed", "paid", "pct_low", "pct_base", "pct_high", "timing_start", "timing_months"].includes(f)) {
      value = parseNum(value);
      t.classList.toggle("is-invalid", Number.isNaN(value));
      if (Number.isNaN(value)) return;
      if (f.startsWith("timing_") && value != null) value = Math.round(value);
    } else if (f === "label") { value = value.trim(); if (!value) return; }
    l[f] = value;
    paintDerived();
    queue(`line:${l.id}`, () => store.pmSaveLine(l.id, { [f]: value, updated_by: me, updated_at: new Date().toISOString() }));
    if (f === "timing") repaint();
  }
  function onInputInput(t) {
    const i = inputs.find((x) => x.id === t.dataset.input);
    if (!i) return;
    const f = t.dataset.field;
    if (f === "owner_id") {
      i.owner_id = t.value || null;
      store.pmUpdateInput(i.id, { owner_id: i.owner_id }).then(() => {
        const y = window.scrollY;
        render();   // the choice is made; show the Ask button now
        window.scrollTo(0, y);
        el.querySelector(`select[data-input="${CSS.escape(i.id)}"][data-field="owner_id"]`)?.focus({ preventScroll: true });
      }).catch((err) => toast(err.message, true));
      return;
    }
    if (f === "value") {
      if (i.unit === "date") {
        const ok = !t.value.trim() || /^\d{4}-(0[1-9]|1[0-2])$/.test(t.value.trim());
        t.classList.toggle("is-invalid", !ok);
        if (!ok) return;
        i.text_value = t.value.trim() || null;
      } else {
        const v = parseNum(t.value);
        t.classList.toggle("is-invalid", Number.isNaN(v));
        if (Number.isNaN(v)) return;
        i.value = v;
      }
      // Typing a figure for an unknown item makes it an estimate until someone confirms it.
      if (i.status === "unknown" && (i.value != null || i.text_value)) {
        i.status = "estimate";
        const sel = el.querySelector(`select[data-input="${CSS.escape(i.id)}"][data-field="status"]`);
        if (sel) sel.value = "estimate";
      }
    } else if (f === "status") i.status = t.value;
    paintDerived();
    queue(`input:${i.id}`, async () => {
      const row = await store.pmSetInput(i.id, i.unit === "date" ? null : i.value, i.unit === "date" ? i.text_value : null, i.status, null);
      Object.assign(i, row);
    });
  }

  const on = (type, fn) => el.addEventListener(type, fn);
  on("input", (e) => { if (e.target.matches("[data-line]")) onLineInput(e.target); else if (e.target.matches("[data-input]") && e.target.tagName === "INPUT") onInputInput(e.target); });
  on("change", (e) => {
    if (e.target.matches("select[data-line]")) onLineInput(e.target);
    else if (e.target.matches("select[data-input]")) { onInputInput(e.target); if (e.target.dataset.field === "status") e.target.className = `pm-in pm-in--sel pm-st pm-st--${e.target.value}`; }
  });
  on("focusout", (e) => {
    const t = e.target;
    if (t.matches("input[data-line]") && !t.classList.contains("is-invalid") && t.dataset.field !== "label" && !t.dataset.field.startsWith("timing_")) {
      const l = lines.find((x) => x.id === t.dataset.line); const v = l?.[t.dataset.field];
      t.value = v == null ? "" : NF2.format(Number(v));
    }
    setTimeout(() => { if (deferred && !(el.contains(document.activeElement) && document.activeElement.matches("input, textarea, select"))) { deferred = false; repaint(); } }, 50);
  });
  on("keydown", (e) => { if (e.key === "Enter" && e.target.matches(".pm-in") && e.target.tagName === "INPUT") { e.preventDefault(); e.target.blur(); } });
  on("submit", async (e) => {
    if (!e.target.matches("[data-comment-form]")) return;
    e.preventDefault();
    const box = e.target.querySelector("textarea");
    const body = box.value.trim();
    if (!body) return;
    try {
      const row = await store.pmAddComment({ model_id: modelId, engagement_id: model.engagement_id, target_kind: thread.kind, target_id: thread.id || null, target_label: thread.label, author_id: me, body });
      if (!comments.some((c) => c.id === row.id)) comments.push(row);
      render();
      el.querySelector("#pm-comment")?.focus();
    } catch (err) { toast(err.message, true); }
  });
  on("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.scen) { scenario = b.dataset.scen; render(); return; }
      if (b.dataset.talk) { thread = { kind: b.dataset.talk, id: b.dataset.target || null, label: b.dataset.label }; render(); el.querySelector("#pm-comment")?.focus(); return; }
      if (b.hasAttribute("data-close-thread")) { thread = null; render(); return; }
      if (b.dataset.delComment) { await store.pmDeleteComment(b.dataset.delComment); comments = comments.filter((c) => c.id !== b.dataset.delComment); render(); return; }
      if (b.dataset.goto) { const n = document.getElementById(b.dataset.goto); n?.scrollIntoView({ block: "center" }); n?.focus(); n?.closest("li")?.classList.add("is-flash"); return; }
      if (b.dataset.addLine) {
        const label = await promptDialog({ title: "Add a cost line", label: "What it is", confirmLabel: "Add", required: true, multiline: false });
        if (!label) return;
        const [row] = await store.pmAddLines([{ model_id: modelId, engagement_id: model.engagement_id, grp: b.dataset.addLine, label, position: lines.length + 1, timing: b.dataset.addLine === "land" ? "closing" : "construction", confidence: "unknown" }]);
        lines.push(row); render();
        return;
      }
      if (b.dataset.delLine) {
        const l = lines.find((x) => x.id === b.dataset.delLine);
        if (!await confirmDialog({ title: "Remove this line?", body: `<p><strong>${esc(l.label)}</strong> and its comments are removed from the model.</p>`, confirmLabel: "Remove" })) return;
        await store.pmDeleteLine(l.id); lines = lines.filter((x) => x.id !== l.id); render();
        return;
      }
      if (b.dataset.ask) {
        const i = inputs.find((x) => x.id === b.dataset.ask);
        if (!await confirmDialog({ title: `Ask ${nameOf(i.owner_id)} to confirm?`, body: `<p><strong>${esc(i.label)}</strong>. They get a request and an email, and set the value in the model.</p>`, confirmLabel: "Ask" })) return;
        const req = await store.pmAskInput(i.id, i.owner_id, null);
        store.notify("action_item", req);
        toast(`Asked. ${nameOf(i.owner_id)} has been emailed.`);
        return;
      }
      if (b.hasAttribute("data-snapshot")) {
        const label = await promptDialog({ title: "Save a version", label: "Name", value: `${fmtDate(new Date().toISOString(), { month: "short", day: "numeric" })}: lender package`, confirmLabel: "Save", required: true, multiline: false });
        if (!label) return;
        const data = { scenario, result: { ...result, schedule: result.schedule, groups: result.groups.map((g) => ({ ...g, items: g.items.map((i) => ({ label: i.label, value: i.value })) })) }, inputs, lines };
        snapshots.unshift(await store.pmSaveSnapshot({ model_id: modelId, engagement_id: model.engagement_id, label, data, created_by: me }));
        render(); toast("Version saved.");
        return;
      }
      if (b.hasAttribute("data-csv")) { download(`${slug(model.title)}-project-model.csv`, toCsv(result, inputs, model.title), "text/csv"); return; }
      if (b.dataset.snapCsv) { const s = await store.pmSnapshot(b.dataset.snapCsv); download(`${slug(s.label)}.csv`, toCsv(s.data.result, s.data.inputs, `${model.title}: ${s.label}`), "text/csv"); return; }
      if (b.hasAttribute("data-print")) { document.body.classList.add("is-printing-sov"); window.print(); setTimeout(() => document.body.classList.remove("is-printing-sov"), 500); }
    } catch (err) { toast(err.message, true); }
  });

  /* --------------------------------------------------------- live changes */
  let unsub = null, liveTimer = null;
  const reloadSoon = () => { clearTimeout(liveTimer); liveTimer = setTimeout(async () => { if (destroyed) return; await load(); repaint(); }, 250); };
  function onRemote({ table, eventType, new: row, old }) {
    if (destroyed) return;
    if (table === "pm_comments") {
      if (eventType === "INSERT" && row?.id && !comments.some((c) => c.id === row.id)) { comments.push(row); repaint(); }
      else if (eventType === "DELETE") { comments = comments.filter((c) => c.id !== old?.id); repaint(); }
      return;
    }
    if (table === "pm_inputs" && eventType === "UPDATE" && row?.id) {
      const i = inputs.find((x) => x.id === row.id);
      if (i && !timers.has(`input:${i.id}`)) { Object.assign(i, row); store.pmInputLog(model.engagement_id).then((l) => { log = l; repaint(); }).catch(() => {}); paintDerived(); }
      return;
    }
    if (table === "pm_lines" && eventType === "UPDATE" && row?.id) {
      const l = lines.find((x) => x.id === row.id);
      if (l && !timers.has(`line:${l.id}`)) { Object.assign(l, row); paintDerived(); repaint(); }
      return;
    }
    if (table === "sov_lines" && eventType === "UPDATE" && row?.id && sov) {
      const l = sov.lines.find((x) => x.id === row.id);
      if (l) { Object.assign(l, row); paintDerived(); }
      return;
    }
    reloadSoon();
  }

  await load();
  render();
  const filters = [{ table: "pm_lines", filter: `model_id=eq.${modelId}` }, { table: "pm_inputs", filter: `model_id=eq.${modelId}` }, { table: "pm_comments", filter: `model_id=eq.${modelId}` }];
  if (model.sov_sheet_id) filters.push({ table: "sov_lines", filter: `sheet_id=eq.${model.sov_sheet_id}` }, { table: "sov_sheets", filter: `id=eq.${model.sov_sheet_id}` }, { table: "sov_budget", filter: `engagement_id=eq.${model.engagement_id}` });
  store.subscribe(`pm-${modelId}`, filters, onRemote, (status) => {
    live = status === "SUBSCRIBED";
    const n = el.querySelector("[data-live]");
    if (n) { n.classList.toggle("is-on", live); n.textContent = live ? "Live" : "Connecting…"; }
  }).then((u) => { if (destroyed) u(); else unsub = u; }).catch(() => {});

  return {
    get result() { return result; },
    destroy() { destroyed = true; unsub?.(); for (const t of timers.values()) clearTimeout(t); },
  };
}

/** A short summary for Home and admin cards (no DOM). */
export async function modelSummary(modelId) {
  const model = await store.pmModel(modelId);
  const [lines, inputs] = await Promise.all([store.pmLines(modelId), store.pmInputs(modelId)]);
  let sov = null;
  if (model.sov_sheet_id) {
    const [sheet, sl, budget] = await Promise.all([store.sovSheet(model.sov_sheet_id).catch(() => null), store.sovLines(model.sov_sheet_id).catch(() => []), store.sovBudget(model.engagement_id).catch(() => [])]);
    if (sheet) sov = { sheet, lines: sl, budget: new Map(budget.map((b) => [b.line_id, b])) };
  }
  return { model, inputs, result: calculate({ model, lines, inputs, sov, scenario: "forecast" }) };
}

const slug = (s) => String(s || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const cellCsv = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(r, inputs, title) {
  const rows = [[title], [`Scenario: ${r.scenario}`], [], ["Group", "Cost", "Amount"]];
  for (const g of r.groups) { for (const i of g.items) rows.push([g.label, i.label, Math.round(i.value)]); rows.push([g.label, "Subtotal", Math.round(g.total)]); }
  rows.push([], ["", "Total project cost", Math.round(r.total)], ["", "Loan", Math.round(r.loan)], ["", "Equity", Math.round(r.equity)], ["", "Monthly debt service", Math.round(r.payment)]);
  rows.push([], ["Year", "Revenue", "EBITDA", "Debt service", "Coverage", "Global coverage"]);
  for (const y of r.years) rows.push([y.year, y.revenue == null ? "" : Math.round(y.revenue), y.ebitda == null ? "" : Math.round(y.ebitda), Math.round(y.ds), y.dscr == null ? "" : y.dscr.toFixed(2), y.globalDscr == null ? "" : y.globalDscr.toFixed(2)]);
  rows.push([], ["Month", "Spending", "Interest", "Equity", "Loan draw", "Loan balance"]);
  for (const x of r.schedule) rows.push([monthLabel(r.close, x.m), Math.round(x.uses), Math.round(x.interest), Math.round(x.equity), Math.round(x.loan), Math.round(x.balance)]);
  rows.push([], ["Assumption", "Value", "Status"]);
  for (const i of inputs) rows.push([i.label, i.unit === "date" ? i.text_value || "" : i.value ?? "", i.status]);
  return rows.map((row) => row.map(cellCsv).join(",")).join("\r\n");
}
