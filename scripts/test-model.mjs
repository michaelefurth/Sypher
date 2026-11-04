// Tests for the project model's arithmetic (assets/js/portal/model-calc.js).
//   node scripts/test-model.mjs
import { calculate, payment, sovLineValue, lineValue } from "../assets/js/portal/model-calc.js";

const results = [];
const ok = (name, cond, extra = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const input = (key, value, unit = "usd", status = "estimate") => ({ key, value: unit === "date" ? null : value, text_value: unit === "date" ? value : null, unit, status });

const sheet = { id: "s1", title: "Building and site", ohp_pct: null, building_sf: 6500 };
const sovLines = [
  { id: "a", line_status: "priced", amount: null },
  { id: "b", line_status: "priced", amount: null },
];
const budget = new Map([["a", { low: 500000, base: 600000, high: 700000 }], ["b", { low: 350000, base: 400000, high: 500000 }]]);
const lines = [
  { id: "land", grp: "land", label: "Land", base: 1000000, timing: "closing" },
  { id: "cont", grp: "allowance", label: "Contingency", calc: "pct_hard", pct_low: 4, pct_base: 5, pct_high: 7.5, timing: "construction" },
  { id: "fee", grp: "financing", label: "Loan fee", calc: "loan_fee", pct_base: 2, timing: "closing" },
  { id: "int", grp: "financing", label: "Interest during construction", calc: "interest" },
];
const base = (extra = [], over = {}) => calculate({
  model: { building_sf: 6500 }, lines, sov: { sheet, lines: sovLines, budget }, scenario: "base",
  inputs: [input("loan_ltc", 70, "pct"), input("loan_rate", 0, "pct"), input("loan_term_years", 25, "years"), input("build_months", 10, "months"), ...extra], ...over,
});

// 1. Totals, allowance on hard cost, and the loan fee that depends on the loan.
{
  const r = base();
  const expect = 2050000 / (1 - 0.7 * 0.02);
  ok("hard costs come from the pricing sheet budget", r.hard === 1000000);
  ok("contingency is a percent of hard cost", r.groups.find((g) => g.key === "allowance").total === 50000);
  ok("loan fee and total settle together", near(r.total, expect, 1), `${r.total.toFixed(2)} vs ${expect.toFixed(2)}`);
  ok("loan is the loan-to-cost share of the total", near(r.loan, 0.7 * r.total, 0.01));
  ok("equity is the rest", near(r.equity + r.loan, r.total, 0.01));
  ok("cost per SF uses the building area", near(r.perSf, r.total / 6500, 0.01));
}
// 2. Scenarios.
{
  const lo = base([], { scenario: "low" }), hi = base([], { scenario: "high" });
  ok("low scenario uses low budgets and low percents", lo.hard === 850000 && lo.groups.find((g) => g.key === "allowance").total === 34000);
  ok("high scenario uses high budgets and high percents", hi.hard === 1200000 && hi.groups.find((g) => g.key === "allowance").total === 90000);
}
// 3. Forecast: prices replace budgets as they come in; excluded scope still costs its budget.
{
  ok("an unpriced line forecasts at its budget", sovLineValue({ line_status: "priced", amount: null }, { base: 600000 }, "forecast").value === 600000);
  ok("a priced line forecasts at its price", sovLineValue({ line_status: "priced", amount: 640000 }, { base: 600000 }, "forecast").value === 640000);
  ok("excluded scope forecasts at its budget (someone still pays)", sovLineValue({ line_status: "excluded", amount: 10 }, { base: 400000 }, "forecast").value === 400000);
  ok("forecast takes the committed figure", lineValue({ base: 100, committed: 120 }, "forecast") === 120);
  ok("forecast is never below what's paid", lineValue({ base: 100, committed: 120, paid: 150 }, "forecast") === 150);
  const priced = [{ id: "a", line_status: "priced", amount: 640000 }, { id: "b", line_status: "priced", amount: null }];
  const r = calculate({ lines: [...lines, { id: "ohp", grp: "hard", label: "OH&P", calc: "ohp", pct_base: 6 }], sov: { sheet: { ...sheet, ohp_pct: 8 }, lines: priced, budget }, scenario: "forecast", inputs: [input("loan_ltc", 0, "pct")] });
  ok("forecast hard cost mixes prices and budgets", r.groups[1].items[0].value === 1040000 && r.sovPriced === 1);
  ok("contractor's own OH&P replaces the budget percent once they price", near(r.groups[1].items[1].value, 0.08 * 1040000, 0.01));
}
// 4. Interest during construction: equity first, then the loan, interest capitalized.
{
  const r = base([input("loan_rate", 12, "pct")]);
  const sched = r.schedule;
  const intLine = r.groups.find((g) => g.key === "financing").items.find((i) => i.line.calc === "interest").value;
  ok("interest during construction is worked out from the draws", intLine > 0 && near(sched.reduce((a, s) => a + s.interest, 0), intLine, 1));
  const firstLoan = sched.findIndex((s) => s.loan > 0);
  ok("equity is spent before the loan draws", firstLoan >= 0 && sched.slice(firstLoan + 1).every((s) => s.equity === 0) && near(sched.reduce((a, s) => a + s.equity, 0), r.equity, 2));
  ok("the loan balance at opening equals the loan", near(sched[sched.length - 1].balance, r.loan, 2), `${sched[sched.length - 1].balance.toFixed(2)} vs ${r.loan.toFixed(2)}`);
  ok("every dollar of cost is funded", near(sched.reduce((a, s) => a + s.equity + s.loan, 0), r.total, 2));
}
// 5. Debt service and coverage.
{
  ok("loan payment matches the standard formula", near(payment(1000000, 6, 25), 6443.01, 0.01));
  const r = base([input("loan_rate", 8, "pct"), input("revenue_full", 2400000), input("ebitda_margin", 15, "pct"), input("ramp_months", 6, "months"),
    input("existing_cash_flow", 300000), input("existing_debt_service", 60000), input("owner_draws", 120000)]);
  const y2 = r.years[1];
  ok("year 2 runs at full revenue", near(y2.revenue, 2400000, 0.01) && near(y2.ebitda, 360000, 0.01));
  ok("year 1 ramps up", r.years[0].revenue < 2400000);
  ok("project coverage is EBITDA over debt service", near(y2.dscr, 360000 / (12 * r.payment), 0.0001));
  ok("global coverage adds the existing businesses and takes out owner draws", near(y2.globalDscr, (360000 + 300000 - 120000) / (12 * r.payment + 60000), 0.0001));
  ok("nothing is missing once every input is in", r.missing.length === 0, r.missing.map((m) => m.key).join(","));
}
// 6. Honest gaps.
{
  const r = base();
  ok("coverage waits for operating inputs", r.years[1].dscr === null && r.missing.some((m) => m.key === "revenue_full"));
  const g = base([input("equity_available", 500000)]);
  ok("funding gap is equity needed less equity available", near(g.gap, g.equity - 500000, 0.01));
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} MODEL TESTS PASSED`);
if (failed.length) process.exitCode = 1;
