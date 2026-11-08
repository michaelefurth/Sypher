// The owner model, on screen. One component for Michael (admin: edits everything), the client
// (owner: reads, sets the assumptions they're asked to confirm, comments) and advisers given
// model access (viewer: the same). The arithmetic lives in owner-calc.js.
//
// Sections: the books by entity and period with the filed figures beside them; the adjustments
// that normalize cash flow and bridge book to tax; the properties with their cost segregation
// components and what a study is worth; the owner's taxes; the global cash flow and coverage
// (with the project model's new debt when linked); the assumptions; the personal section; the
// findings register; the discussion and saved versions.
//
// Two views. The summary (the client's and a lender's default) shows what is still open, the
// coverage, the taxes, the properties one line each and the findings that matter, all open.
// The working view (Michael's default) shows every section, each closed to a one-line summary
// until it is opened; a bar under the figures jumps between them. What is open is remembered
// in the browser.
import { store } from "./store.js";
import { esc, fmtDate, relTime, toast, toastNotice, confirmDialog, promptDialog, download } from "./ui.js";
import { money, parseNum } from "./sov.js";
import { calculateOwner, CATEGORIES, SEG_PRESETS, FILING, CURRENT_YEAR, bonusRate, num } from "./owner-calc.js";
import { modelSummary } from "./model.js";

const NF1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const NF2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const pct = (x, d = 1) => (x == null ? "—" : `${(d === 1 ? NF1 : NF2).format(x * 100)}%`);
const times = (x) => (x == null ? "—" : `${NF2.format(x)}×`);
const CONF = [["firm", "Firm"], ["estimate", "Estimate"], ["unknown", "Unknown"]];
const STATUS = [["confirmed", "Confirmed"], ["estimate", "Estimate"], ["unknown", "Unknown"]];
const KINDS = [["sole_prop", "Sole proprietorship"], ["smllc", "Single-member LLC"], ["partnership", "Partnership"], ["s_corp", "S corporation"], ["c_corp", "C corporation"], ["rental", "Rental activity"], ["individual", "The owner"]];
const USES = [["restaurant", "Restaurant or bar"], ["commercial", "Commercial / office"], ["warehouse", "Warehouse / industrial"], ["residential", "Residential rental"], ["equine", "Equine / agricultural"], ["mixed", "Mixed use"], ["land", "Land"], ["personal", "Personal residence"]];
const RENT = [["self", "Owner's own business (self-rent)"], ["third_party", "Third-party tenant"], ["family", "Family tenant"], ["none", "No rent"]];
const SEG = [["none", "No study"], ["estimated", "Estimated here"], ["study", "Engineering study done"]];
const ADJ_KIND = [["addback", "Add back"], ["deduction", "Deduct"], ["nonrecurring", "Non-recurring"], ["elimination", "Related-party elimination"], ["book_tax", "Book-to-tax item"], ["correction", "Correction to the return"]];
const ADJ_TO = [["cash_flow", "Cash flow"], ["tax", "Tax bridge"], ["both", "Both"]];
const EVID = [["proposed", "Proposed"], ["evidenced", "Evidenced"], ["approved", "Approved"], ["rejected", "Rejected"]];
const SEV = [["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]];
const FSTAT = [["open", "Open"], ["in_progress", "In progress"], ["resolved", "Resolved"], ["dismissed", "Dismissed"]];
const PCAT = [["marital", "Marital status"], ["agreement", "Marital agreements"], ["dependents", "Dependents"], ["residence", "Residence"], ["vehicle", "Vehicles"], ["account", "Bank and investment accounts"], ["debt", "Personal debts"], ["insurance", "Insurance"], ["retirement", "Retirement"], ["estate", "Estate documents"], ["tax", "Personal tax"], ["other", "Other"]];
const PSTAT = [["current", "Current"], ["in_progress", "In progress"], ["needed", "Needed"], ["resolved", "Resolved"]];
const UNIT_SUFFIX = { pct: "%", months: " mo", years: " yr", x: "×", sf: " SF" };
const PERIOD_FIELDS = [["revenue", "Revenue"], ["cogs", "Cost of goods sold"], ["opex", "Operating expenses"], ["other_expense", "Other expenses"], ["net_income", "Net income (books)"], ["depreciation", "Depreciation"], ["interest", "Interest"], ["rent_related", "Rent to the owner / related party"], ["owner_comp", "Owner pay expensed"], ["tax_gross", "Gross receipts (return)"], ["tax_net", "Net profit (return)"], ["cash", "Cash"], ["total_assets", "Total assets"], ["total_liabilities", "Total liabilities"]];
const PROP_NUM = [["cost_basis", "Cost basis (price plus closing costs)"], ["land_pct", "Land share %"], ["prior_depreciation", "Depreciation taken to date (if known)"], ["market_value", "Market value"], ["debt_balance", "Debt balance"], ["annual_debt_service", "Annual debt service"], ["annual_interest", "Annual interest"], ["annual_rent", "Annual rent"], ["annual_opex", "Annual taxes, insurance, repairs"]];

/** Starting assumptions and the standard forensic findings for a new owner model. */
export const OWNER_TEMPLATE = {
  inputs: [
    ["Taxes", "filing_status", "Filing status", "text", "single", "estimate", "single, mfj (married filing jointly) or hoh (head of household)."],
    ["Taxes", "tax_year", "Latest filed year", "count", CURRENT_YEAR - 1, "estimate", "The year the tax estimate is checked against the return."],
    ["Taxes", "study_year", "Cost segregation study year", "count", CURRENT_YEAR, "estimate", "The year the catch-up deduction (Form 3115) would be taken."],
    ["Taxes", "other_income", "Other income (wages, interest, other)", "usd", 0, "estimate", null],
    ["Taxes", "itemized", "Itemized deductions (if more than the standard deduction)", "usd", 0, "estimate", null],
    ["Taxes", "children", "Qualifying children under 17", "count", 0, "estimate", "For the child tax credit; phased out above $200,000 of income ($400,000 joint)."],
    ["Taxes", "passive_capacity", "Passive income available to absorb rental losses", "usd", 0, "estimate", "Net passive income plus any allowance; rental losses beyond it are suspended."],
    ["Owner", "living_draws", "Owner's required living draws", "usd", null, "unknown", "What the owner must take out each year to live, before taxes."],
    ["Owner", "entity_debt_service", "Annual debt service inside the businesses", "usd", null, "unknown", "Loans, equipment financing and card paydowns the businesses carry."],
    ["Owner", "tax_installments", "Annual payments on tax balances", "usd", 0, "estimate", "Installment agreements and unpaid balances being paid down; a lender counts them as debt."],
    ["Owner", "discount_rate", "Discount rate for the timing benefit", "pct", 8, "estimate", null],
    ["Owner", "dscr_target", "Lender's minimum coverage", "x", 1.25, "estimate", null],
  ],
  findings: [
    ["Critical", "Books", "Book net income differs from the filed return", "A gap the CPA cannot explain is the first thing an underwriter or an auditor asks about.", "Reconcile each year's book net income to the filed net profit line by line.", "General ledger, tax workpapers, bank deposits, adjusting entries", "CPA"],
    ["Critical", "Books", "Rent and other payments between the owner and the entities", "Self-rent inside a disregarded entity is ignored for federal tax; counted twice, it overstates both deductions and income.", "Trace every payment between the owner and each entity; decide draw, rent or reimbursement with evidence.", "Bank statements, leases, deeds, general ledger", "CPA"],
    ["High", "Books", "Owner compensation booked as an expense", "A sole proprietor's pay is a draw, not a deduction; a lender normalizes it either way.", "Identify owner pay in the ledger and its tax treatment.", "Payroll reports, draw ledger, W-2 or 1099 if any", "CPA"],
    ["Critical", "Books", "Balance sheets show no liabilities or fixed assets", "Incomplete books hide debt service, card balances and depreciable assets.", "Rebuild liabilities, cards, loans, fixed assets and inventory at each year end.", "Loan statements, card statements, asset invoices, AP aging", "Bookkeeper"],
    ["High", "Books", "Non-recurring revenue or expenses", "Recurring cash flow is what repays a loan; one-off sales or costs must come out.", "Classify unusual swings between years and tag them non-recurring with evidence.", "Sales records, invoices, contracts", "CPA"],
    ["High", "Books", "Expense substantiation and capital versus repair", "Large supplies, repairs and professional fees may be capital, personal or unsupported.", "Trace the largest expense accounts to invoices and decide capitalize or expense.", "Vendor ledger, receipts, contracts", "CPA"],
    ["High", "Tax", "Information returns for contractors and rent", "Missing 1099-NEC or 1099-MISC filings carry penalties and signal weak controls.", "List payees over the threshold and confirm filings.", "1099 filings, W-9s, vendor ledger", "CPA"],
    ["High", "Tax", "Balance due and account status with the IRS", "Unpaid balances, penalties and installment agreements reduce the cash available for debt.", "Pull account transcripts and payment history for each filed year.", "IRS account and wage transcripts", "CPA"],
    ["High", "Property", "Title, basis and depreciation history for each property", "Depreciation needs a cost basis, a land split and a placed-in-service date; the filed Form 4562 shows what was taken.", "Collect the closing statement, the appraisal district's land and improvement values, and prior Forms 4562.", "Closing statements, CAD records, prior returns", "CPA"],
    ["Medium", "Property", "Cost segregation and the catch-up deduction", "Reclassifying part of a building to 5, 7 and 15-year property brings deductions forward; the catch-up for prior years is taken in one year with Form 3115.", "Decide which properties justify an engineering study; estimate the benefit here first.", "Cost segregation study, Form 3115 workpapers", "CPA"],
    ["Medium", "Property", "Passive activity and family-use limits on rentals", "Rental losses are passive unless the owner is a real estate professional; below-market rent to family limits deductions.", "Test each rental for fair-market rent, personal use and the owner's participation.", "Leases, deposits, market comparables, time records", "CPA"],
    ["High", "Tax", "Entity classification and elections", "A single-member LLC is disregarded unless it elected otherwise; the treatment decides where every figure goes.", "Confirm each entity's EIN, election history and filing form.", "EIN letters, Forms 8832 and 2553, prior returns", "CPA"],
    ["High", "Tax", "Payroll and sales tax compliance", "Missed payroll or sales tax creates a liability the books do not show.", "Reconcile filed payroll and sales tax returns to the books.", "Forms 941 and 940, state sales tax filings", "Bookkeeper"],
    ["Medium", "Tax", "Qualified business income limits", "Above the threshold the 20% deduction depends on W-2 wages and the property's unadjusted basis.", "Collect W-2 wages and the basis of qualified property for each trade; consider aggregation.", "Payroll reports, fixed asset schedules", "CPA"],
    ["High", "Financing", "Global debt schedule", "Coverage is measured on every obligation the owner and the businesses carry.", "List each loan, card and lease with balance, rate, payment and maturity.", "Statements, credit report, personal financial statement", "Borrower"],
  ],
};

export async function createOwnerFromTemplate({ engagementId, title, ownerName, pmModelId, entities = [] }) {
  const m = await store.omCreateModel({ engagement_id: engagementId, title, owner_name: ownerName || null, pm_model_id: pmModelId || null });
  if (entities.length) await store.omInsert("om_entities", entities.map((e, i) => ({ model_id: m.id, engagement_id: engagementId, name: e.name, kind: e.kind || "smllc", position: i + 1 })));
  await store.omInsert("om_inputs", OWNER_TEMPLATE.inputs.map(([section, key, label, unit, value, status, hint], i) => ({
    model_id: m.id, engagement_id: engagementId, section, key, label, unit, value: unit === "text" ? null : value, text_value: unit === "text" ? value : null, status, hint, position: i + 1,
  })));
  await store.omInsert("om_findings", OWNER_TEMPLATE.findings.map(([severity, area, observation, why, test, evidence, owner], i) => ({
    model_id: m.id, engagement_id: engagementId, ref: `F${String(i + 1).padStart(2, "0")}`, severity: severity.toLowerCase(), area, observation, why, test, evidence, owner_label: owner, position: i + 1,
  })));
  return m;
}

/**
 * Mount an owner model. role: "admin" | "owner" | "viewer". people: [{ id, name }] who can be
 * asked to confirm items. projectHref: where the linked project model opens.
 */
export async function mountOwner(el, { modelId, role, me, nameOf = () => "Someone", people = [], projectHref = "#project" }) {
  const admin = role === "admin";
  let model, d, log = [], project = null, result, live = false, destroyed = false, deferred = false, thread = null;
  const timers = new Map();
  // What this person has open: the view (summary or working), the sections and property cards
  // expanded, and whether every finding is shown. Remembered in this browser, per model.
  const pref = (k, fallback) => { try { const v = localStorage.getItem(`om:${modelId}:${k}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
  const remember = (k, v) => { try { localStorage.setItem(`om:${modelId}:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } };
  let view = pref("view", admin ? "working" : "summary");
  const openSecs = new Set(pref("open", ["open"]));
  const openProps = new Set(pref("props", []));
  let allFindings = pref("allFindings", false);

  async function load() {
    model = await store.omModel(modelId);
    // The bundle, the change log and the linked project model, together in one round.
    [d, log, project] = await Promise.all([
      store.omBundle(modelId), store.omInputLog(model.engagement_id).catch(() => []),
      model.pm_model_id ? modelSummary(model.pm_model_id).then((s) => s.result).catch(() => null) : null,
    ]);
  }
  const compute = () => { result = calculateOwner({ model, ...d, project }); };
  const canSet = (i) => admin || i.owner_id === me;
  const countFor = (kind, id) => d.comments.filter((c) => c.target_kind === kind && (c.target_id || null) === (id || null)).length;
  const entityName = (id) => d.entities.find((e) => e.id === id)?.name || "—";

  /* ------------------------------------------------------------- helpers */
  const fmtIn = (v, unit) => (v == null ? "" : unit === "pct" ? NF2.format(Number(v)) : NF2.format(Number(v)));
  /** An inline field: an input for Michael, text for everyone else. t = table, id = row, f = field. */
  const field = (t, id, f, value, { kind = "num", options = null, label = "", ro = false, width = "" } = {}) => {
    if (!admin || ro) {
      if (options) return `<span class="pm-sub">${esc(options.find(([k]) => k === value)?.[1] ?? value ?? "")}</span>`;
      if (kind === "num") return `<span class="pm-num">${value == null ? "" : f.endsWith("pct") || f === "pct" ? `${NF2.format(Number(value))}%` : money(Number(value))}</span>`;
      if (kind === "bool") return `<span class="pm-sub">${value ? "Yes" : "No"}</span>`;
      return `<span class="om-text">${esc(value ?? "")}</span>`;
    }
    const a = `data-t="${t}" data-id="${esc(id)}" data-field="${f}" aria-label="${esc(label || f)}"`;
    if (options) return `<select class="pm-in pm-in--sel" ${a}>${options.map(([k, l]) => `<option value="${esc(k)}"${String(value ?? "") === String(k) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    if (kind === "bool") return `<label class="p-check om-check"><input type="checkbox" ${a}${value ? " checked" : ""}> <span>${esc(label)}</span></label>`;
    if (kind === "date") return `<input class="pm-in om-date" type="date" ${a} value="${esc(value ?? "")}">`;
    if (kind === "text") return `<input class="pm-in pm-in--label" ${a} value="${esc(value ?? "")}"${width ? ` style="width:${width}"` : ""}>`;
    if (kind === "area") return `<textarea class="pm-in om-area" rows="1" ${a}>${esc(value ?? "")}</textarea>`;
    return `<input class="pm-in pm-in--num" ${a} value="${esc(fmtIn(value))}" inputmode="decimal">`;
  };
  const talk = (kind, id, label) => {
    const n = countFor(kind, id);
    return `<button type="button" class="pm-talk${n ? " has" : ""}" data-talk="${kind}" data-target="${esc(id || "")}" data-label="${esc(label)}" aria-label="Comments on ${esc(label)}${n ? `, ${n}` : ""}">${n || ""}<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 3h12v8H6l-3 3v-3H2z"/></svg></button>`;
  };
  const del = (t, id, label) => (admin ? `<button type="button" class="sov-icon sov-icon--del" data-del="${t}" data-id="${esc(id)}" aria-label="Remove ${esc(label)}">×</button>` : "");
  /** A textarea as tall as its text (only visible ones: a hidden one measures zero). */
  const grow = (t) => { if (!t.offsetParent) return; t.style.height = "auto"; t.style.height = `${t.scrollHeight + 2}px`; };
  const growAll = (root = el) => root.querySelectorAll("textarea.om-area").forEach(grow);
  const calc = (key, text, cls = "") => `<span data-calc="${esc(key)}"${cls ? ` class="${cls}"` : ""}>${text}</span>`;

  /* -------------------------------------------------------------- pieces */
  function kpis() {
    const r = result, g = r.global;
    const fig = (label, value, sub = "", cls = "") => `<div class="pm-kpi ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const cov = g.dscr;
    return `<div class="pm-kpis" data-part="kpis">
      ${fig("Recurring cash flow", g.cfads == null ? "—" : money(g.cfads), "the businesses, before taxes and draws", "pm-kpi--lead")}
      ${fig("Available after taxes and draws", g.available == null ? "—" : money(g.available), g.draws == null ? "needs living draws" : `taxes ${money(g.taxes)} · draws ${money(g.draws)}`)}
      ${fig("Coverage of existing debt", times(cov), g.existingDs ? `${money(g.existingDs)} a year` : "no existing debt service entered", cov == null ? "" : cov >= g.target ? "is-good" : "is-bad")}
      ${fig("With the project", g.withProject ? times(g.withProject.dscr) : "—", g.withProject ? `${times(g.withProject.dscrSeg)} with the tax saved` : project ? "project model needs operating figures" : "no project model linked", g.withProject?.dscr == null ? "" : g.withProject.dscr >= g.target ? "is-good" : "is-bad")}
      ${fig("Cost segregation, year 1", money(r.seg.extra), `${money(r.seg.taxSaved)} of tax saved · ${money(r.seg.suspended)} suspended`)}
      ${fig("Unexplained book-to-tax", money(r.bridgeRemaining), `${r.findings.open} open finding${r.findings.open === 1 ? "" : "s"}${r.findings.critical ? `, ${r.findings.critical} critical` : ""}`, r.bridgeRemaining > 1000 ? "is-bad" : "")}
    </div>`;
  }

  function openItems() {
    const unknown = d.inputs.filter((i) => i.status !== "confirmed");
    const mine = unknown.filter((i) => i.owner_id === me);
    const chip = (i) => `<li><button type="button" class="pm-chip pm-chip--${esc(i.status)}" data-goto="input-${esc(i.id)}"><b>${esc(i.label)}</b><span>${esc(STATUS.find(([k]) => k === i.status)?.[1])}${i.owner_id ? ` · ${esc(i.owner_id === me ? "you" : nameOf(i.owner_id))}` : ""}</span></button></li>`;
    return `<div class="pm-open" data-part="open">
      ${mine.length ? `<p class="pm-open__mine"><b>${mine.length} for you to confirm.</b> Set the value and status; it updates the whole model, and Michael is told.</p>` : ""}
      ${unknown.length ? `<ul class="pm-chips">${unknown.map(chip).join("")}</ul>` : `<p class="pm-open__done">Every assumption is confirmed.</p>`}
      ${result.missing.length ? `<p class="p-muted">Still needed: ${result.missing.map((m) => esc(m.why)).join("; ")}.</p>` : ""}
    </div>`;
  }

  function entities() {
    const blocks = result.entities.map((en) => {
      const e = en.entity, pr = en.periods;
      const head = `<thead><tr><th scope="col">${esc(e.name)}</th>${pr.map((p) => `<th class="pm-c-num" scope="col">${esc(p.period)}${p.months < 12 ? `<span class="pm-sub">${p.months} months</span>` : ""}${admin ? `<button type="button" class="sov-icon sov-icon--del om-del-col" data-del="om_periods" data-id="${esc(d.periods.find((x) => x.entity_id === e.id && x.period === p.period)?.id)}" aria-label="Remove ${esc(p.period)}">×</button>` : ""}</th>`).join("")}</tr></thead>`;
      const rowOf = (f, label, cls = "") => `<tr class="${cls}"><th scope="row">${label}</th>${pr.map((p) => { const row = d.periods.find((x) => x.entity_id === e.id && x.period === p.period); return `<td class="pm-c-num">${field("om_periods", row.id, f, row[f], { label: `${label} ${p.period}` })}</td>`; }).join("")}</tr>`;
      const calcRow = (key, label, get, cls = "", fmt = money) => `<tr class="om-calc ${cls}"><th scope="row">${label}</th>${pr.map((p) => `<td class="pm-c-num">${calc(`${e.id}:${p.period}:${key}`, get(p) == null ? "—" : fmt(get(p)))}</td>`).join("")}</tr>`;
      const meta = admin ? `<div class="om-entity__meta">
          ${field("om_entities", e.id, "kind", e.kind, { options: KINDS, label: "Kind" })}
          <label class="om-inline">Recurring cash flow override ${field("om_entities", e.id, "recurring_cash_flow", e.recurring_cash_flow, { label: "Recurring cash flow override" })}</label>
          <label class="om-inline">W-2 wages ${field("om_entities", e.id, "w2_wages", e.w2_wages, { label: "W-2 wages" })}</label>
          <label class="om-inline">Property basis (UBIA) ${field("om_entities", e.id, "ubia", e.ubia, { label: "UBIA" })}</label>
          ${field("om_entities", e.id, "sstb", e.sstb, { kind: "bool", label: "Specified service trade" })}
          <button type="button" class="p-linkbtn" data-add-period="${esc(e.id)}">+ Add a period</button>${del("om_entities", e.id, e.name)}
        </div>` : `<p class="pm-sub">${esc(KINDS.find(([k]) => k === e.kind)?.[1] || e.kind)}${e.recurring_cash_flow != null ? ` · recurring cash flow set to ${money(Number(e.recurring_cash_flow))}` : ""}</p>`;
      return `<div class="om-entity" data-entity="${esc(e.id)}">
        <div class="p-row"><h4 class="room-sub">${admin ? field("om_entities", e.id, "name", e.name, { kind: "text", label: "Entity name", width: "18rem" }) : esc(e.name)}</h4>${talk("entity", e.id, e.name)}</div>
        ${meta}
        ${pr.length ? `<div class="pm-wrap"><table class="pm-table om-table">${head}<tbody>
          ${rowOf("revenue", "Revenue")}${rowOf("cogs", "Cost of goods sold")}
          ${calcRow("gm", "Gross margin", (p) => p.grossMargin, "", pct)}
          ${rowOf("opex", "Operating expenses")}${rowOf("other_expense", "Other expenses")}
          ${rowOf("net_income", "Net income (books)", "om-key")}
          ${rowOf("depreciation", "Depreciation")}${rowOf("interest", "Interest")}${rowOf("rent_related", "Rent to the owner / related party")}${rowOf("owner_comp", "Owner pay expensed")}
          ${calcRow("ebitda", "EBITDA", (p) => p.ebitda)}
          ${calcRow("cfads", "Cash flow available for debt service", (p) => p.cfads, "om-strong")}
          ${calcRow("cfadsA", "Annualized", (p) => (p.months < 12 ? p.cfadsAnnual : null))}
          ${calcRow("prop", "Proposed adjustments not yet counted", (p) => p.proposedCf || null)}
          ${rowOf("tax_gross", "Gross receipts on the return")}${rowOf("tax_net", "Net profit on the return", "om-key")}
          ${calcRow("gap", "Return less books", (p) => p.gap)}
          ${calcRow("explained", "Explained by evidenced items", (p) => (p.gap == null ? null : p.explained))}
          ${calcRow("remaining", "Unexplained", (p) => p.remaining, "om-strong")}
          ${calcRow("corr", "Corrections to the return (change in taxable income)", (p) => p.corrections || null)}
          ${calcRow("corrected", "Net profit as it should have been filed", (p) => (p.corrections ? p.correctedTaxNet : null))}
          ${rowOf("cash", "Cash at period end")}${rowOf("total_assets", "Total assets")}${rowOf("total_liabilities", "Total liabilities")}
          ${admin ? `<tr><th scope="row">Source</th>${pr.map((p) => { const row = d.periods.find((x) => x.entity_id === e.id && x.period === p.period); return `<td>${field("om_periods", row.id, "source", row.source, { kind: "area", label: "Source" })}${field("om_periods", row.id, "confidence", row.confidence, { options: CONF, label: "Confidence" })}</td>`; }).join("")}</tr>` : `<tr><th scope="row">Source</th>${pr.map((p) => { const row = d.periods.find((x) => x.entity_id === e.id && x.period === p.period); return `<td class="pm-sub">${esc(row.source || "")}${row.confidence !== "firm" ? ` (${row.confidence})` : ""}</td>`; }).join("")}</tr>`}
        </tbody></table></div>` : `<p class="p-muted">No periods yet.${admin ? " Add one for each year of books." : ""}</p>`}
      </div>`;
    }).join("");
    return `<div data-part="entities">${blocks || `<p class="p-muted">No entities yet.</p>`}${admin ? `<p><button type="button" class="p-linkbtn" data-add-entity>+ Add an entity</button></p>` : ""}</div>`;
  }

  function adjustments() {
    const rows = d.adjustments;
    const entOpts = [["", "Owner"], ...d.entities.map((e) => [e.id, e.name])];
    const r = (a) => `<tr class="om-adj is-${esc(a.evidence_status)}">
      <td>${field("om_adjustments", a.id, "entity_id", a.entity_id || "", { options: entOpts, label: "Entity" })}</td>
      <td>${field("om_adjustments", a.id, "period", a.period, { kind: "text", label: "Period", width: "5.5rem" })}</td>
      <td class="om-adj__item">${admin ? field("om_adjustments", a.id, "label", a.label, { kind: "area", label: "Item" }) : esc(a.label)}${a.source || admin ? `<span class="pm-sub">${admin ? field("om_adjustments", a.id, "source", a.source, { kind: "area", label: "Source" }) : esc(a.source)}</span>` : ""}</td>
      <td>${field("om_adjustments", a.id, "kind", a.kind, { options: ADJ_KIND, label: "Kind" })}</td>
      <td>${field("om_adjustments", a.id, "applies_to", a.applies_to, { options: ADJ_TO, label: "Applies to" })}</td>
      <td class="pm-c-num">${field("om_adjustments", a.id, "amount", a.amount, { label: "Amount" })}</td>
      <td>${field("om_adjustments", a.id, "evidence_status", a.evidence_status, { options: EVID, label: "Evidence" })}</td>
      <td class="pm-c-act">${talk("adjustment", a.id, a.label)}${del("om_adjustments", a.id, a.label)}</td></tr>`;
    return `<div data-part="adjustments">
      <p class="p-muted pm-note">Add-backs and deductions normalize cash flow; book-to-tax items explain the gap to the return; corrections are errors on the filed return (a deduction that should not have been taken is a negative amount) and feed the tax estimate. Only <b>evidenced</b> or <b>approved</b> items count in the figures; proposed ones are shown beside them.</p>
      ${rows.length ? `<div class="pm-wrap"><table class="pm-table om-table om-table--adj"><thead><tr><th scope="col">Entity</th><th scope="col">Period</th><th scope="col">Item</th><th scope="col">Kind</th><th scope="col">Applies to</th><th class="pm-c-num" scope="col">Amount</th><th scope="col">Evidence</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows.map(r).join("")}</tbody></table></div>` : `<p class="p-muted">No adjustments yet.</p>`}
      ${admin ? `<p><button type="button" class="p-linkbtn" data-add-adj>+ Add an adjustment</button></p>` : ""}
    </div>`;
  }

  function properties() {
    const entOpts = [["", "Not used by an entity"], ...d.entities.map((e) => [e.id, e.name])];
    const blocks = result.properties.map(({ property: p, schedule: s, noi, equity }) => {
      const comps = d.components.filter((c) => c.property_id === p.id);
      const yrs = [result.study - 1, result.study, result.study + 1, result.study + 2, result.study + 3];
      const compRow = (c) => {
        const rc = s.components.find((x) => x.id === c.id);
        const before = rc ? Object.entries(rc.sched).filter(([y]) => Number(y) < result.study).reduce((t, [, v]) => t + (v || 0), 0) : null;
        return `<tr><td class="om-comp__class">${field("om_components", c.id, "category", c.category, { options: Object.entries(CATEGORIES).map(([k, v]) => [k, v.label]), label: "Class" })}${admin ? field("om_components", c.id, "label", c.label, { kind: "area", label: "Description" }) : c.label ? `<span class="pm-sub">${esc(c.label)}</span>` : ""}</td>
          <td class="pm-c-num">${field("om_components", c.id, "pct", c.pct, { label: "Share of basis %" })}</td>
          <td class="pm-c-num">${field("om_components", c.id, "amount", c.amount, { label: "Fixed amount" })}</td>
          <td>${field("om_components", c.id, "placed_in_service", c.placed_in_service, { kind: "date", label: "Placed in service" })}</td>
          <td class="pm-c-num">${calc(`c:${c.id}:amt`, rc ? money(rc.amount) : "—")}</td>
          <td class="pm-c-num">${calc(`c:${c.id}:bonus`, rc ? pct(rc.bonus, 0) : "—")}</td>
          <td class="pm-c-num">${calc(`c:${c.id}:pre`, before == null ? "—" : money(before))}</td>
          <td class="pm-c-num">${calc(`c:${c.id}:y1`, rc ? money(rc.sched[result.study] || 0) : "—")}</td>
          <td>${field("om_components", c.id, "confidence", c.confidence, { options: CONF, label: "Confidence" })}</td>
          <td class="pm-c-act">${talk("component", c.id, c.label || CATEGORIES[c.category]?.label)}${del("om_components", c.id, c.label || "component")}</td></tr>`;
      };
      const fields = admin ? `<div class="om-prop__grid">
          <label class="om-inline">Use ${field("om_properties", p.id, "use", p.use, { options: USES, label: "Use" })}</label>
          <label class="om-inline">Rent from ${field("om_properties", p.id, "rent_source", p.rent_source, { options: RENT, label: "Rent source" })}</label>
          <label class="om-inline">Used by ${field("om_properties", p.id, "used_by_entity_id", p.used_by_entity_id || "", { options: entOpts, label: "Used by" })}</label>
          <label class="om-inline">Tenant ${field("om_properties", p.id, "tenant", p.tenant, { kind: "area", label: "Tenant" })}</label>
          <label class="om-inline">Acquired ${field("om_properties", p.id, "acquired", p.acquired, { kind: "date", label: "Acquired" })}</label>
          <label class="om-inline">Placed in service ${field("om_properties", p.id, "placed_in_service", p.placed_in_service, { kind: "date", label: "Placed in service" })}</label>
          ${PROP_NUM.map(([f, l]) => `<label class="om-inline">${l} ${field("om_properties", p.id, f, p[f], { label: l })}</label>`).join("")}
          <label class="om-inline">Recovery years ${field("om_properties", p.id, "recovery_years", p.recovery_years, { label: "Recovery years" })}</label>
          <label class="om-inline">Study ${field("om_properties", p.id, "seg_status", p.seg_status, { options: SEG, label: "Study status" })}</label>
          ${field("om_properties", p.id, "se_business", p.se_business, { kind: "bool", label: "Used in the owner's own trade (deduction against business income)" })}
          ${field("om_properties", p.id, "passive", p.passive, { kind: "bool", label: "Passive rental (losses limited)" })}
          ${field("om_properties", p.id, "bonus_elected_out", p.bonus_elected_out, { kind: "bool", label: "Elected out of bonus depreciation" })}
          <label class="om-inline om-inline--wide">Note ${field("om_properties", p.id, "note", p.note, { kind: "area", label: "Note" })}</label>
        </div>` : `<dl class="om-prop__facts">
          <div><dt>Use</dt><dd>${esc(USES.find(([k]) => k === p.use)?.[1] || p.use)}</dd></div><div><dt>Rent</dt><dd>${esc(RENT.find(([k]) => k === p.rent_source)?.[1])}${p.tenant ? ` · ${esc(p.tenant)}` : ""}</dd></div>
          <div><dt>Acquired</dt><dd>${p.acquired ? esc(fmtDate(p.acquired, { month: "short", year: "numeric" })) : "—"}</dd></div><div><dt>Cost basis</dt><dd>${p.cost_basis == null ? "—" : money(Number(p.cost_basis))}</dd></div>
          <div><dt>Market value</dt><dd>${p.market_value == null ? "—" : money(Number(p.market_value))}</dd></div><div><dt>Debt</dt><dd>${p.debt_balance == null ? "—" : money(Number(p.debt_balance))}</dd></div>
          <div><dt>Annual rent</dt><dd>${p.annual_rent == null ? "—" : money(Number(p.annual_rent))}</dd></div><div><dt>Study</dt><dd>${esc(SEG.find(([k]) => k === p.seg_status)?.[1])}</dd></div>
          ${p.note ? `<div class="om-prop__note"><dt>Note</dt><dd>${esc(p.note)}</dd></div>` : ""}
        </dl>`;
      const strip = `<div class="om-strip">
          <div><span>Depreciable basis</span><b>${calc(`p:${p.id}:dep`, money(s.depreciable))}</b><small>land ${calc(`p:${p.id}:land`, money(s.landValue))}</small></div>
          <div><span>Reclassified</span><b>${calc(`p:${p.id}:re`, money(s.reclass))}</b><small>${calc(`p:${p.id}:repct`, pct(s.reclassPct))} of the basis</small></div>
          <div><span>Catch-up (Form 3115)</span><b>${calc(`p:${p.id}:cu`, money(s.catchUp))}</b><small>taken ${calc(`p:${p.id}:taken`, money(s.allowedAsFiled))} · allowable ${calc(`p:${p.id}:allow`, money(s.allowableWithSeg))}</small></div>
          <div><span>Extra deduction, ${result.study}</span><b>${calc(`p:${p.id}:ex`, money(s.extra))}</b><small>${p.passive ? `${calc(`p:${p.id}:sus`, money(s.suspended))} suspended (passive)` : "against business income"}</small></div>
          <div><span>Tax saved, year 1</span><b>${calc(`p:${p.id}:sv`, money(s.savingsYear1))}</b><small>at ${calc(`p:${p.id}:rate`, pct(s.effRate))}</small></div>
          <div><span>Timing benefit (PV)</span><b>${calc(`p:${p.id}:npv`, s.npv == null ? "—" : money(s.npv))}</b><small>net rent ${calc(`p:${p.id}:noi`, money(noi))} · equity ${calc(`p:${p.id}:eq`, money(equity))}</small></div>
        </div>`;
      const sched = `<details class="pm-months"><summary class="p-linkbtn">Depreciation by year, as filed and with the study</summary><div class="pm-wrap"><table class="pm-table pm-table--years"><thead><tr><th scope="col"></th>${yrs.map((y) => `<th class="pm-c-num" scope="col">${y}</th>`).join("")}</tr></thead><tbody>
          <tr><th scope="row">As filed (straight line)</th>${yrs.map((y) => `<td class="pm-c-num">${calc(`p:${p.id}:f${y}`, money(s.asFiled[y] || 0))}</td>`).join("")}</tr>
          <tr><th scope="row">With the study</th>${yrs.map((y) => `<td class="pm-c-num">${calc(`p:${p.id}:s${y}`, money((s.withSeg[y] || 0) + (y === result.study ? s.catchUp : 0)))}</td>`).join("")}</tr>
        </tbody></table></div><p class="p-muted pm-note">The study year includes the catch-up. Bonus depreciation follows the year each component was placed in service (100% for property acquired after January 19, 2025; 60% in 2024; 80% in 2023; 100% from late 2017 through 2022). Half-year convention; mid-month for the building.</p></details>`;
      const presets = admin ? `<span class="om-presets">Apply a typical split: ${Object.entries(SEG_PRESETS).map(([k, v]) => `<button type="button" class="p-linkbtn" data-preset="${k}" data-prop="${esc(p.id)}">${esc(v.label)}</button>`).join(" ")}</span>` : "";
      const line = `<span class="om-prop__line">${s.missing.length ? `needs ${s.missing.map(esc).join(", ")}` : `${USES.find(([k]) => k === p.use)?.[1] || ""} · extra deduction ${calc(`p:${p.id}:lx`, money(s.extra))} in ${result.study} · tax saved ${calc(`p:${p.id}:ls`, money(s.savingsYear1))}${p.passive ? ` · ${calc(`p:${p.id}:lsus`, money(s.suspended))} suspended` : ""}`}</span>`;
      const address = p.address ? `<span class="pm-sub">${esc(p.address)}</span>` : "";
      if (view === "summary") return `<div class="om-prop om-prop--line" data-prop="${esc(p.id)}"><div class="om-prop__head"><h4 class="room-sub">${esc(p.label)}${address}</h4>${line}<span class="om-prop__acts">${talk("property", p.id, p.label)}</span></div></div>`;
      const open = openProps.has(p.id);
      return `<div class="om-prop${open ? " is-open" : ""}" data-prop="${esc(p.id)}">
        <div class="om-prop__head" data-prop-head="${esc(p.id)}"><button type="button" class="om-toggle" data-prop-toggle="${esc(p.id)}" aria-expanded="${open}" aria-controls="om-p-${esc(p.id)}" aria-label="${open ? "Hide" : "Show"} the detail of ${esc(p.label)}"><span class="om-chev" aria-hidden="true"></span></button><h4 class="room-sub">${admin ? field("om_properties", p.id, "label", p.label, { kind: "text", label: "Property", width: "min(34rem, 70vw)" }) : esc(p.label)}${address}</h4>${line}<span class="om-prop__acts">${talk("property", p.id, p.label)}${del("om_properties", p.id, p.label)}</span></div>
        <div class="om-prop__body" id="om-p-${esc(p.id)}"${open ? "" : " hidden"}>
        ${fields}
        ${s.missing.length ? `<p class="pm-open__mine">Needed before depreciation can be shown: ${s.missing.map(esc).join(", ")}.</p>` : ""}
        ${strip}
        <div class="p-row"><h5 class="om-h5">Cost segregation components</h5>${presets}</div>
        ${comps.length ? `<div class="pm-wrap"><table class="pm-table om-table om-table--comp"><thead><tr><th scope="col">Class</th><th class="pm-c-num" scope="col">Share of basis</th><th class="pm-c-num" scope="col">Or amount</th><th scope="col">Placed in service</th><th class="pm-c-num" scope="col">Basis</th><th class="pm-c-num" scope="col">Bonus</th><th class="pm-c-num" scope="col">Allowable through ${result.study - 1}<span class="pm-sub">the catch-up</span></th><th class="pm-c-num" scope="col">${result.study} deduction<span class="pm-sub">regular</span></th><th scope="col">Confidence</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${comps.map(compRow).join("")}</tbody></table></div>` : `<p class="p-muted">No components yet: the whole building depreciates straight line.${admin ? " Apply a typical split or add a component." : ""}</p>`}
        ${admin ? `<p><button type="button" class="p-linkbtn" data-add-comp="${esc(p.id)}">+ Add a component</button></p>` : ""}
        ${sched}
        </div>
      </div>`;
    }).join("");
    return `<div data-part="properties">${view === "summary" ? "" : `<p class="p-muted pm-note">Each property on one line; open it for the facts, the cost segregation components and the depreciation by year.</p>`}${blocks || `<p class="p-muted">No properties yet.</p>`}${admin && view !== "summary" ? `<p><button type="button" class="p-linkbtn" data-add-prop>+ Add a property</button></p>` : ""}
      ${result.properties.length ? `<div class="om-strip om-strip--total"><div><span>All properties: extra deduction</span><b>${calc("seg:extra", money(result.seg.extra))}</b></div><div><span>Catch-up</span><b>${calc("seg:cu", money(result.seg.catchUp))}</b></div><div><span>Suspended</span><b>${calc("seg:sus", money(result.seg.suspended))}</b></div><div><span>Tax saved in ${result.study}</span><b>${calc("seg:tax", money(result.seg.taxSaved))}</b><small>from the full tax estimate</small></div><div><span>Timing benefit (PV)</span><b>${calc("seg:npv", money(result.seg.npv))}</b></div></div>` : ""}
    </div>`;
  }

  function taxes() {
    const t = result.tax;
    const col = (x) => [money(x.seNetTotal), money(x.seTax), money(x.agi), money(x.deduction), money(x.qbi) + (x.qbiLimited ? " (limited)" : ""), money(x.taxable), money(x.incomeTax), money(-x.ctc), money(x.niit), money(x.total), pct(x.bracket, 0), pct(x.effective)];
    const labels = ["Net earnings from the trades", "Self-employment tax", "Adjusted gross income", "Deduction (standard or itemized)", "Qualified business income deduction", "Taxable income", "Income tax", "Child tax credit", "Net investment income tax", "Total federal tax", "Marginal bracket", "Effective rate on AGI"];
    const cols = [[`${t.focus.year} (filed year)`, t.focus], [`${t.studyBase.year} before the study`, t.studyBase], [`${t.studyBase.year} with the study`, t.studySeg]];
    return `<div data-part="taxes"><div class="pm-wrap"><table class="pm-table pm-table--years"><thead><tr><th scope="col"></th>${cols.map(([h]) => `<th class="pm-c-num" scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>
      ${labels.map((l, i) => `<tr class="${i === 9 ? "pm-total" : ""}"><th scope="row">${l}</th>${cols.map(([, x]) => `<td class="pm-c-num">${col(x)[i]}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>
    <p class="p-muted pm-note">Filing as ${esc(FILING.find(([k]) => k === result.filing)?.[1] || result.filing)}. The study year uses the latest full year's figures for each trade unless that year's books are in. Federal only: Texas has no individual income tax, and the franchise tax applies above the no-tax-due threshold. These are estimates to size decisions, not a return.</p></div>`;
  }

  function global() {
    const g = result.global;
    const row = (l, v, cls = "") => `<tr class="${cls}"><td>${l}</td><td class="pm-c-num">${v == null ? "—" : money(v)}</td></tr>`;
    return `<div data-part="global"><div class="pm-su">
      <table class="pm-mini"><caption>Recurring cash flow</caption><tbody>
        ${result.entities.map((en) => row(esc(en.entity.name), en.recurring ?? en.latest?.cfadsAnnual ?? null)).join("")}
        ${row("Third-party rents, net of costs", g.rentsNet)}
        ${row("Less: income and self-employment taxes", -g.taxes)}
        ${row("Less: owner's living draws", g.draws == null ? null : -g.draws)}
        ${row("Available for debt service", g.available, "pm-total")}
      </tbody></table>
      <table class="pm-mini"><caption>Debt service and coverage</caption><tbody>
        ${row("Properties", g.propertyDs)}${row("Inside the businesses", result.inputs.entity_debt_service)}${g.taxDs ? row("Tax balances", g.taxDs) : ""}
        ${row("Existing debt service", g.existingDs, "pm-total")}
        <tr><td>Coverage of existing debt</td><td class="pm-c-num ${g.dscr == null ? "" : g.dscr >= g.target ? "is-under" : "is-over"}">${times(g.dscr)}</td></tr>
        ${g.withProject ? `${row("Project cash flow (year 2)", g.withProject.cfads)}${row("Project debt service (year 2)", g.withProject.ds)}<tr><td>Coverage with the project</td><td class="pm-c-num ${g.withProject.dscr >= g.target ? "is-under" : "is-over"}">${times(g.withProject.dscr)}</td></tr><tr><td>…with the cost segregation tax saved</td><td class="pm-c-num ${g.withProject.dscrSeg >= g.target ? "is-under" : "is-over"}">${times(g.withProject.dscrSeg)}</td></tr>` : ""}
      </tbody></table>
      <div class="pm-su__note"><p>Self-rent of <b>${money(g.selfRents)}</b> between the owner and the businesses is eliminated: it is the same cash counted once.</p>
        <p class="p-muted">Lender's minimum ${times(g.target)}. ${project ? `The project figures come from the linked project model.` : model.pm_model_id ? "The project model has no operating figures yet." : "Link a project model in the settings to see coverage with the new debt."}</p>
        ${admin && model.pm_model_id && g.cfads != null ? `<p><button type="button" class="btn btn--ghost btn--sm" data-send-project>Send these figures to the project model</button><br><span class="pm-sub">Sets its existing cash flow, existing debt service and owner draws as estimates.</span></p>` : ""}
      </div>
    </div></div>`;
  }

  function assumptions() {
    const sections = [...new Set(d.inputs.map((i) => i.section))];
    const lastBy = new Map();
    for (const e of log) if (!lastBy.has(e.input_id)) lastBy.set(e.input_id, e);
    const shown = (i) => (i.unit === "text" ? esc(i.text_value || "—") : i.value == null ? "—" : i.unit === "usd" ? money(Number(i.value)) : i.unit === "count" ? String(Number(i.value)) : `${NF2.format(Number(i.value))}${UNIT_SUFFIX[i.unit] || ""}`);
    return `<div data-part="inputs">${sections.map((sec) => `<div class="pm-sec"><h4 class="room-sub">${esc(sec)}</h4><ul class="pm-inputs">${d.inputs.filter((i) => i.section === sec).map((i) => {
      const e = lastBy.get(i.id), can = canSet(i);
      const valueField = can
        ? (i.key === "filing_status"
          ? `<span class="pm-val"><select class="pm-in pm-in--sel pm-in--val" id="input-${esc(i.id)}" data-input="${esc(i.id)}" data-field="value" aria-label="${esc(i.label)}">${FILING.map(([k, t]) => `<option value="${k}"${(i.text_value || "single") === k ? " selected" : ""}>${t}</option>`).join("")}</select></span>`
          : `<span class="pm-val"><input class="pm-in pm-in--val" id="input-${esc(i.id)}" data-input="${esc(i.id)}" data-field="value" value="${esc(i.unit === "text" ? i.text_value || "" : i.value == null ? "" : i.unit === "count" ? String(Number(i.value)) : NF2.format(Number(i.value)))}" ${i.unit === "text" ? "" : 'inputmode="decimal"'} aria-label="${esc(i.label)}">${UNIT_SUFFIX[i.unit] ? `<em>${UNIT_SUFFIX[i.unit].trim()}</em>` : ""}</span>`)
        : `<span class="pm-val pm-val--ro" id="input-${esc(i.id)}" tabindex="-1">${shown(i)}</span>`;
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
    }).join("")}</ul></div>`).join("")}</div>`;
  }

  function findings() {
    const all = [...d.findings].sort((a, b) => SEV.findIndex(([k]) => k === a.severity) - SEV.findIndex(([k]) => k === b.severity) || a.position - b.position);
    const lead = all.filter((f) => (f.severity === "critical" && f.status !== "resolved" && f.status !== "dismissed") || (f.owner_id === me && f.status !== "resolved"));
    const list = allFindings || !lead.length ? all : lead;
    const hidden = all.length - list.length;
    const entOpts = [["", "—"], ...d.entities.map((e) => [e.id, e.name])];
    const item = (f) => `<li class="om-finding is-${esc(f.status)} sev-${esc(f.severity)}" id="finding-${esc(f.id)}">
      <div class="om-finding__head">
        <span class="om-finding__ref">${esc(f.ref || "")}</span>
        ${admin ? field("om_findings", f.id, "severity", f.severity, { options: SEV, label: "Severity" }) : `<span class="om-sev om-sev--${esc(f.severity)}">${esc(SEV.find(([k]) => k === f.severity)?.[1])}</span>`}
        ${admin ? field("om_findings", f.id, "area", f.area, { kind: "text", label: "Area", width: "7rem" }) : `<span class="pm-sub">${esc(f.area || "")}</span>`}
        ${admin ? field("om_findings", f.id, "entity_id", f.entity_id || "", { options: entOpts, label: "Entity" }) : f.entity_id ? `<span class="pm-sub">${esc(entityName(f.entity_id))}</span>` : ""}
        ${admin ? field("om_findings", f.id, "period", f.period, { kind: "text", label: "Period", width: "8rem" }) : f.period ? `<span class="pm-sub">${esc(f.period)}</span>` : ""}
        ${admin ? field("om_findings", f.id, "status", f.status, { options: FSTAT, label: "Status" }) : `<span class="pm-st pm-st--${f.status === "resolved" ? "confirmed" : f.status === "in_progress" ? "estimate" : "unknown"}">${esc(FSTAT.find(([k]) => k === f.status)?.[1])}</span>`}
        <span class="om-finding__who">${admin ? `<select class="pm-in pm-in--sel" data-t="om_findings" data-id="${esc(f.id)}" data-field="owner_id" aria-label="Who resolves"><option value="">${esc(f.owner_label || "Unassigned")}</option>${people.map((p) => `<option value="${esc(p.id)}"${f.owner_id === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>${f.owner_id && f.status !== "resolved" ? `<button type="button" class="p-linkbtn" data-ask-finding="${esc(f.id)}">Ask</button>` : ""}` : `<span class="pm-sub">${f.owner_id ? `${esc(f.owner_id === me ? "You" : nameOf(f.owner_id))}` : esc(f.owner_label || "")}</span>`}</span>
        ${talk("finding", f.id, `${f.ref ? `${f.ref}: ` : ""}${f.observation.slice(0, 60)}`)}${del("om_findings", f.id, f.ref || "finding")}
      </div>
      ${admin ? `<div class="om-finding__body">
        <label>Observation ${field("om_findings", f.id, "observation", f.observation, { kind: "area", label: "Observation" })}</label>
        <label>Why it matters ${field("om_findings", f.id, "why", f.why, { kind: "area", label: "Why it matters" })}</label>
        <label>Test ${field("om_findings", f.id, "test", f.test, { kind: "area", label: "Test" })}</label>
        <label>Evidence needed ${field("om_findings", f.id, "evidence", f.evidence, { kind: "area", label: "Evidence needed" })}</label>
        <label class="om-finding__res">Resolution ${field("om_findings", f.id, "resolution", f.resolution, { kind: "area", label: "Resolution" })}</label>
      </div>` : `<div class="om-finding__body om-finding__body--ro">
        <p><b>${esc(f.observation)}</b></p>${view === "summary" && (f.why || f.test || f.evidence || f.resolution) ? `<details class="om-finding__more"><summary class="p-linkbtn">Why it matters, the test and the evidence</summary>` : ""}${f.why ? `<p><span class="om-lbl">Why it matters</span> ${esc(f.why)}</p>` : ""}${f.test ? `<p><span class="om-lbl">Test</span> ${esc(f.test)}</p>` : ""}${f.evidence ? `<p><span class="om-lbl">Evidence needed</span> ${esc(f.evidence)}</p>` : ""}${f.resolution ? `<p><span class="om-lbl">Resolution</span> ${esc(f.resolution)}</p>` : ""}${view === "summary" && (f.why || f.test || f.evidence || f.resolution) ? "</details>" : ""}
      </div>`}
    </li>`;
    return `<div data-part="findings"><p class="p-muted pm-note">${result.findings.open} open of ${result.findings.total}. Each finding names what was observed, why it matters, the test, the evidence needed and who resolves it. ${admin ? "Assign someone and press Ask: they get a request." : "Comment on any finding; the person assigned gets a request."}</p>
      ${hidden ? `<p class="pm-sub">Showing the critical findings${lead.some((f) => f.owner_id === me) ? " and the ones assigned to you" : ""}: ${list.length} of ${all.length}.</p>` : ""}
      <ol class="om-findings">${list.map(item).join("")}</ol>
      <p class="om-findings__more">${hidden ? `<button type="button" class="btn btn--ghost btn--sm" data-all-findings="1">Show all ${all.length} findings</button>` : lead.length && lead.length < all.length ? `<button type="button" class="p-linkbtn" data-all-findings="0">Show the critical ones only</button>` : ""}${admin ? ` <button type="button" class="p-linkbtn" data-add-finding>+ Add a finding</button>` : ""}</p></div>`;
  }

  function personal() {
    const items = d.personal || [];
    const groups = PCAT.filter(([k]) => items.some((i) => i.category === k));
    const money0 = (v) => (v == null ? "—" : money(Number(v)));
    const row = (i) => `<tr class="om-pers is-${esc(i.status)}">
      <td>${admin ? field("om_personal", i.id, "label", i.label, { kind: "area", label: "Item" }) : `<b>${esc(i.label)}</b>`}${admin ? field("om_personal", i.id, "detail", i.detail, { kind: "area", label: "Detail" }) : i.detail ? `<span class="om-text om-pers__detail">${esc(i.detail)}</span>` : ""}${admin ? field("om_personal", i.id, "note", i.note, { kind: "area", label: "Note" }) : i.note ? `<span class="pm-sub">${esc(i.note)}</span>` : ""}</td>
      <td class="pm-c-num">${field("om_personal", i.id, "amount", i.amount, { label: "Value" })}</td>
      <td class="pm-c-num">${field("om_personal", i.id, "liability", i.liability, { label: "Owed" })}</td>
      <td>${field("om_personal", i.id, "as_of", i.as_of, { kind: "date", label: "As of" })}</td>
      <td>${admin ? field("om_personal", i.id, "status", i.status, { options: PSTAT, label: "Status" }) : `<span class="pm-st pm-st--${i.status === "resolved" || i.status === "current" ? "confirmed" : i.status === "in_progress" ? "estimate" : "unknown"}">${esc(PSTAT.find(([k]) => k === i.status)?.[1])}</span>`}</td>
      <td>${admin ? field("om_personal", i.id, "owner_label", i.owner_label, { kind: "text", label: "Who", width: "7rem" }) : `<span class="pm-sub">${esc(i.owner_label || "")}</span>`}</td>
      <td class="pm-c-act">${talk("model", null, i.label)}${del("om_personal", i.id, i.label)}</td></tr>`;
    const totals = { value: items.reduce((a, i) => a + (num(i.amount) || 0), 0), owed: items.reduce((a, i) => a + (num(i.liability) || 0), 0) };
    const needed = items.filter((i) => i.status === "needed").length;
    return `<div data-part="personal">
      <p class="p-muted pm-note">The owner as a person, beside the businesses: marital status and agreements, dependents, accounts, personal debts, insurance, retirement and estate documents. A lender reads these with the global cash flow; a marital agreement decides what the owner actually owns.${needed ? ` <b>${needed} item${needed > 1 ? "s" : ""} needed.</b>` : ""}</p>
      ${items.length ? `<div class="pm-wrap"><table class="pm-table om-table om-table--pers"><thead><tr><th scope="col">Item</th><th class="pm-c-num" scope="col">Value</th><th class="pm-c-num" scope="col">Owed</th><th scope="col">As of</th><th scope="col">Status</th><th scope="col">Who</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        ${groups.map(([k, label]) => `<tbody><tr class="pm-grp"><th scope="colgroup" colspan="7">${esc(label)}</th></tr>${items.filter((i) => i.category === k).map(row).join("")}</tbody>`).join("")}
        <tbody><tr class="pm-total"><th scope="row">Personal items listed</th><td class="pm-c-num">${money0(totals.value)}</td><td class="pm-c-num">${money0(totals.owed)}</td><td colspan="4"></td></tr></tbody></table></div>` : `<p class="p-muted">Nothing recorded yet.</p>`}
      ${admin ? `<p><span class="om-presets">Add: ${PCAT.map(([k, l]) => `<button type="button" class="p-linkbtn" data-add-personal="${k}">${esc(l)}</button>`).join(" ")}</span></p>` : ""}
    </div>`;
  }

  function discussion() {
    const recent = d.comments.slice(-4).reverse();
    return `<div class="pm-foot" data-part="discussion">
      <div><h4 class="room-sub">Discussion</h4>${recent.length ? `<ul class="pm-recent">${recent.map((c) => `<li><b>${esc(c.author_id === me ? "You" : nameOf(c.author_id))}</b>${c.target_label ? ` on <button type="button" class="p-linkbtn pm-recent__on" data-talk="${esc(c.target_kind)}" data-target="${esc(c.target_id || "")}" data-label="${esc(c.target_label)}">${esc(c.target_label)}</button>` : ""}: ${esc(c.body.length > 140 ? `${c.body.slice(0, 140)}…` : c.body)} <span class="p-muted">${esc(relTime(c.created_at))}</span></li>`).join("")}</ul>` : `<p class="p-muted">Comment on any figure, property or finding with the speech-bubble button.</p>`}
        ${talk("model", null, "The model")}</div>
      <div><h4 class="room-sub">Versions</h4>${d.snapshots.length ? `<ul class="pm-recent">${d.snapshots.slice(0, 6).map((s) => `<li><b>${esc(s.label)}</b> · ${esc(fmtDate(s.created_at, { month: "short", day: "numeric", year: "numeric" }))} <button type="button" class="p-linkbtn" data-snap-csv="${esc(s.id)}">CSV</button></li>`).join("")}</ul>` : `<p class="p-muted">Save a dated copy before sending figures to the lender or the CPA: the button is in the header.</p>`}</div>
    </div>`;
  }

  /* ------------------------------------------------------------ sections */
  // Each section has a one-line summary that stands for it when it is closed. The summary view
  // shows the five sections a client or a lender reads, open; the working view shows them all.
  const SECTIONS = [
    ["open", "Still open", openItems], ["entities", "The books, by entity", entities], ["adjustments", "Adjustments and the book-to-tax bridge", adjustments],
    ["properties", "Properties and cost segregation", properties], ["taxes", "The owner's taxes", taxes], ["global", "Global cash flow and coverage", global],
    ["inputs", "Assumptions", assumptions], ["personal", "Personal and marital", personal], ["findings", "Findings", findings], ["discussion", "Discussion and versions", discussion],
  ];
  const SHORT = { open: "Open", entities: "Books", adjustments: "Adjustments", properties: "Properties", taxes: "Taxes", global: "Coverage", inputs: "Assumptions", personal: "Personal", findings: "Findings", discussion: "Discussion" };
  const SUMMARY_SECTIONS = ["open", "global", "taxes", "properties", "findings"];
  const sectionsShown = () => (view === "summary" ? SECTIONS.filter(([k]) => SUMMARY_SECTIONS.includes(k)) : SECTIONS);
  function sectionSummary(key) {
    const r = result, g = r.global, n = (x) => (x == null ? "—" : money(x)), plural = (c, w) => `${c} ${w}${c === 1 ? "" : "s"}`;
    const mineInputs = d.inputs.filter((i) => i.owner_id === me && i.status !== "confirmed").length;
    const mineFindings = d.findings.filter((f) => f.owner_id === me && f.status !== "resolved").length;
    switch (key) {
      case "open": return `${d.inputs.filter((i) => i.status === "confirmed").length} of ${d.inputs.length} assumptions confirmed${mineInputs ? ` · <b>${mineInputs} for you</b>` : ""}${r.missing.length ? ` · ${plural(r.missing.length, "figure")} still needed` : ""}`;
      case "entities": return r.entities.map((en) => `${esc(en.entity.name)} ${n(en.recurring ?? en.latest?.cfadsAnnual)}`).join(" · ") || "No entities yet";
      case "adjustments": { const ev = d.adjustments.filter((a) => ["evidenced", "approved"].includes(a.evidence_status)).length, pr = d.adjustments.filter((a) => a.evidence_status === "proposed").length; return `${plural(d.adjustments.length, "item")} · ${ev} evidenced · ${pr} proposed · unexplained ${r.bridgeRemaining > 1 ? n(r.bridgeRemaining) : "none"}`; }
      case "properties": return `${r.properties.length} propert${r.properties.length === 1 ? "y" : "ies"} · ${n(r.seg.usable)} usable in ${r.study}${r.seg.suspended ? ` (${n(r.seg.suspended)} suspended)` : ""} · ${n(r.seg.taxSaved)} of tax saved`;
      case "taxes": return `${r.tax.focus.year} estimate ${n(r.tax.focus.total)} · ${r.tax.studyBase.year}: ${n(r.tax.studyBase.total)} before the study, ${n(r.tax.studySeg.total)} with it`;
      case "global": return `Coverage ${times(g.dscr)} against ${times(g.target)}${g.withProject ? ` · with the project ${times(g.withProject.dscr)}` : ""}`;
      case "inputs": return `${d.inputs.filter((i) => i.status === "confirmed").length} of ${d.inputs.length} confirmed${mineInputs ? ` · <b>${mineInputs} for you</b>` : ""}`;
      case "personal": { const items = d.personal || [], needed = items.filter((i) => i.status === "needed").length; return `${plural(items.length, "item")}${needed ? ` · <b>${needed} needed</b>` : ""}`; }
      case "findings": return `${r.findings.open} open of ${r.findings.total}${r.findings.critical ? ` · ${r.findings.critical} critical` : ""}${mineFindings ? ` · <b>${mineFindings} for you</b>` : ""}`;
      case "discussion": return `${plural(d.comments.length, "comment")} · ${plural(d.snapshots.length, "version")}`;
      default: return "";
    }
  }
  function section([key, label, body]) {
    const open = view === "summary" || openSecs.has(key);
    const fixed = view === "summary";
    return `<section class="pm-part om-sec${open ? " is-open" : ""}${fixed ? " is-fixed" : ""}" id="om-s-${key}" data-sec="${key}">
      <div class="om-sec__head"${fixed ? "" : ` data-sec-head="${key}"`}>${fixed ? "" : `<button type="button" class="om-toggle" data-toggle="${key}" aria-expanded="${open}" aria-controls="om-b-${key}" aria-label="${open ? "Close" : "Open"} ${esc(label)}"><span class="om-chev" aria-hidden="true"></span></button>`}<h3 class="pm-h">${label}</h3><span class="om-sec__sum" data-sec-sum="${key}">${sectionSummary(key)}</span></div>
      <div class="om-sec__body" id="om-b-${key}"${open ? "" : " hidden"}>${body()}</div>
    </section>`;
  }
  function bar() {
    return `<nav class="om-bar" aria-label="Sections of the model"><div class="om-bar__inner">
      <div class="om-bar__links">${sectionsShown().map(([k]) => `<button type="button" data-jump="${k}">${SHORT[k]}</button>`).join("")}</div>
      <div class="pm-scen om-view" role="radiogroup" aria-label="View"><button type="button" role="radio" aria-checked="${view === "summary"}" data-view="summary">Summary</button><button type="button" role="radio" aria-checked="${view === "working"}" data-view="working">Working</button></div>
    </div></nav>`;
  }
  /** Which section is under the bar; the bar's link for it is marked. */
  function markCurrent() {
    const barEl = el.querySelector(".om-bar");
    if (!barEl) return;
    const bottom = barEl.getBoundingClientRect().bottom + 8;
    let current = null;
    for (const sec of el.querySelectorAll(".om-sec")) if (sec.getBoundingClientRect().top <= bottom) current = sec.dataset.sec;
    for (const b of barEl.querySelectorAll("[data-jump]")) b.classList.toggle("is-current", b.dataset.jump === current);
  }
  function setSection(key, open) {
    const sec = el.querySelector(`#om-s-${key}`);
    if (!sec) return;
    sec.classList.toggle("is-open", open);
    const body = sec.querySelector(".om-sec__body"); if (body) body.hidden = !open;
    const t = sec.querySelector("[data-toggle]"); if (t) { t.setAttribute("aria-expanded", String(open)); t.setAttribute("aria-label", `${open ? "Close" : "Open"} ${t.getAttribute("aria-label").replace(/^(Open|Close) /, "")}`); }
    if (open) { openSecs.add(key); growAll(sec); } else openSecs.delete(key);
    remember("open", [...openSecs]);
  }
  function setProp(id, open) {
    const card = el.querySelector(`.om-prop[data-prop="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.toggle("is-open", open);
    const body = card.querySelector(".om-prop__body"); if (body) body.hidden = !open;
    const t = card.querySelector("[data-prop-toggle]"); if (t) { t.setAttribute("aria-expanded", String(open)); t.setAttribute("aria-label", t.getAttribute("aria-label").replace(/^(Show|Hide)/, open ? "Hide" : "Show")); }
    if (open) { openProps.add(id); growAll(card); } else openProps.delete(id);
    remember("props", [...openProps]);
  }

  function commentsPanel() {
    if (!thread) return "";
    const list = d.comments.filter((c) => c.target_kind === thread.kind && (c.target_id || null) === (thread.id || null));
    return `<aside class="pm-thread" role="dialog" aria-label="Comments on ${esc(thread.label)}">
      <div class="pm-thread__head"><h3>${esc(thread.label)}</h3><button type="button" class="p-drawer__close" data-close-thread aria-label="Close comments">×</button></div>
      <ol class="pm-thread__list">${list.length ? list.map((c) => `<li><p class="pm-thread__who"><b>${esc(c.author_id === me ? "You" : nameOf(c.author_id))}</b> · ${esc(relTime(c.created_at))}${c.author_id === me ? ` <button type="button" class="p-linkbtn" data-del-comment="${esc(c.id)}">Delete</button>` : ""}</p><p>${esc(c.body)}</p></li>`).join("") : `<li class="p-muted">No comments yet. Questions, sources and caveats go here, beside the figure they're about.</li>`}</ol>
      <form class="pm-thread__form" data-comment-form><label class="visually-hidden" for="om-comment">Comment</label><textarea class="p-textarea" id="om-comment" rows="3" maxlength="4000" required placeholder="Add a comment for Michael${role === "admin" ? ", the client" : ""} and the team…"></textarea><button class="btn btn--navy btn--sm" type="submit">Comment</button></form>
    </aside>`;
  }

  function render() {
    compute();
    const header = document.getElementById("p-header");
    if (header) document.documentElement.style.setProperty("--p-header-h", `${header.offsetHeight}px`);
    el.innerHTML = `<div class="pm om om--${view}">
      <header class="pm-head">
        <div class="sov-print-brand" aria-hidden="true"><img src="../assets/img/sypher-mark-sm.webp" alt="" width="46" height="48"><span>SYPHER <small>Solutions</small></span></div>
        <div class="pm-head__row"><div><p class="p-kicker">Owner model</p><h2 class="sov-title">${esc(model.title)}</h2>
          <p class="p-muted">${esc(model.owner_name ? `${model.owner_name}: ` : "")}the businesses, the properties and the taxes, normalized the way a lender and a CPA read them. Updated ${esc(relTime(model.updated_at))}.</p></div>
          <div class="pm-head__side">${model.pm_model_id ? `<a class="p-linkbtn" href="${esc(projectHref)}">Project model</a>` : ""}${role !== "viewer" ? `<button type="button" class="p-linkbtn" data-snapshot>Save a version</button>` : ""}<button type="button" class="p-linkbtn" data-csv>CSV</button><button type="button" class="p-linkbtn" data-print>Print</button><span class="sov-live${live ? " is-on" : ""}" data-live>${live ? "Live" : "Connecting…"}</span></div></div>
        ${kpis()}
      </header>
      ${bar()}
      ${view === "summary" ? `<p class="om-view__note p-muted">The summary: what is still open, the coverage, the taxes, the properties and the findings that matter. <button type="button" class="p-linkbtn" data-view="working">Open the working view</button> for the books, the adjustments, every assumption and the personal section.</p>` : ""}
      ${sectionsShown().map(section).join("")}
      ${commentsPanel()}
    </div>`;
    markCurrent();
    growAll();
  }

  /** Repaint what follows from the figures. Parts someone is typing in keep their fields and
   *  only their computed cells change. */
  const PARTS = { kpis, open: openItems, entities, adjustments, properties, taxes, global, inputs: assumptions, personal, findings, discussion };
  function paintDerived() {
    compute();
    const active = document.activeElement;
    for (const [part, fn] of Object.entries(PARTS)) {
      const n = el.querySelector(`[data-part="${part}"]`);
      if (!n) continue;
      if (!n.contains(active)) { n.outerHTML = fn(); continue; }
      const tpl = document.createElement("template");
      tpl.innerHTML = fn();
      for (const c of tpl.content.querySelectorAll("[data-calc]")) { const cur = n.querySelector(`[data-calc="${CSS.escape(c.dataset.calc)}"]`); if (cur) cur.innerHTML = c.innerHTML; }
    }
    for (const sum of el.querySelectorAll("[data-sec-sum]")) sum.innerHTML = sectionSummary(sum.dataset.secSum);
    growAll();
  }
  function repaint() {
    if (el.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) { deferred = true; return; }
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }

  /* ------------------------------------------------------------- editing */
  const TABLES = { om_entities: "entities", om_periods: "periods", om_adjustments: "adjustments", om_properties: "properties", om_components: "components", om_findings: "findings", om_personal: "personal" };
  const NUMERIC = new Set(["liability", "revenue", "cogs", "opex", "depreciation", "interest", "rent_paid", "rent_related", "owner_comp", "other_expense", "net_income", "tax_gross", "tax_net", "cash", "total_assets", "total_liabilities", "recurring_cash_flow", "w2_wages", "ubia", "ownership_pct", "amount", "pct", "cost_basis", "land_pct", "land_value", "recovery_years", "prior_depreciation", "market_value", "debt_balance", "annual_debt_service", "annual_interest", "annual_rent", "annual_opex"]);
  function queue(key, fn) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(async () => { timers.delete(key); try { await fn(); } catch (err) { toast(`Couldn’t save: ${err.message}`, true); } }, 500));
  }
  function onRowInput(t, structural) {
    const table = t.dataset.t, list = d[TABLES[table]];
    const row = list?.find((x) => x.id === t.dataset.id);
    if (!row) return;
    const f = t.dataset.field;
    let value;
    if (t.type === "checkbox") value = t.checked;
    else if (NUMERIC.has(f)) { value = parseNum(t.value); t.classList.toggle("is-invalid", Number.isNaN(value)); if (Number.isNaN(value)) return; }
    else if (t.type === "date") value = t.value || null;
    else { value = t.value.trim() || null; if (["name", "label", "observation", "period"].includes(f) && !value) return; if (f === "category" && !CATEGORIES[value]) return; }
    if (f === "entity_id" || f === "used_by_entity_id" || f === "owner_id") value = value || null;
    row[f] = value;
    paintDerived();
    queue(`${table}:${row.id}:${f}`, () => store.omUpdate(table, row.id, { [f]: value, updated_by: me, updated_at: new Date().toISOString() }));
    if (structural) repaint();
  }
  function onInputInput(t) {
    const i = d.inputs.find((x) => x.id === t.dataset.input);
    if (!i) return;
    const f = t.dataset.field;
    if (f === "owner_id") {
      i.owner_id = t.value || null;
      store.omUpdate("om_inputs", i.id, { owner_id: i.owner_id }).then(() => { const y = window.scrollY; render(); window.scrollTo(0, y); el.querySelector(`select[data-input="${CSS.escape(i.id)}"][data-field="owner_id"]`)?.focus({ preventScroll: true }); }).catch((err) => toast(err.message, true));
      return;
    }
    if (f === "value") {
      if (i.unit === "text") i.text_value = t.value.trim() || null;
      else { const v = parseNum(t.value); t.classList.toggle("is-invalid", Number.isNaN(v)); if (Number.isNaN(v)) return; i.value = v; }
      if (i.status === "unknown" && (i.value != null || i.text_value)) { i.status = "estimate"; const sel = el.querySelector(`select[data-input="${CSS.escape(i.id)}"][data-field="status"]`); if (sel) sel.value = "estimate"; }
    } else if (f === "status") i.status = t.value;
    paintDerived();
    queue(`input:${i.id}`, async () => { const row = await store.omSetInput(i.id, i.unit === "text" ? null : i.value, i.unit === "text" ? i.text_value : null, i.status, null); Object.assign(i, row); });
  }

  const on = (type, fn) => el.addEventListener(type, fn);
  on("input", (e) => {
    const t = e.target;
    if (t.matches("textarea.om-area")) grow(t);
    if (t.matches("[data-t]") && t.tagName !== "SELECT" && t.type !== "checkbox" && t.type !== "date") onRowInput(t);
    else if (t.matches("[data-input]") && t.tagName === "INPUT") onInputInput(t);
  });
  on("change", (e) => {
    const t = e.target;
    if (t.matches("[data-t]") && (t.tagName === "SELECT" || t.type === "checkbox" || t.type === "date")) onRowInput(t, t.tagName === "SELECT" && ["kind", "use", "rent_source", "category", "status", "severity", "owner_id", "entity_id", "used_by_entity_id"].includes(t.dataset.field));
    else if (t.matches("select[data-input]")) { onInputInput(t); if (t.dataset.field === "status") t.className = `pm-in pm-in--sel pm-st pm-st--${t.value}`; }
  });
  on("focusout", (e) => {
    const t = e.target;
    if (t.matches("input[data-t]") && NUMERIC.has(t.dataset.field) && !t.classList.contains("is-invalid")) { const row = d[TABLES[t.dataset.t]]?.find((x) => x.id === t.dataset.id); const v = row?.[t.dataset.field]; t.value = fmtIn(v); }
    setTimeout(() => { if (deferred && !(el.contains(document.activeElement) && document.activeElement.matches("input, textarea, select"))) { deferred = false; repaint(); } }, 50);
  });
  on("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input.pm-in")) { e.preventDefault(); e.target.blur(); } });
  on("submit", async (e) => {
    if (!e.target.matches("[data-comment-form]")) return;
    e.preventDefault();
    const box = e.target.querySelector("textarea"), body = box.value.trim();
    if (!body) return;
    try {
      const row = await store.omAddComment({ model_id: modelId, engagement_id: model.engagement_id, target_kind: thread.kind, target_id: thread.id || null, target_label: thread.label, author_id: me, body });
      if (!d.comments.some((c) => c.id === row.id)) d.comments.push(row);
      render(); el.querySelector("#om-comment")?.focus();
    } catch (err) { toast(err.message, true); }
  });
  const base = () => ({ model_id: modelId, engagement_id: model.engagement_id });
  on("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) {
      // The head row of a section or a property card toggles it, unless a control was clicked.
      if (e.target.closest("input, select, textarea, a, label")) return;
      const sh = e.target.closest("[data-sec-head]"); if (sh) { setSection(sh.dataset.secHead, !openSecs.has(sh.dataset.secHead)); return; }
      const ph = e.target.closest("[data-prop-head]"); if (ph) { setProp(ph.dataset.propHead, !openProps.has(ph.dataset.propHead)); return; }
      return;
    }
    try {
      if (b.dataset.toggle) { setSection(b.dataset.toggle, !openSecs.has(b.dataset.toggle)); return; }
      if (b.dataset.propToggle) { setProp(b.dataset.propToggle, !openProps.has(b.dataset.propToggle)); return; }
      if (b.dataset.jump) { setSection(b.dataset.jump, true); el.querySelector(`#om-s-${b.dataset.jump}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
      if (b.dataset.view) { if (b.dataset.view !== view) { view = b.dataset.view; remember("view", view); render(); el.scrollIntoView({ block: "start" }); } return; }
      if (b.dataset.allFindings) { allFindings = b.dataset.allFindings === "1"; remember("allFindings", allFindings); const y = window.scrollY; render(); window.scrollTo(0, y); return; }
      if (b.dataset.goto) { const n = document.getElementById(b.dataset.goto); const sec = n?.closest(".om-sec"); if (sec) setSection(sec.dataset.sec, true); const card = n?.closest(".om-prop"); if (card) setProp(card.dataset.prop, true); n?.scrollIntoView({ block: "center" }); n?.focus(); n?.closest("li")?.classList.add("is-flash"); return; }
      if (b.dataset.talk) { thread = { kind: b.dataset.talk, id: b.dataset.target || null, label: b.dataset.label }; render(); el.querySelector("#om-comment")?.focus(); return; }
      if (b.hasAttribute("data-close-thread")) { thread = null; render(); return; }
      if (b.dataset.delComment) { await store.omDeleteComment(b.dataset.delComment); d.comments = d.comments.filter((c) => c.id !== b.dataset.delComment); render(); return; }
      if (b.hasAttribute("data-add-entity")) {
        const name = await promptDialog({ title: "Add an entity", label: "Name", confirmLabel: "Add", required: true, multiline: false });
        if (!name) return;
        const [row] = await store.omInsert("om_entities", [{ ...base(), name, kind: "smllc", position: d.entities.length + 1 }]);
        d.entities.push(row); render(); return;
      }
      if (b.dataset.addPeriod) {
        const period = await promptDialog({ title: "Add a period", label: "Period (e.g. 2025, or 2026 YTD)", confirmLabel: "Add", required: true, multiline: false });
        if (!period) return;
        const ytd = /ytd/i.test(period);
        const [row] = await store.omInsert("om_periods", [{ ...base(), entity_id: b.dataset.addPeriod, period: period.trim(), months: ytd ? new Date().getMonth() || 12 : 12, position: d.periods.length + 1 }]);
        d.periods.push(row); render(); return;
      }
      if (b.hasAttribute("data-add-adj")) {
        const label = await promptDialog({ title: "Add an adjustment", label: "What it is", confirmLabel: "Add", required: true, multiline: false });
        if (!label) return;
        const [row] = await store.omInsert("om_adjustments", [{ ...base(), entity_id: d.entities[0]?.id || null, period: String(result.taxYear), kind: "addback", applies_to: "both", label, position: d.adjustments.length + 1 }]);
        d.adjustments.push(row); render(); return;
      }
      if (b.hasAttribute("data-add-prop")) {
        const label = await promptDialog({ title: "Add a property", label: "Address or name", confirmLabel: "Add", required: true, multiline: false });
        if (!label) return;
        const [row] = await store.omInsert("om_properties", [{ ...base(), label, use: "commercial", position: d.properties.length + 1, confidence: "unknown" }]);
        d.properties.push(row); render(); return;
      }
      if (b.dataset.addComp) {
        const [row] = await store.omInsert("om_components", [{ ...base(), property_id: b.dataset.addComp, category: "p5", pct: 0, position: d.components.length + 1 }]);
        d.components.push(row); render(); return;
      }
      if (b.dataset.preset) {
        const preset = SEG_PRESETS[b.dataset.preset], pid = b.dataset.prop;
        const existing = d.components.filter((c) => c.property_id === pid);
        if (existing.length && !await confirmDialog({ title: "Replace the components?", body: `<p>The ${existing.length} component${existing.length > 1 ? "s" : ""} on this property are replaced with the typical <strong>${esc(preset.label)}</strong> split (base case). Adjust the shares afterwards.</p>`, confirmLabel: "Replace" })) return;
        for (const c of existing) await store.omDelete("om_components", c.id);
        d.components = d.components.filter((c) => c.property_id !== pid);
        const rows = Object.entries(preset).filter(([k]) => k !== "label").map(([category, [, basePct]], i) => ({ ...base(), property_id: pid, category, pct: basePct, label: CATEGORIES[category].hint, position: i + 1, confidence: "estimate" }));
        d.components.push(...await store.omInsert("om_components", rows));
        const p = d.properties.find((x) => x.id === pid);
        if (p && p.seg_status === "none") { p.seg_status = "estimated"; await store.omUpdate("om_properties", pid, { seg_status: "estimated" }); }
        render(); toast("Typical split applied as an estimate. An engineering study replaces it."); return;
      }
      if (b.dataset.addPersonal) {
        const label = await promptDialog({ title: `Add: ${PCAT.find(([k]) => k === b.dataset.addPersonal)?.[1]}`, label: "Item", confirmLabel: "Add", required: true, multiline: false });
        if (!label) return;
        const [row] = await store.omInsert("om_personal", [{ ...base(), category: b.dataset.addPersonal, label, position: (d.personal?.length || 0) + 1 }]);
        (d.personal ||= []).push(row); render(); return;
      }
      if (b.hasAttribute("data-add-finding")) {
        const observation = await promptDialog({ title: "Add a finding", label: "What was observed", confirmLabel: "Add", required: true });
        if (!observation) return;
        const [row] = await store.omInsert("om_findings", [{ ...base(), ref: `F${String(d.findings.length + 1).padStart(2, "0")}`, severity: "high", observation, position: d.findings.length + 1 }]);
        d.findings.push(row); render(); return;
      }
      if (b.dataset.del) {
        const table = b.dataset.del, list = d[TABLES[table]], row = list.find((x) => x.id === b.dataset.id);
        if (!row) return;
        const name = row.name || row.label || row.period || row.ref || "this";
        if (!await confirmDialog({ title: `Remove ${esc(name)}?`, body: `<p>It is removed from the model${table === "om_entities" ? ", with its periods" : table === "om_properties" ? ", with its components" : ""}.</p>`, confirmLabel: "Remove" })) return;
        await store.omDelete(table, row.id);
        d[TABLES[table]] = list.filter((x) => x.id !== row.id);
        if (table === "om_entities") d.periods = d.periods.filter((x) => x.entity_id !== row.id);
        if (table === "om_properties") d.components = d.components.filter((x) => x.property_id !== row.id);
        render(); return;
      }
      if (b.dataset.ask) {
        const i = d.inputs.find((x) => x.id === b.dataset.ask);
        if (!await confirmDialog({ title: `Ask ${nameOf(i.owner_id)} to confirm?`, body: `<p><strong>${esc(i.label)}</strong>. They get a request and an email, and set the value in the model.</p>`, confirmLabel: "Ask" })) return;
        const req = await store.omAskInput(i.id, i.owner_id, null);
        toastNotice(await store.notify("action_item", req), `Asked. ${nameOf(i.owner_id)} has been emailed.`, "Asked."); return;
      }
      if (b.dataset.askFinding) {
        const f = d.findings.find((x) => x.id === b.dataset.askFinding);
        if (!await confirmDialog({ title: `Ask ${nameOf(f.owner_id)} to resolve this?`, body: `<p><strong>${esc(f.ref || "")} ${esc(f.observation)}</strong>. They get a request and an email.</p>`, confirmLabel: "Ask" })) return;
        const req = await store.omAskFinding(f.id, f.owner_id, null);
        if (f.status === "open") f.status = "in_progress";
        toastNotice(await store.notify("action_item", req), `Asked. ${nameOf(f.owner_id)} has been emailed.`, "Asked."); render(); return;
      }
      if (b.hasAttribute("data-send-project")) {
        const g = result.global;
        if (!await confirmDialog({ title: "Send to the project model?", body: `<p>Sets, as estimates: existing cash flow <b>${money(g.cfads + g.rentsNet)}</b> (the businesses plus net third-party rents), existing debt service <b>${money(g.existingDs)}</b>, and owner draws <b>${money((g.draws || 0) + g.taxes)}</b> (living draws plus taxes).</p>`, confirmLabel: "Send" })) return;
        const pmInputs = await store.pmInputs(model.pm_model_id);
        const set = async (key, value) => { const i = pmInputs.find((x) => x.key === key); if (i) await store.pmSetInput(i.id, Math.round(value), null, "estimate", "From the owner model"); };
        await set("existing_cash_flow", g.cfads + g.rentsNet); await set("existing_debt_service", g.existingDs); await set("owner_draws", (g.draws || 0) + g.taxes);
        project = await modelSummary(model.pm_model_id).then((s) => s.result).catch(() => project);
        render(); toast("Sent. The project model's global coverage now uses these figures."); return;
      }
      if (b.hasAttribute("data-snapshot")) {
        const label = await promptDialog({ title: "Save a version", label: "Name", value: `${fmtDate(new Date().toISOString(), { month: "short", day: "numeric" })}: review`, confirmLabel: "Save", required: true, multiline: false });
        if (!label) return;
        const data = { result: snapshotOf(result), inputs: d.inputs, entities: d.entities, periods: d.periods, adjustments: d.adjustments, properties: d.properties, components: d.components, findings: d.findings, personal: d.personal };
        d.snapshots.unshift(await store.omSaveSnapshot({ ...base(), label, data, created_by: me })); render(); toast("Version saved."); return;
      }
      if (b.hasAttribute("data-csv")) { download(`${slug(model.title)}-owner-model.csv`, toCsv(result, d, model.title), "text/csv"); return; }
      if (b.dataset.snapCsv) { const s = await store.omSnapshot(b.dataset.snapCsv); download(`${slug(s.label)}.csv`, toCsv(s.data.result, s.data, `${model.title}: ${s.label}`), "text/csv"); return; }
      if (b.hasAttribute("data-print")) { document.body.classList.add("is-printing-sov"); window.print(); setTimeout(() => document.body.classList.remove("is-printing-sov"), 500); }
    } catch (err) { toast(err.message, true); }
  });

  /* --------------------------------------------------------- live changes */
  let unsub = null, liveTimer = null;
  const reloadSoon = () => { clearTimeout(liveTimer); liveTimer = setTimeout(async () => { if (destroyed) return; await load(); repaint(); }, 250); };
  function onRemote({ table, eventType, new: row, old }) {
    if (destroyed) return;
    if (table === "om_comments") {
      if (eventType === "INSERT" && row?.id && !d.comments.some((c) => c.id === row.id)) { d.comments.push(row); repaint(); }
      else if (eventType === "DELETE") { d.comments = d.comments.filter((c) => c.id !== old?.id); repaint(); }
      return;
    }
    const list = d[TABLES[table]] || (table === "om_inputs" ? d.inputs : null);
    if (list && eventType === "UPDATE" && row?.id) {
      const cur = list.find((x) => x.id === row.id);
      const mine = [...timers.keys()].some((k) => k.includes(row.id));
      if (cur && !mine) { Object.assign(cur, row); if (table === "om_inputs") store.omInputLog(model.engagement_id).then((l) => { log = l; repaint(); }).catch(() => {}); paintDerived(); }
      return;
    }
    reloadSoon();
  }

  await load();
  render();
  let scrollRaf = 0;
  const onScroll = () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; markCurrent(); }); };
  window.addEventListener("scroll", onScroll, { passive: true });
  const filters = ["om_entities", "om_periods", "om_adjustments", "om_properties", "om_components", "om_findings", "om_inputs", "om_personal", "om_comments"].map((table) => ({ table, filter: `model_id=eq.${modelId}` }));
  if (model.pm_model_id) filters.push({ table: "pm_inputs", filter: `model_id=eq.${model.pm_model_id}` });
  store.subscribe(`om-${modelId}`, filters, (ev) => (ev.table === "pm_inputs" ? reloadSoon() : onRemote(ev)), (status) => {
    live = status === "SUBSCRIBED";
    const n = el.querySelector("[data-live]");
    if (n) { n.classList.toggle("is-on", live); n.textContent = live ? "Live" : "Connecting…"; }
  }).then((u) => { if (destroyed) u(); else unsub = u; }).catch(() => {});

  return { get result() { return result; }, destroy() { destroyed = true; unsub?.(); window.removeEventListener("scroll", onScroll); for (const t of timers.values()) clearTimeout(t); } };
}

/** A short summary for Home and admin cards (no DOM). */
/** An owner model's figures. Pass the model row (and any project models already loaded) to
 *  fetch the rest in one parallel round. */
export async function ownerSummary(modelOrId, projectModels = []) {
  const model = typeof modelOrId === "object" && modelOrId ? modelOrId : await store.omModel(modelOrId);
  const pm = model.pm_model_id ? projectModels.find((m) => m.id === model.pm_model_id) || model.pm_model_id : null;
  const [d, project] = await Promise.all([
    store.omBundle(model.id),
    pm ? modelSummary(pm).then((s) => s.result).catch(() => null) : null,
  ]);
  return { model, inputs: d.inputs, findings: d.findings, result: calculateOwner({ model, ...d, project }) };
}

const slug = (s) => String(s || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const cellCsv = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** The figures worth keeping in a saved version (schedules trimmed to numbers). */
function snapshotOf(r) {
  return {
    global: r.global, seg: r.seg, tax: r.tax, study: r.study, taxYear: r.taxYear, bridgeRemaining: r.bridgeRemaining, findings: r.findings,
    entities: r.entities.map((en) => ({ name: en.entity.name, periods: en.periods.map((p) => ({ period: p.period, ni: p.ni, ebitda: p.ebitda, cfads: p.cfads, gap: p.gap, remaining: p.remaining })) })),
    properties: r.properties.map((x) => ({ label: x.property.label, depreciable: x.schedule.depreciable, reclass: x.schedule.reclass, catchUp: x.schedule.catchUp, extra: x.schedule.extra, savingsYear1: x.schedule.savingsYear1, npv: x.schedule.npv, asFiled: x.schedule.asFiled, withSeg: x.schedule.withSeg })),
  };
}
function toCsv(r, d, title) {
  const rows = [[title], [`Study year ${r.study}`], [], ["Entity", "Period", "Net income (books)", "EBITDA", "Cash flow available for debt service", "Return less books", "Unexplained"]];
  for (const en of r.entities) for (const p of en.periods) rows.push([en.entity?.name ?? en.name, p.period, p.ni, p.ebitda, p.cfads, p.gap, p.remaining].map((x) => (x == null ? "" : Math.round(x))));
  rows.push([], ["Property", "Depreciable basis", "Reclassified", "Catch-up", `Extra deduction ${r.study}`, "Tax saved year 1", "Timing benefit (PV)"]);
  for (const x of r.properties) { const s = x.schedule || x; rows.push([x.property?.label ?? x.label, s.depreciable, s.reclass, s.catchUp, s.extra, s.savingsYear1, s.npv].map((v) => (v == null ? "" : Math.round(v)))); }
  const g = r.global;
  rows.push([], ["Global cash flow"], ["Recurring cash flow", g.cfads], ["Third-party rents, net", g.rentsNet], ["Taxes", g.taxes], ["Living draws", g.draws], ["Available for debt service", g.available], ["Existing debt service", g.existingDs], ["Coverage", g.dscr == null ? "" : g.dscr.toFixed(2)]);
  if (g.withProject) rows.push(["Coverage with the project", g.withProject.dscr.toFixed(2)]);
  rows.push([], ["Assumption", "Value", "Status"]);
  for (const i of d.inputs || []) rows.push([i.label, i.unit === "text" ? i.text_value || "" : i.value ?? "", i.status]);
  rows.push([], ["Personal item", "Category", "Value", "Owed", "Status"]);
  for (const i of d.personal || []) rows.push([i.label, i.category, i.amount ?? "", i.liability ?? "", i.status]);
  rows.push([], ["Finding", "Severity", "Status", "Observation", "Owner"]);
  for (const f of d.findings || []) rows.push([f.ref, f.severity, f.status, f.observation, f.owner_label]);
  return rows.map((row) => row.map(cellCsv).join(",")).join("\r\n");
}
