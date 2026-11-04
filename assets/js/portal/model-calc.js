// The project model's arithmetic: no DOM, no network, so it can be tested on its own.
//
//   cost lines ─┐
//   pricing sheet (hard costs) ─┼─► total project cost ─► loan and equity ─► monthly draws ─► interest
//   allowances (% of hard) ─────┘          ▲                                                   │
//                                          └──────────── interest and loan fee ◄───────────────┘
//   after opening: revenue ramp ─► EBITDA ─► debt service ─► coverage (project and global)
//
// Interest during construction and the loan fee depend on the loan, which depends on the total
// cost, which includes them; the figures are worked out again until they settle.

export const SCENARIOS = [["forecast", "Forecast"], ["low", "Low"], ["base", "Base"], ["high", "High"]];
export const GROUPS = [
  ["land", "Land"], ["hard", "Hard costs"], ["allowance", "Contingency and escalation"], ["soft", "Soft and opening costs"], ["financing", "Financing costs"],
];
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;

/** The inputs as { key: value } (dates as text), plus { key: status }. */
export function readInputs(inputs) {
  const v = {}, status = {}, byKey = {};
  for (const i of inputs || []) {
    v[i.key] = i.unit === "date" ? i.text_value || null : num(i.value);
    status[i.key] = i.status;
    byKey[i.key] = i;
  }
  return { v, status, byKey };
}

/** One pricing-sheet line's cost in a scenario. Forecast: the contractor's price once given;
 *  until then (and for excluded or TBD scope, which someone still has to pay for) the budget. */
export function sovLineValue(l, b, scenario) {
  const base = num(b?.base);
  if (scenario === "forecast") {
    if (["priced", "allowance"].includes(l.line_status) && l.amount != null) return { value: Number(l.amount), source: "price" };
    return { value: base ?? 0, source: base == null ? "none" : "budget" };
  }
  const v = scenario === "low" ? num(b?.low) ?? base : scenario === "high" ? num(b?.high) ?? base : base;
  return { value: v ?? 0, source: v == null ? "none" : "budget" };
}

/** A cost line's value in a scenario. Forecast: what's committed, else the base budget,
 *  never less than what's already been paid. */
export function lineValue(line, scenario) {
  const base = num(line.base);
  if (scenario === "forecast") {
    const best = num(line.committed) ?? base ?? 0;
    return Math.max(best, num(line.paid) ?? 0);
  }
  const v = scenario === "low" ? num(line.low) ?? base : scenario === "high" ? num(line.high) ?? base : base;
  return v ?? 0;
}
const linePct = (line, scenario) => {
  const base = num(line.pct_base);
  const v = scenario === "low" ? num(line.pct_low) ?? base : scenario === "high" ? num(line.pct_high) ?? base : base;
  return (v ?? 0) / 100;
};

/** Spread an amount over months: evenly, or as a construction S-curve (slow, busy, slow). */
function spread(amount, start, months, curve = false) {
  const n = Math.max(1, Math.round(months || 1));
  const w = Array.from({ length: n }, (_, i) => (curve && n > 2 ? Math.sin((Math.PI * (i + 0.5)) / n) : 1));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x, i) => [start + i, (amount * x) / sum]);
}

export function monthLabel(close, m) {
  if (!close || !/^\d{4}-\d{2}$/.test(close)) return `Month ${m}`;
  const [y, mo] = close.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + m, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Level monthly payment on a loan. */
export function payment(principal, annualRatePct, years) {
  const r = (annualRatePct || 0) / 1200, n = Math.round((years || 0) * 12);
  if (!principal || !n) return 0;
  if (!r) return principal / n;
  return (principal * r) / (1 - (1 + r) ** -n);
}

/**
 * Work the model out.
 *   model   { building_sf }
 *   lines   cost lines (pm_lines)
 *   inputs  assumptions (pm_inputs)
 *   sov     { sheet, lines, budget: Map(line_id → {low, base, high}) } or null
 */
export function calculate({ model = {}, lines = [], inputs = [], sov = null, scenario = "forecast" }) {
  const { v, status } = readInputs(inputs);
  const design = Math.max(0, Math.round(v.design_months ?? 0));
  const build = Math.max(1, Math.round(v.build_months ?? 10));
  const opening = design + build;
  const rate = v.loan_rate ?? 0;
  const groups = Object.fromEntries(GROUPS.map(([k, label]) => [k, { key: k, label, items: [], total: 0 }]));

  // Hard costs: the pricing sheet's lines, then its overhead and profit, then any other hard lines.
  let sovSub = 0, priced = 0, sovCount = 0;
  if (sov?.sheet) {
    for (const l of sov.lines || []) {
      const { value, source } = sovLineValue(l, sov.budget?.get(l.id), scenario);
      sovSub += value; sovCount++;
      if (source === "price") priced++;
    }
    groups.hard.items.push({ id: "sov", kind: "sov", label: sov.sheet.title, value: sovSub, priced, count: sovCount, sheet: sov.sheet });
  }
  for (const line of lines.filter((l) => l.grp === "hard")) {
    let value;
    if (line.calc === "ohp") {
      const pct = scenario === "forecast" && sov?.sheet?.ohp_pct != null && priced ? Number(sov.sheet.ohp_pct) / 100 : linePct(line, scenario);
      value = Math.max(round2(pct * sovSub), scenario === "forecast" ? num(line.paid) ?? 0 : 0);
    } else value = lineValue(line, scenario);
    groups.hard.items.push({ line, label: line.label, value });
  }
  const hard = groups.hard.items.reduce((a, i) => a + i.value, 0);
  groups.hard.total = hard;

  for (const line of lines.filter((l) => l.grp === "allowance")) {
    const value = line.calc === "pct_hard" ? Math.max(round2(linePct(line, scenario) * hard), scenario === "forecast" ? num(line.paid) ?? 0 : 0) : lineValue(line, scenario);
    groups.allowance.items.push({ line, label: line.label, value });
  }
  for (const k of ["land", "soft"]) {
    for (const line of lines.filter((l) => l.grp === k)) groups[k].items.push({ line, label: line.label, value: lineValue(line, scenario) });
  }
  for (const k of ["allowance", "land", "soft"]) groups[k].total = groups[k].items.reduce((a, i) => a + i.value, 0);
  const fixed = hard + groups.allowance.total + groups.land.total + groups.soft.total;

  // When each cost is paid, by month from closing (month 0).
  const timed = [];
  const place = (amount, line, curveDefault = false) => {
    if (!amount) return;
    const t = line?.timing || "construction";
    if (t === "closing") timed.push([0, amount]);
    else if (t === "design") timed.push(...spread(amount, 0, design || 1));
    else if (t === "opening") timed.push([opening, amount]);
    else if (t === "custom") timed.push(...spread(amount, Math.max(0, line.timing_start ?? 0), line.timing_months || 1));
    else timed.push(...spread(amount, design, build, curveDefault || t === "construction"));
  };
  for (const i of groups.hard.items) place(i.value, i.line || { timing: "construction" }, true);
  for (const k of ["allowance", "land", "soft"]) for (const i of groups[k].items) place(i.value, i.line);
  const horizon = opening + 1;

  // Financing: iterate loan → draws → interest → total → loan until it settles.
  const finLines = lines.filter((l) => l.grp === "financing");
  let fee = 0, interest = 0, total = fixed, loan = 0, equity = 0, sched = [];
  for (let iter = 0; iter < 30; iter++) {
    total = fixed + fee + interest;
    loan = v.loan_amount != null ? v.loan_amount : round2(((v.loan_ltc ?? 0) / 100) * total);
    equity = total - loan;
    fee = 0;
    for (const l of finLines) if (l.calc === "loan_fee") fee += round2(linePct(l, scenario) * loan);
    // Draws: equity first, then the loan; interest on the loan balance, capitalized.
    const uses = Array(horizon).fill(0);
    for (const [m, a] of timed) uses[Math.min(m, horizon - 1)] += a;
    const feeAt = Array(horizon).fill(0); feeAt[0] = fee;
    for (const l of finLines) if (!l.calc) { const a = lineValue(l, scenario); for (const [m, x] of l.timing === "closing" || !l.timing ? [[0, a]] : spread(a, design, build)) feeAt[Math.min(m, horizon - 1)] += x; }
    let eqLeft = Math.max(0, equity), bal = 0, intTotal = 0;
    sched = [];
    for (let m = 0; m < horizon; m++) {
      const int = round2((bal * rate) / 1200);
      intTotal += int;
      const need = uses[m] + feeAt[m] + int;
      const fromEq = Math.min(eqLeft, need);
      eqLeft -= fromEq;
      const fromLoan = need - fromEq;
      bal += fromLoan;
      sched.push({ m, uses: uses[m] + feeAt[m], interest: int, equity: fromEq, loan: fromLoan, balance: bal });
    }
    const otherFin = finLines.filter((l) => !l.calc).reduce((a, l) => a + lineValue(l, scenario), 0);
    const next = round2(intTotal);
    const settled = Math.abs(next - interest) < 1 && Math.abs(fixed + fee + next + otherFin - total) < 1;
    interest = next;
    total = fixed + fee + interest + otherFin;
    if (settled) break;
  }
  loan = v.loan_amount != null ? v.loan_amount : round2(((v.loan_ltc ?? 0) / 100) * total);
  equity = total - loan;
  for (const l of finLines) {
    const value = l.calc === "loan_fee" ? round2(linePct(l, scenario) * loan) : l.calc === "interest" ? interest : lineValue(l, scenario);
    groups.financing.items.push({ line: l, label: l.label, value });
  }
  groups.financing.total = groups.financing.items.reduce((a, i) => a + i.value, 0);
  total = fixed + groups.financing.total;
  loan = v.loan_amount != null ? v.loan_amount : round2(((v.loan_ltc ?? 0) / 100) * total);
  equity = total - loan;

  // After opening: the ramp, EBITDA, debt service and coverage, three years out.
  const pay = payment(loan, rate, v.loan_term_years ?? 25);
  const io = Math.max(0, Math.round(v.io_months ?? 0));
  const opsReady = v.revenue_full != null && v.ebitda_margin != null;
  const ops = [];
  let cum = 0;
  for (let k = 1; k <= 36; k++) {
    const ramp = v.ramp_months ? Math.min(1, k / v.ramp_months) : 1;
    const revenue = opsReady ? ((v.revenue_full / 12) * ramp) : null;
    const ebitda = opsReady ? revenue * (v.ebitda_margin / 100) : null;
    const ds = k <= io ? (loan * rate) / 1200 : pay;
    const cash = opsReady ? ebitda - ds : null;
    if (cash != null) cum += cash;
    ops.push({ m: opening + k, revenue, ebitda, ds, cash, cum: opsReady ? cum : null });
  }
  const years = [0, 1, 2].map((y) => {
    const rows = ops.slice(y * 12, y * 12 + 12);
    const sum = (f) => (opsReady ? rows.reduce((a, r) => a + r[f], 0) : null);
    const revenue = sum("revenue"), ebitda = sum("ebitda"), ds = rows.reduce((a, r) => a + r.ds, 0);
    const exCf = v.existing_cash_flow, exDs = v.existing_debt_service ?? 0, draws = v.owner_draws ?? 0;
    const globalReady = opsReady && exCf != null;
    return {
      year: y + 1, revenue, ebitda, ds,
      dscr: opsReady && ds ? ebitda / ds : null,
      globalDscr: globalReady && ds + exDs ? (ebitda + exCf - draws) / (ds + exDs) : null,
    };
  });

  // What the figures still depend on.
  const missing = [];
  const need = (key, why) => { if (v[key] == null || status[key] === "unknown") missing.push({ key, why }); };
  need("loan_ltc", "loan size"); need("loan_rate", "interest and debt service"); need("loan_term_years", "debt service");
  need("revenue_full", "coverage"); need("ebitda_margin", "coverage"); need("existing_cash_flow", "global coverage"); need("existing_debt_service", "global coverage");

  const sf = num(model.building_sf) || num(sov?.sheet?.building_sf);
  return {
    scenario, groups: GROUPS.map(([k]) => groups[k]), hard, total, perSf: sf ? total / sf : null,
    devCost: total - groups.land.total,
    loan, equity, ltc: total ? loan / total : null,
    equityAvailable: v.equity_available ?? null, gap: v.equity_available != null ? equity - v.equity_available : null,
    payment: pay, opening, design, build, close: v.close_month || null,
    schedule: sched, ops, years, opsReady, missing, sovPriced: priced, sovCount,
    dscrTarget: v.dscr_target ?? 1.25,
  };
}
