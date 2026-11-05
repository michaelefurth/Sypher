// The owner model's arithmetic: no DOM, no network, so it can be tested on its own.
//
// An owner model looks at a person and everything they own, the way a forensic accountant, a
// tax CPA and a lender's underwriter would:
//
//   entities (books by period) ─► normalization ─► cash flow available for debt service
//   filed returns ─────────────► book-to-tax bridge ─► unexplained difference
//   properties ─► land / building / components ─► depreciation as filed vs. with cost segregation
//                                                 ─► catch-up (Form 3115), first-year deduction, tax saved
//   everything ─► owner's global cash flow ─► coverage of existing debt, and of the new project
//
// Nothing here is advice: every figure is an estimate from the inputs as given, and each
// input carries a status (confirmed, estimate, unknown) and who is to confirm it.

export const CURRENT_YEAR = 2026;
export const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (a, f = (x) => x) => a.reduce((t, x) => t + (f(x) || 0), 0);

/* ============================================================== tax parameters */
// Federal parameters by tax year. 2025 and 2026 reflect P.L. 119-21 (July 4, 2025): permanent
// 100% bonus depreciation for property acquired after January 19, 2025, the higher standard
// deduction, Section 179 at $2.5m (indexed), and the permanent 20% qualified business income
// deduction. Check each year's figures against the IRS revenue procedure before filing.
export const TAX = {
  2024: {
    brackets: {
      single: [[11600, 0.10], [47150, 0.12], [100525, 0.22], [191950, 0.24], [243725, 0.32], [609350, 0.35], [Infinity, 0.37]],
      mfj: [[23200, 0.10], [94300, 0.12], [201050, 0.22], [383900, 0.24], [487450, 0.32], [731200, 0.35], [Infinity, 0.37]],
      hoh: [[16550, 0.10], [63100, 0.12], [100500, 0.22], [191950, 0.24], [243700, 0.32], [609350, 0.35], [Infinity, 0.37]],
    },
    standard: { single: 14600, mfj: 29200, hoh: 21900 },
    ssWageBase: 168600, qbiThreshold: { single: 191950, mfj: 383900, hoh: 191950 }, qbiPhase: { single: 50000, mfj: 100000, hoh: 50000 },
    s179: { limit: 1220000, phaseOut: 3050000 },
  },
  2025: {
    brackets: {
      single: [[11925, 0.10], [48475, 0.12], [103350, 0.22], [197300, 0.24], [250525, 0.32], [626350, 0.35], [Infinity, 0.37]],
      mfj: [[23850, 0.10], [96950, 0.12], [206700, 0.22], [394600, 0.24], [501050, 0.32], [751600, 0.35], [Infinity, 0.37]],
      hoh: [[17000, 0.10], [64850, 0.12], [103350, 0.22], [197300, 0.24], [250500, 0.32], [626350, 0.35], [Infinity, 0.37]],
    },
    standard: { single: 15750, mfj: 31500, hoh: 23625 },
    ssWageBase: 176100, qbiThreshold: { single: 197300, mfj: 394600, hoh: 197300 }, qbiPhase: { single: 50000, mfj: 100000, hoh: 50000 },
    s179: { limit: 2500000, phaseOut: 4000000 },
  },
  2026: {
    brackets: {
      single: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
      mfj: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
      hoh: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201775, 0.24], [256200, 0.32], [640600, 0.35], [Infinity, 0.37]],
    },
    standard: { single: 16100, mfj: 32200, hoh: 24150 },
    ssWageBase: 184500, qbiThreshold: { single: 201775, mfj: 403550, hoh: 201775 }, qbiPhase: { single: 75000, mfj: 150000, hoh: 75000 },
    s179: { limit: 2560000, phaseOut: 4090000 },
  },
};
export const FILING = [["single", "Single"], ["mfj", "Married filing jointly"], ["hoh", "Head of household"]];
const SE_RATE = 0.153, SE_MEDICARE = 0.029, SE_FACTOR = 0.9235, ADDL_MEDICARE = 0.009, NIIT = 0.038;
const addlMedicareThreshold = (fs) => (fs === "mfj" ? 250000 : 200000);
/** The parameters for a year, or the nearest year we have. */
export function taxParams(year) {
  const years = Object.keys(TAX).map(Number);
  return TAX[year] || TAX[years.reduce((best, y) => (Math.abs(y - year) < Math.abs(best - year) ? y : best), years[0])];
}

/* ============================================================== depreciation */
// MACRS general depreciation system, half-year convention, as percentages of basis.
export const MACRS = {
  3: [33.33, 44.45, 14.81, 7.41],
  5: [20, 32, 19.2, 11.52, 11.52, 5.76],
  7: [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  10: [10, 18, 14.4, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
  15: [5, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95],
  20: [3.75, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231],
};
/** Component categories a cost segregation study assigns, with the recovery class and whether bonus applies. */
export const CATEGORIES = {
  p5: { label: "5-year personal property", years: 5, bonus: true, hint: "Decorative lighting, millwork, carpet and vinyl flooring, kitchen hook-ups and dedicated electrical and plumbing, signage, data cabling" },
  p7: { label: "7-year property", years: 7, bonus: true, hint: "Furniture, fixtures and equipment; agricultural fences and most farm machinery" },
  li15: { label: "15-year land improvements", years: 15, bonus: true, hint: "Parking, sidewalks, curbs, site lighting, landscaping, fencing, drainage, wells and water lines" },
  qip: { label: "Qualified improvement property (15-year)", years: 15, bonus: true, hint: "Interior improvements to a nonresidential building made after it was first placed in service (not enlargements, elevators or structural framework)" },
  ag10: { label: "Single-purpose agricultural structure (10-year)", years: 10, bonus: true, hint: "A structure designed, built and used only to house, raise and feed one kind of livestock. A barn with mixed storage use does not qualify" },
  farm20: { label: "Farm building (20-year)", years: 20, bonus: true, hint: "A general-purpose barn or farm building used in a farming business" },
  bldg: { label: "Building (27.5 or 39-year)", years: null, bonus: false, hint: "The structure: straight line, mid-month" },
};
/** Bonus depreciation rate for property by the date it was acquired (binding contract) and placed in service. */
export function bonusRate(acquired, placed) {
  const a = acquired || placed, p = placed || acquired;
  if (!p) return 0;
  if (a >= "2025-01-20") return 1;
  const y = Number(p.slice(0, 4));
  if (a < "2017-09-28") return y <= 2017 && y >= 2015 ? 0.5 : 0;
  if (y <= 2022) return 1;
  return { 2023: 0.8, 2024: 0.6, 2025: 0.4, 2026: 0.2 }[y] ?? 0;
}
/** Straight-line, mid-month: the share of basis deductible in each year after the placed-in-service month. */
function slMidMonth(years, placed, count) {
  const month = Number((placed || "2000-01").slice(5, 7)) || 1;
  const first = (12 - month + 0.5) / 12 / years;
  const out = [];
  let used = 0;
  for (let i = 0; i < count; i++) {
    const r = i === 0 ? first : Math.min(1 / years, 1 - used);
    out.push(Math.max(0, r)); used += r;
  }
  return out;
}
/**
 * Annual deductions for one asset, keyed by calendar year.
 *   basis, placed (YYYY-MM-DD), years (3,5,7,10,15,20 or 27.5/39), bonus (0..1), s179 (amount expensed first)
 */
export function depreciate({ basis, placed, years, bonus = 0, s179 = 0 }, through = CURRENT_YEAR + 40) {
  const out = {};
  const b = num(basis) || 0;
  if (!b || !placed) return out;
  const y0 = Number(placed.slice(0, 4));
  const expensed = Math.min(b, Math.max(0, num(s179) || 0));
  let rest = b - expensed;
  const bonusAmt = round2(rest * Math.min(1, Math.max(0, bonus)));
  rest -= bonusAmt;
  out[y0] = expensed + bonusAmt;
  const table = MACRS[years];
  if (table) {
    table.forEach((p, i) => { if (y0 + i <= through) out[y0 + i] = round2((out[y0 + i] || 0) + (rest * p) / 100); });
  } else {
    const n = Math.ceil(years) + 1;
    slMidMonth(years, placed, n).forEach((r, i) => { if (y0 + i <= through) out[y0 + i] = round2((out[y0 + i] || 0) + rest * r); });
  }
  return out;
}
const addInto = (acc, sched, k = 1) => { for (const [y, v] of Object.entries(sched)) acc[y] = round2((acc[y] || 0) + v * k); return acc; };
const cumThrough = (sched, year) => sum(Object.entries(sched).filter(([y]) => Number(y) <= year), ([, v]) => v);

/**
 * One property: how it has been depreciated (straight line on the building, which is what the
 * returns presumably show) and how it would be with a cost segregation study.
 *   property   { cost_basis, land_pct, land_value, acquired, placed_in_service, recovery_years, use,
 *                prior_depreciation, bonus_elected_out }
 *   components [{ category, pct, amount, placed_in_service, acquired, bonus_eligible }]
 *   opts       { studyYear, marginalRate, seRate, qbiFactor, discountRate, passive, passiveCapacity }
 */
export function propertySchedule(property, components = [], opts = {}) {
  const p = property;
  const study = opts.studyYear || CURRENT_YEAR;
  const cost = num(p.cost_basis) || 0;
  const landValue = p.land_value != null ? num(p.land_value) : round2(cost * ((num(p.land_pct) ?? 0) / 100));
  // A residence or bare land is not depreciated: it still counts for value, debt and debt service.
  const depreciates = !["personal", "land"].includes(p.use);
  const depreciable = depreciates ? Math.max(0, cost - landValue) : 0;
  const placed = p.placed_in_service || p.acquired || null;
  const bYears = num(p.recovery_years) || (p.use === "residential" ? 27.5 : 39);
  const missing = [];
  if (depreciates) {
    if (!cost) missing.push("cost basis");
    if (!placed) missing.push("placed-in-service date");
    if (p.land_pct == null && p.land_value == null) missing.push("land share");
  }

  // Components: a share of the depreciable basis or a fixed amount (an improvement made later).
  const resolved = [];
  let assigned = 0;
  for (const c of components) {
    const cat = CATEGORIES[c.category] || CATEGORIES.bldg;
    const amount = c.amount != null ? num(c.amount) : round2(depreciable * ((num(c.pct) ?? 0) / 100));
    if (!amount) continue;
    const cPlaced = c.placed_in_service || placed;
    const years = cat.years || bYears;
    const eligible = cat.bonus && c.bonus_eligible !== false && !p.bonus_elected_out;
    const bonus = eligible ? bonusRate(c.acquired || p.acquired, cPlaced) : 0;
    const sched = depreciate({ basis: amount, placed: cPlaced, years, bonus });
    resolved.push({ ...c, label: c.label || cat.label, amount, years, bonus, sched, cat, fixed: c.amount != null, placed: cPlaced });
    if (c.amount == null) assigned += amount;
  }
  // Whatever is not carved out stays in the building.
  const residual = Math.max(0, depreciable - assigned);
  const building = depreciate({ basis: residual, placed, years: bYears });
  const withSeg = { ...building };
  for (const c of resolved) addInto(withSeg, c.sched);
  // As filed: the whole depreciable basis straight line, and later improvements the same way.
  const asFiled = depreciate({ basis: depreciable, placed, years: bYears });
  for (const c of resolved) if (c.fixed) addInto(asFiled, depreciate({ basis: c.amount, placed: c.placed, years: bYears }));

  const priorYear = study - 1;
  const allowedAsFiled = p.prior_depreciation != null ? num(p.prior_depreciation) : cumThrough(asFiled, priorYear);
  const allowableWithSeg = cumThrough(withSeg, priorYear);
  const inService = placed ? Number(placed.slice(0, 4)) < study : false;
  const catchUp = inService ? Math.max(0, round2(allowableWithSeg - allowedAsFiled)) : 0;
  const yearSeg = withSeg[study] || 0, yearFiled = asFiled[study] || 0;
  const extra = round2(catchUp + yearSeg - yearFiled);   // the additional deduction in the study year

  // What it is worth: tax at the owner's marginal rate (plus self-employment tax where the
  // property is used in their own business), net of the lost qualified business income deduction.
  const rate = (opts.marginalRate ?? 0) + (p.se_business ? (opts.seRate ?? 0) : 0);
  const qbiFactor = p.se_business ? (opts.qbiFactor ?? 1) : 1;
  const effRate = rate * qbiFactor;
  let usable = extra, suspended = 0;
  if (p.passive) {
    const cap = Math.max(0, num(opts.passiveCapacity) ?? 0);
    usable = Math.min(extra, cap);
    suspended = round2(extra - usable);
  }
  const savingsYear1 = round2(usable * effRate);
  // Present value of the timing difference over the remaining life, at the discount rate.
  const dr = opts.discountRate ?? 0.08;
  let pvSeg = 0, pvFiled = 0;
  const horizon = study + 40;
  for (let y = study; y <= horizon; y++) {
    const t = y - study;
    const dSeg = (withSeg[y] || 0) + (y === study ? catchUp : 0);
    const dFiled = asFiled[y] || 0;
    pvSeg += (dSeg * effRate) / (1 + dr) ** t;
    pvFiled += (dFiled * effRate) / (1 + dr) ** t;
  }
  const npv = p.passive ? null : round2(pvSeg - pvFiled);
  const reclass = sum(resolved.filter((c) => c.cat !== CATEGORIES.bldg), (c) => c.amount);
  return {
    cost, landValue, depreciable, bYears, placed, residual, reclass, reclassPct: depreciable ? reclass / depreciable : null,
    components: resolved, asFiled, withSeg, allowedAsFiled, allowableWithSeg, catchUp, yearSeg, yearFiled, extra, usable, suspended,
    effRate, savingsYear1, npv, inService, missing,
  };
}

/* ============================================================== the owner's taxes */
function bracketTax(taxable, brackets) {
  let tax = 0, last = 0;
  for (const [cap, rate] of brackets) {
    if (taxable <= last) break;
    tax += (Math.min(taxable, cap) - last) * rate;
    last = cap;
  }
  return tax;
}
function marginalRate(taxable, brackets) {
  for (const [cap, rate] of brackets) if (taxable < cap) return rate;
  return brackets[brackets.length - 1][1];
}
/**
 * An estimate of one year's federal income and self-employment tax.
 *   businesses  [{ name, net, w2_wages, ubia, sstb }]   Schedule C / F trades (net earnings from self-employment)
 *   rental      net Schedule E (passive) income or loss actually allowed
 *   other       wages, interest, other ordinary income
 *   itemized    itemized deductions if larger than the standard deduction
 */
export function taxEstimate({ year = CURRENT_YEAR, filing = "single", businesses = [], rental = 0, other = 0, itemized = 0, extraDeductions = 0 }) {
  const P = taxParams(year);
  const fs = FILING.some(([k]) => k === filing) ? filing : "single";
  const seNetTotal = sum(businesses, (b) => num(b.net));
  const seBase = Math.max(0, seNetTotal) * SE_FACTOR;
  const ss = Math.min(seBase, P.ssWageBase) * 0.124;
  const medicare = seBase * SE_MEDICARE;
  const addl = Math.max(0, seBase - addlMedicareThreshold(fs)) * ADDL_MEDICARE;
  const seTax = round2(ss + medicare);
  const agi = seNetTotal + (num(rental) || 0) + (num(other) || 0) - seTax / 2 - (num(extraDeductions) || 0);
  const deduction = Math.max(P.standard[fs], num(itemized) || 0);
  const before = Math.max(0, agi - deduction);
  // Qualified business income: 20% of each trade's income, limited above the threshold by its
  // W-2 wages and property, capped at 20% of taxable income before the deduction.
  const thr = P.qbiThreshold[fs], phase = P.qbiPhase[fs];
  const over = Math.max(0, Math.min(1, (before - thr) / phase));
  let qbi = 0, qbiLimited = false;
  for (const b of businesses) {
    const q = Math.max(0, num(b.net) || 0) - (Math.max(0, num(b.net) || 0) / Math.max(1, seNetTotal)) * (seTax / 2);
    const full = q * 0.2;
    const wages = num(b.w2_wages) || 0, ubia = num(b.ubia) || 0;
    const limit = Math.max(0.5 * wages, 0.25 * wages + 0.025 * ubia);
    const sstb = b.sstb ? 1 - over : 1;
    const allowed = over > 0 ? (full - Math.max(0, full - limit) * over) * sstb : full;
    if (over > 0 && allowed < full) qbiLimited = true;
    qbi += Math.max(0, allowed);
  }
  qbi = Math.min(qbi, before * 0.2);
  const taxable = Math.max(0, before - qbi);
  const income = round2(bracketTax(taxable, P.brackets[fs]));
  const niit = Math.max(0, Math.min(Math.max(0, num(rental) || 0), Math.max(0, agi - addlMedicareThreshold(fs)))) * NIIT;
  const total = round2(income + seTax + addl + niit);
  const bracket = marginalRate(taxable, P.brackets[fs]);
  // The rate the next dollar of business deduction saves: income tax, SE tax (Medicare only
  // above the wage base), less the 20% of it that was QBI deduction if that applies.
  const seMarginal = seBase > P.ssWageBase ? SE_MEDICARE + (seBase > addlMedicareThreshold(fs) ? ADDL_MEDICARE : 0) : SE_RATE;
  const qbiActive = qbi > 0 && !qbiLimited ? 0.8 : 1;
  return {
    year, filing: fs, seNetTotal, seTax: round2(seTax + addl), agi: round2(agi), deduction, qbi: round2(qbi), qbiLimited, before: round2(before), taxable: round2(taxable),
    incomeTax: income, niit: round2(niit), total, bracket, seMarginal: round2(seMarginal * SE_FACTOR * 1000) / 1000, qbiFactor: qbiActive,
    effective: agi > 0 ? total / agi : null, params: P,
  };
}

/* ============================================================== entities and periods */
const ADJ_SIGN = { addback: 1, deduction: -1, nonrecurring: -1, elimination: 1, book_tax: 0 };
/**
 * Normalize one entity's periods.
 *   periods     [{ period, revenue, cogs, opex, depreciation, interest, rent_paid, rent_related, owner_comp,
 *                  other_expense, net_income, tax_net, tax_gross, months }]
 *   adjustments [{ period, kind, amount, applies_to, evidence_status }]
 * Cash flow available for debt service = net income + depreciation + interest + related-party
 * rent to the owner + owner compensation expensed + evidenced add-backs − evidenced deductions
 * and non-recurring items. Only evidenced or approved adjustments count; proposed ones are shown.
 */
export function normalizeEntity(entity, periods = [], adjustments = []) {
  const rows = periods.map((pr) => {
    const book = Object.fromEntries(["revenue", "cogs", "opex", "depreciation", "interest", "rent_paid", "rent_related", "owner_comp", "other_expense", "net_income", "tax_net", "tax_gross"].map((k) => [k, num(pr[k])]));
    const adj = adjustments.filter((a) => a.period === pr.period);
    const counted = adj.filter((a) => ["evidenced", "approved"].includes(a.evidence_status));
    const cfAdj = sum(counted.filter((a) => a.applies_to !== "tax"), (a) => (ADJ_SIGN[a.kind] ?? 0) * (num(a.amount) || 0));
    const proposedCf = sum(adj.filter((a) => a.evidence_status === "proposed" && a.applies_to !== "tax"), (a) => (ADJ_SIGN[a.kind] ?? 0) * (num(a.amount) || 0));
    const ni = book.net_income ?? (book.revenue != null ? (book.revenue || 0) - (book.cogs || 0) - (book.opex || 0) - (book.other_expense || 0) : null);
    const ebitda = ni == null ? null : round2(ni + (book.depreciation || 0) + (book.interest || 0));
    const cfads = ni == null ? null : round2(ebitda + (book.rent_related || 0) + (book.owner_comp || 0) + cfAdj);
    const gap = book.tax_net != null && ni != null ? round2(book.tax_net - ni) : null;
    const explained = sum(counted.filter((a) => a.applies_to !== "cash_flow"), (a) => num(a.amount) || 0);
    const remaining = gap == null ? null : round2(gap - explained);
    const months = num(pr.months) || 12;
    const annualize = (x) => (x == null ? null : round2((x * 12) / months));
    return {
      period: pr.period, months, book, ni, ebitda, cfads, cfadsAnnual: annualize(cfads), gap, explained, remaining, proposedCf,
      margin: book.revenue ? (ni ?? 0) / book.revenue : null, grossMargin: book.revenue && book.cogs != null ? (book.revenue - book.cogs) / book.revenue : null,
      adjustments: adj,
    };
  });
  const full = rows.filter((r) => r.months >= 12 && r.cfads != null);
  const latest = full[full.length - 1] || rows[rows.length - 1] || null;
  return { entity, periods: rows, latest, recurring: num(entity.recurring_cash_flow) };
}

/* ============================================================== the whole model */
export const INPUT_KEYS = ["filing_status", "tax_year", "study_year", "other_income", "itemized", "discount_rate", "living_draws", "entity_debt_service", "dscr_target", "passive_capacity", "w2_wages_total", "project_cfads", "project_debt_service"];
/**
 * Work the model out.
 *   model, entities, periods, adjustments, properties, components, inputs ({key,value,text_value,status})
 *   project (optional): the project model's result, for coverage with the new debt
 */
export function calculateOwner({ model = {}, entities = [], periods = [], adjustments = [], properties = [], components = [], inputs = [], findings = [], project = null }) {
  const v = {}, status = {};
  for (const i of inputs) { v[i.key] = i.unit === "date" || i.unit === "text" ? i.text_value || null : num(i.value); status[i.key] = i.status; }
  const filing = v.filing_status || model.filing_status || "single";
  const taxYear = Math.round(v.tax_year || CURRENT_YEAR - 1);
  const study = Math.round(v.study_year || CURRENT_YEAR);
  const dr = (v.discount_rate ?? 8) / 100;

  // Entities.
  const ents = entities.map((e) => normalizeEntity(e, periods.filter((p) => p.entity_id === e.id).sort((a, b) => String(a.period_start || a.period).localeCompare(String(b.period_start || b.period))), adjustments.filter((a) => a.entity_id === e.id)));
  const recurringCf = (en) => en.recurring ?? en.latest?.cfadsAnnual ?? null;
  const cfadsTotal = ents.some((en) => recurringCf(en) == null) ? null : round2(sum(ents, (en) => recurringCf(en)));

  // Taxes: the focus year as filed/estimated, then the study year with and without the properties' extra deductions.
  // A trade's taxable net for a year: the filed figure, else that year's full-year books, else the
  // latest full year on record (the study year is usually still open).
  const netFor = (e, year) => {
    const pr = e.periods.find((x) => String(x.period) === String(year) && (x.book.tax_net != null || x.months >= 12));
    if (pr) return pr.book.tax_net ?? pr.ni ?? 0;
    const full = e.periods.filter((x) => x.months >= 12);
    const last = full[full.length - 1];
    return last ? last.book.tax_net ?? last.ni ?? 0 : 0;
  };
  const bizFor = (year) => ents.filter((e) => ["sole_prop", "smllc"].includes(e.entity.kind)).map((e) => ({
    id: e.entity.id, name: e.entity.name, net: netFor(e, year), w2_wages: num(e.entity.w2_wages) || 0, ubia: num(e.entity.ubia) || 0, sstb: !!e.entity.sstb,
  }));
  const rentalNet = (year) => sum(properties.filter((p) => p.rent_source === "third_party" || p.rent_source === "family"), (p) => (num(p.annual_rent) || 0) - (num(p.annual_opex) || 0) - (num(p.annual_interest) || 0));
  const taxFocus = taxEstimate({ year: taxYear, filing, businesses: bizFor(taxYear), rental: rentalNet(taxYear), other: v.other_income || 0, itemized: v.itemized || 0 });
  const bizStudy = bizFor(study);
  const taxStudyBase = taxEstimate({ year: study, filing, businesses: bizStudy, rental: rentalNet(study), other: v.other_income || 0, itemized: v.itemized || 0 });

  // Properties and cost segregation, valued at the study-year rates.
  const props = properties.map((p) => {
    const comps = components.filter((c) => c.property_id === p.id);
    const s = propertySchedule(p, comps, { studyYear: study, marginalRate: taxStudyBase.bracket, seRate: taxStudyBase.seMarginal, qbiFactor: taxStudyBase.qbiFactor, discountRate: dr, passiveCapacity: v.passive_capacity ?? 0 });
    const rent = num(p.annual_rent) || 0, opex = num(p.annual_opex) || 0, ds = num(p.annual_debt_service) || 0;
    const noi = rent - opex;
    const equity = (num(p.market_value) || 0) - (num(p.debt_balance) || 0);
    return { property: p, schedule: s, rent, opex, ds, noi, equity, thirdParty: p.rent_source === "third_party" || p.rent_source === "family", self: p.rent_source === "self" };
  });
  const seg = {
    reclass: sum(props, (x) => x.schedule.reclass), catchUp: sum(props, (x) => x.schedule.catchUp), extra: sum(props, (x) => x.schedule.extra),
    usable: sum(props, (x) => x.schedule.usable), suspended: sum(props, (x) => x.schedule.suspended), savingsYear1: sum(props, (x) => x.schedule.savingsYear1),
    npv: sum(props.filter((x) => x.schedule.npv != null), (x) => x.schedule.npv), depreciable: sum(props, (x) => x.schedule.depreciable),
  };
  // The study year's tax with the extra deductions taken against the businesses that use the properties.
  const bizWithSeg = bizStudy.map((b) => ({ ...b }));
  let passiveExtra = 0;
  for (const x of props) {
    if (!x.schedule.usable) continue;
    if (x.property.se_business) {
      const target = bizWithSeg.find((b) => b.id === x.property.used_by_entity_id) || bizWithSeg[0];
      if (target) target.net -= x.schedule.usable; else passiveExtra += x.schedule.usable;
    } else passiveExtra += x.schedule.usable;
  }
  const taxStudySeg = taxEstimate({ year: study, filing, businesses: bizWithSeg, rental: rentalNet(study) - passiveExtra, other: v.other_income || 0, itemized: v.itemized || 0 });
  seg.taxSaved = round2(taxStudyBase.total - taxStudySeg.total);
  // Deductions beyond the year's income become a net operating loss, carried forward (and
  // limited to 80% of a later year's income); its value is shown at the study-year bracket.
  seg.nol = Math.max(0, round2(seg.usable - Math.max(0, taxStudyBase.before)));
  seg.nolValue = round2(seg.nol * taxStudyBase.bracket);

  // The owner's global cash flow, on recurring figures.
  const rentsNet = sum(props.filter((x) => x.thirdParty), (x) => x.noi);
  const selfRents = sum(props.filter((x) => x.self), (x) => x.rent);
  const propertyDs = sum(props, (x) => x.ds);
  const taxesNow = taxStudyBase.total;
  const draws = v.living_draws ?? null;
  const existingDs = round2(propertyDs + (v.entity_debt_service || 0));
  const available = cfadsTotal == null || draws == null ? null : round2(cfadsTotal + rentsNet - taxesNow - draws);
  const availableSeg = available == null ? null : round2(available + seg.taxSaved);
  const dscr = available != null && existingDs ? available / existingDs : null;
  const pcf = project?.years?.[1]?.ebitda ?? v.project_cfads ?? null, pds = project?.years?.[1]?.ds ?? v.project_debt_service ?? null;
  const withProject = available != null && pcf != null && pds != null ? { cfads: pcf, ds: pds, dscr: existingDs + pds ? (available + pcf) / (existingDs + pds) : null, dscrSeg: existingDs + pds ? (availableSeg + pcf) / (existingDs + pds) : null } : null;
  const global = { cfads: cfadsTotal, rentsNet, selfRents, taxes: taxesNow, draws, available, availableSeg, existingDs, propertyDs, dscr, withProject, target: v.dscr_target ?? 1.25 };

  // Findings and what is missing.
  const open = findings.filter((f) => ["open", "in_progress"].includes(f.status));
  const missing = [];
  const need = (key, why) => { if (v[key] == null || status[key] === "unknown") missing.push({ key, why }); };
  need("living_draws", "global cash flow"); need("entity_debt_service", "coverage"); need("filing_status", "tax estimate");
  for (const en of ents) if (recurringCf(en) == null) missing.push({ key: `entity:${en.entity.id}`, why: `${en.entity.name}: a full-year period or a recurring cash flow figure` });
  for (const x of props) for (const m of x.schedule.missing) missing.push({ key: `property:${x.property.id}`, why: `${x.property.label}: ${m}` });
  const bridgeRemaining = sum(ents, (en) => sum(en.periods.filter((p) => p.remaining != null), (p) => Math.abs(p.remaining)));

  return {
    filing, taxYear, study, entities: ents, properties: props, seg, tax: { focus: taxFocus, studyBase: taxStudyBase, studySeg: taxStudySeg }, global,
    findings: { total: findings.length, open: open.length, critical: open.filter((f) => f.severity === "critical").length, high: open.filter((f) => f.severity === "high").length },
    bridgeRemaining, missing, inputs: v,
  };
}

/* ============================================================== presets */
/** Typical cost segregation allocations by property use (share of the depreciable basis), as low / base / high. */
export const SEG_PRESETS = {
  restaurant: { label: "Restaurant or bar", p5: [20, 27, 35], li15: [8, 10, 14] },
  commercial: { label: "Commercial, retail or office", p5: [12, 18, 25], li15: [6, 9, 12] },
  warehouse: { label: "Warehouse or industrial", p5: [5, 8, 12], li15: [8, 12, 18] },
  residential: { label: "Residential rental", p5: [10, 14, 20], li15: [4, 6, 9] },
  equine: { label: "Equine or agricultural", p7: [4, 6, 9], li15: [12, 18, 25], farm20: [20, 30, 40] },
  mixed: { label: "Mixed use", p5: [8, 12, 18], li15: [6, 10, 14] },
};
