// Tests for the owner model's arithmetic (assets/js/portal/owner-calc.js).
//   node scripts/test-owner.mjs
import { MACRS, bonusRate, depreciate, propertySchedule, taxEstimate, normalizeEntity, calculateOwner, taxParams } from "../assets/js/portal/owner-calc.js";

const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const total = (s) => Object.values(s).reduce((a, b) => a + b, 0);

// 1. Depreciation tables and conventions.
{
  for (const [k, t] of Object.entries(MACRS)) ok(`MACRS ${k}-year table sums to 100%`, near(t.reduce((a, b) => a + b, 0), 100, 0.02));
  const five = depreciate({ basis: 100000, placed: "2024-03-01", years: 5 });
  ok("5-year property, half-year convention, first year 20%", five[2024] === 20000 && near(total(five), 100000, 0.5));
  const bonus = depreciate({ basis: 100000, placed: "2025-06-01", years: 5, bonus: 1 });
  ok("100% bonus takes the whole basis in year one", bonus[2025] === 100000 && total(bonus) === 100000);
  const part = depreciate({ basis: 100000, placed: "2024-06-01", years: 5, bonus: 0.6 });
  ok("60% bonus, then MACRS on the rest", near(part[2024], 60000 + 8000, 0.01) && near(total(part), 100000, 0.5));
  const s179 = depreciate({ basis: 50000, placed: "2025-06-01", years: 7, s179: 50000 });
  ok("Section 179 expenses the asset in full", s179[2025] === 50000 && total(s179) === 50000);
  const b39 = depreciate({ basis: 390000, placed: "2020-07-01", years: 39 });
  ok("39-year straight line, mid-month: July start takes 5.5 months", near(b39[2020], (390000 * 5.5) / 12 / 39, 0.01) && near(b39[2021], 10000, 0.01));
  ok("39-year schedule recovers the whole basis", near(total(depreciate({ basis: 390000, placed: "2020-07-01", years: 39 }, 2080)), 390000, 1));
  const r27 = depreciate({ basis: 275000, placed: "2022-01-15", years: 27.5 });
  ok("27.5-year residential: January start takes 11.5 months", near(r27[2022], (275000 * 11.5) / 12 / 27.5, 0.01) && near(r27[2023], 10000, 0.01));
  ok("bonus: acquired after January 19, 2025 is 100%", bonusRate("2025-03-01", "2025-09-01") === 1);
  ok("bonus: placed in service 2024 is 60%", bonusRate("2024-02-01", "2024-05-01") === 0.6);
  ok("bonus: 2019 was 100%", bonusRate("2019-05-01", "2019-05-01") === 1);
  ok("bonus: 2023 was 80%", bonusRate(null, "2023-05-01") === 0.8);
  ok("bonus: a binding contract before January 20, 2025, placed in 2025, is 40%", bonusRate("2024-12-15", "2025-04-01") === 0.4);
}
// 2. A property with and without a cost segregation study.
{
  const p = { cost_basis: 475000, land_pct: 20, acquired: "2020-07-01", placed_in_service: "2020-07-01", use: "commercial", se_business: true };
  const comps = [{ category: "p5", pct: 27 }, { category: "li15", pct: 10 }];
  const s = propertySchedule(p, comps, { studyYear: 2026, marginalRate: 0.32, seRate: 0.027, qbiFactor: 0.8, discountRate: 0.08 });
  ok("land is carved out of the basis", s.landValue === 95000 && s.depreciable === 380000);
  ok("components are a share of the depreciable basis", near(s.reclass, 380000 * 0.37, 0.01) && near(s.residual, 380000 * 0.63, 0.01));
  ok("2020 components got 100% bonus", s.components.every((c) => c.bonus === 1));
  const filedThru2025 = [2020, 2021, 2022, 2023, 2024, 2025].reduce((a, y) => a + (s.asFiled[y] || 0), 0);
  ok("as filed: straight line on the whole building", near(s.allowedAsFiled, filedThru2025, 0.01) && near(filedThru2025, (380000 * 5.5) / 12 / 39 + 5 * (380000 / 39), 1));
  ok("catch-up is what the study would have allowed, less what was taken", near(s.catchUp, s.allowableWithSeg - s.allowedAsFiled, 0.01) && s.catchUp > 100000);
  ok("the study-year deduction adds the catch-up and the year's difference", near(s.extra, s.catchUp + s.yearSeg - s.yearFiled, 0.01));
  ok("the saving uses the marginal, self-employment and QBI factors", near(s.savingsYear1, s.extra * (0.32 + 0.027) * 0.8, 0.5));
  ok("the present value of the timing benefit is positive", s.npv > 0 && s.npv < s.extra * 0.4);
  ok("total depreciation is the same either way", near(total(s.asFiled), total(s.withSeg), 2), `${total(s.asFiled).toFixed(0)} vs ${total(s.withSeg).toFixed(0)}`);
  const prior = propertySchedule({ ...p, prior_depreciation: 30000 }, comps, { studyYear: 2026, marginalRate: 0.32 });
  ok("a known prior-depreciation figure replaces the computed one", near(prior.catchUp, prior.allowableWithSeg - 30000, 0.01));
  const passive = propertySchedule({ ...p, se_business: false, passive: true }, comps, { studyYear: 2026, marginalRate: 0.32, passiveCapacity: 10000 });
  ok("a passive rental's extra deduction is limited to passive capacity; the rest is suspended", passive.usable === 10000 && near(passive.suspended, passive.extra - 10000, 0.01) && passive.npv === null);
  const fresh = propertySchedule({ ...p, acquired: "2026-02-01", placed_in_service: "2026-02-01" }, comps, { studyYear: 2026, marginalRate: 0.32 });
  ok("a property bought this year has no catch-up and full bonus on the components", fresh.catchUp === 0 && near(fresh.yearSeg, 380000 * 0.37 + fresh.asFiled[2026] * 0.63, 1));
  const improvement = propertySchedule(p, [{ category: "qip", amount: 60000, placed_in_service: "2023-04-01", acquired: "2023-04-01" }], { studyYear: 2026, marginalRate: 0.3 });
  ok("a later improvement is its own asset: 80% bonus in 2023 as QIP, 39-year as filed", near(improvement.withSeg[2023], 60000 * 0.8 + 60000 * 0.2 * 0.05 + improvement.asFiled[2023] - (60000 * 8.5) / 12 / 39, 1));
  const home = propertySchedule({ use: "personal", cost_basis: 479000, market_value: 479000, debt_balance: 150000 }, [{ category: "p5", pct: 14 }], { studyYear: 2026, marginalRate: 0.3 });
  ok("a residence is never depreciated and needs no basis", home.depreciable === 0 && home.extra === 0 && home.missing.length === 0);
  const missing = propertySchedule({ use: "residential" }, [], {});
  ok("missing inputs are named", missing.missing.includes("cost basis") && missing.missing.includes("placed-in-service date"));
}
// 3. The owner's taxes.
{
  const t = taxEstimate({ year: 2025, filing: "single", businesses: [{ name: "A", net: 114315 }, { name: "B", net: 138521 }] });
  ok("self-employment tax: 12.4% to the wage base, 2.9% on all, 0.9% above $200k", near(t.seTax, 176100 * 0.124 + 252836 * 0.9235 * 0.029 + (252836 * 0.9235 - 200000) * 0.009, 1), t.seTax.toFixed(2));
  ok("AGI takes half the self-employment tax", near(t.agi, 252836 - (176100 * 0.124 + 252836 * 0.9235 * 0.029) / 2, 1));
  ok("the 2025 standard deduction is $15,750", t.deduction === 15750);
  ok("QBI is limited above the threshold without wages or property", t.qbiLimited && t.qbi > 0 && t.qbi < 0.2 * 252836);
  ok("the marginal bracket is 32%", t.bracket === 0.32);
  ok("above the wage base the next dollar of business deduction saves Medicare tax only", near(t.seMarginal, (0.029 + 0.009) * 0.9235, 0.001));
  const w = taxEstimate({ year: 2025, filing: "single", businesses: [{ name: "A", net: 252836, w2_wages: 400000 }] });
  ok("with enough W-2 wages QBI is not wage-limited, only capped at 20% of taxable income", !w.qbiLimited && near(w.qbi, Math.min(0.2 * (252836 - w.seTax / 2), 0.2 * (w.agi - w.deduction)), 1) && w.qbiFactor === 0.8);
  const mfj = taxEstimate({ year: 2024, filing: "mfj", businesses: [{ name: "A", net: 80000 }], other: 40000 });
  ok("2024 married filing jointly uses the $29,200 deduction and the 12% bracket", mfj.deduction === 29200 && mfj.bracket === 0.12);
  ok("an unknown year falls back to the nearest parameters", taxParams(2030) === taxParams(2026) && taxParams(2020) === taxParams(2024));
  // A filed 2025 return, reproduced: head of household, two children, two Schedule Cs, one with W-2 payroll.
  const filed = taxEstimate({ year: 2025, filing: "hoh", businesses: [{ name: "Horses", net: 138521 }, { name: "Restaurant", net: 114315, w2_wages: 271510 }], children: 2 });
  ok("the filed 2025 return is reproduced: SE tax", near(filed.seTax, 28607 + 301, 2), filed.seTax.toFixed(0));
  ok("the filed 2025 return is reproduced: AGI and QBI", near(filed.agi, 238532, 2) && near(filed.qbi, 38504, 5), `${filed.agi.toFixed(0)} / ${filed.qbi.toFixed(0)}`);
  ok("the filed 2025 return is reproduced: income tax and the child tax credit", near(filed.incomeTax, 33445, 3) && near(filed.ctc, 2450, 1), `${filed.incomeTax.toFixed(0)} / ${filed.ctc}`);
  ok("the filed 2025 return is reproduced: total tax", near(filed.total, 59903, 5), filed.total.toFixed(0));
  const filed24 = taxEstimate({ year: 2024, filing: "hoh", businesses: [{ name: "Restaurant", net: 160736 }, { name: "Horses", net: 28983 }], children: 2 });
  ok("the filed 2024 return is reproduced: total tax", near(filed24.total, 43062, 5) && near(filed24.ctc, 4000, 1) && near(filed24.qbi, 30965, 5), `${filed24.total.toFixed(0)} / ${filed24.qbi.toFixed(0)}`);
  const low = taxEstimate({ year: 2026, filing: "single", businesses: [{ name: "A", net: 60000 }] });
  ok("below the threshold QBI is 20% of income net of half SE tax, capped at 20% of taxable income", near(low.qbi, Math.min(0.2 * (60000 - low.seTax / 2), 0.2 * (low.agi - low.deduction)), 1) && low.bracket === 0.12 && near(low.seMarginal, 0.153 * 0.9235, 0.001));
}
// 4. An entity's books, normalized, and the bridge to the return.
{
  const e = { id: "e1", name: "Ernie's", kind: "smllc" };
  const periods = [
    { entity_id: "e1", period: "2024", revenue: 726472.15, cogs: 372549.04, net_income: 57094.52, tax_net: 160736, months: 12 },
    { entity_id: "e1", period: "2025", revenue: 1304410.07, cogs: 549850.76, net_income: 109608.28, rent_related: 70500, tax_net: 114315, months: 12 },
    { entity_id: "e1", period: "2026 YTD", revenue: 992216.3, net_income: 203825.23, months: 10 },
  ];
  const adj = [
    { entity_id: "e1", period: "2024", kind: "book_tax", amount: 90000, applies_to: "tax", evidence_status: "evidenced" },
    { entity_id: "e1", period: "2024", kind: "book_tax", amount: 13641.48, applies_to: "tax", evidence_status: "proposed" },
    { entity_id: "e1", period: "2025", kind: "nonrecurring", amount: 10000, applies_to: "cash_flow", evidence_status: "approved" },
    { entity_id: "e1", period: "2025", kind: "addback", amount: 5000, applies_to: "both", evidence_status: "proposed" },
    { entity_id: "e1", period: "2025", kind: "correction", amount: -70500, applies_to: "tax", evidence_status: "evidenced" },
  ];
  const n = normalizeEntity(e, periods, adj);
  const y24 = n.periods[0], y25 = n.periods[1], ytd = n.periods[2];
  ok("the bridge is the filed figure less book net income", near(y24.gap, 103641.48, 0.01));
  ok("only evidenced adjustments explain the bridge", near(y24.explained, 90000, 0.01) && near(y24.remaining, 13641.48, 0.01));
  ok("related-party rent is added back to cash flow available for debt service", near(y25.cfads, 109608.28 + 70500 - 10000, 0.01));
  ok("proposed cash-flow adjustments are shown but not counted", near(y25.proposedCf, 5000, 0.01) && !near(y25.cfads, 109608.28 + 70500 - 10000 + 5000, 0.01));
  ok("a correction changes what should have been filed, not the bridge", y25.remaining === 4706.72 && y25.corrections === 70500 && y25.correctedTaxNet === 114315 + 70500);
  ok("a part year is annualized, and the latest full year is the recurring reference", near(ytd.cfadsAnnual, (203825.23 * 12) / 10, 0.01) && n.latest.period === "2025");
  ok("margins are worked out from the books", near(y25.grossMargin, (1304410.07 - 549850.76) / 1304410.07, 0.0001));
}
// 5. The whole model.
{
  const entities = [{ id: "e1", name: "Ernie's", kind: "smllc" }, { id: "e2", name: "Alepony", kind: "smllc", recurring_cash_flow: 20000 }];
  const periods = [
    { entity_id: "e1", period: "2025", revenue: 1304410.07, net_income: 109608.28, rent_related: 70500, tax_net: 114315, months: 12 },
    { entity_id: "e2", period: "2025", revenue: 820128.17, net_income: 137861.37, tax_net: 138521, months: 12 },
  ];
  const properties = [
    { id: "p1", label: "6982 Industrial", cost_basis: 475000, land_pct: 20, acquired: "2020-07-01", placed_in_service: "2020-07-01", use: "commercial", rent_source: "self", annual_rent: 70500, se_business: true, used_by_entity_id: "e1", market_value: 475000 },
    { id: "p2", label: "Rent house", cost_basis: 160000, land_pct: 20, acquired: "2019-01-01", placed_in_service: "2019-01-01", use: "residential", rent_source: "family", annual_rent: 12000, annual_opex: 4000, passive: true, debt_balance: 60000, annual_debt_service: 7200, market_value: 160000 },
  ];
  const components = [{ property_id: "p1", category: "p5", pct: 27 }, { property_id: "p1", category: "li15", pct: 10 }, { property_id: "p2", category: "p5", pct: 14 }];
  const inputs = [
    { key: "filing_status", unit: "text", text_value: "single", status: "confirmed" }, { key: "tax_year", unit: "count", value: 2025, status: "confirmed" }, { key: "study_year", unit: "count", value: 2026, status: "estimate" },
    { key: "living_draws", unit: "usd", value: 90000, status: "estimate" }, { key: "entity_debt_service", unit: "usd", value: 24000, status: "estimate" }, { key: "discount_rate", unit: "pct", value: 8, status: "estimate" },
  ];
  const findings = [{ severity: "critical", status: "open" }, { severity: "high", status: "resolved" }, { severity: "high", status: "in_progress" }];
  const r = calculateOwner({ entities, periods, adjustments: [], properties, components, inputs, findings });
  ok("the recurring cash flow adds every entity, using an override where given", near(r.global.cfads, 109608.28 + 70500 + 20000, 0.01));
  ok("third-party rents count net of costs; self-rent is eliminated", r.global.rentsNet === 8000 && r.global.selfRents === 70500);
  ok("existing debt service adds the properties' and the entities'", r.global.existingDs === 7200 + 24000);
  ok("tax installments count as debt service", calculateOwner({ entities, periods, properties, components, inputs: [...inputs, { key: "tax_installments", unit: "usd", value: 7176, status: "estimate" }], findings }).global.existingDs === 7200 + 24000 + 7176);
  ok("the owner's taxes and living draws come out before coverage", near(r.global.available, r.global.cfads + 8000 - r.tax.studyBase.total - 90000, 0.01) && r.global.dscr === r.global.available / r.global.existingDs);
  ok("the study-year tax falls by the usable deductions", r.seg.taxSaved > 0 && r.tax.studySeg.total < r.tax.studyBase.total);
  ok("the self-rented building's extra deduction reduces the business's own net earnings", r.tax.studySeg.seNetTotal < r.tax.studyBase.seNetTotal);
  ok("the passive rental's deduction is suspended, not saved", r.properties[1].schedule.suspended > 0 && r.properties[1].schedule.usable === 0);
  const big = calculateOwner({ entities, periods, properties: [{ ...properties[0], cost_basis: 4000000 }], components, inputs, findings });
  ok("deductions beyond the year's income carry forward as a net operating loss", big.seg.nol > 0 && near(big.seg.nol, big.seg.usable - big.tax.studyBase.before, 1) && big.tax.studySeg.total === 0 && big.seg.taxSaved === big.tax.studyBase.total);
  ok("a smaller study has no carryforward", r.seg.nol === 0);
  ok("open findings are counted by severity", r.findings.open === 2 && r.findings.critical === 1 && r.findings.high === 1);
  ok("coverage with the project uses the project model's year 2 figures", (() => { const w = calculateOwner({ entities, periods, properties, components, inputs, project: { years: [null, { ebitda: 400000, ds: 300000 }] } }).global.withProject; return w && near(w.dscr, (r.global.available + 400000) / (r.global.existingDs + 300000), 0.0001); })());
  ok("nothing is missing once the inputs are in", r.missing.length === 0, r.missing.map((m) => m.why).join("; "));
  const bare = calculateOwner({ entities, periods: [], properties: [{ id: "p3", label: "Lot", use: "commercial" }], inputs: [] });
  ok("missing figures are named by entity and property", bare.missing.some((m) => m.why.startsWith("Ernie's")) && bare.missing.some((m) => m.why.startsWith("Lot: cost basis")) && bare.global.available === null);
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} OWNER MODEL TESTS PASSED`);
if (failed.length) process.exitCode = 1;
