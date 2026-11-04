// The schedule of values: a pricing sheet a contractor fills in, line by line, with autosave.
//
// Three views of one sheet:
//   contractor  prices the lines (quantity × unit cost, or a lump sum), notes, sheet details;
//               adds lines for scope they think is missing; submits when every line is answered
//   owner       the client: reads the prices beside the budget, asks questions on lines,
//               accepts the pricing or sends it back
//   admin       Michael: everything, plus line descriptions, the budget and reopening
//   viewer      an adviser with project-model access (an accountant): reads prices beside the budget
//
// Saving: each edit is queued per line and sent about half a second after typing stops (or at
// once on leaving the cell). Only the changed fields go, so two people editing different cells
// never overwrite each other. If the network drops, edits wait in the queue (and in this
// browser's storage, so a reload keeps them) and retry until they land. Changes from anyone
// else arrive live over Supabase Realtime. The budget table is owner-side only: the database
// returns nothing from it to the contractor, so it is never in their browser.
import { store } from "./store.js";
import { esc, paragraphs, fmtDate, relTime, toast, confirmDialog, promptDialog, download } from "./ui.js";

/* ----------------------------------------------------------- numbers */
const nf = (max) => new Intl.NumberFormat("en-US", { maximumFractionDigits: max });
const NF2 = nf(2), NF3 = nf(3), NF0 = nf(0);
export const money = (n) => (n == null || Number.isNaN(n) ? "—" : `${n < 0 ? "−" : ""}$${NF0.format(Math.abs(Math.round(n)))}`);
const compact = (n) => (n == null ? "" : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M` : Math.abs(n) >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`);
const signed = (n) => (n == null ? "" : `${n > 0 ? "+" : n < 0 ? "−" : ""}$${NF0.format(Math.abs(Math.round(n)))}`);

/** "$1,250.50" → 1250.5; "(300)" → -300; "12k" → 12000; "1.2m" → 1200000; "" → null; junk → NaN. */
export function parseNum(text) {
  let s = String(text ?? "").trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (s.startsWith("−") || s.startsWith("-")) { sign *= -1; s = s.slice(1); }
  let mult = 1;
  if (s.endsWith("k")) { mult = 1e3; s = s.slice(0, -1); } else if (s.endsWith("m")) { mult = 1e6; s = s.slice(0, -1); }
  if (s.endsWith("%")) s = s.slice(0, -1);
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
  return Math.round(sign * Number(s) * mult * 1000) / 1000;
}

const NUM_FIELDS = new Set(["quantity", "unit_cost", "amount", "budget", "building_sf", "ohp_pct"]);
const fmtField = (field, v) => (v == null || v === "" ? "" : field === "quantity" ? NF3.format(v) : NUM_FIELDS.has(field) ? NF2.format(v) : String(v));

export const LINE_STATUS = [["priced", "Priced"], ["allowance", "Allowance"], ["excluded", "Excluded"], ["tbd", "TBD"]];
const STATUS_LABEL = Object.fromEntries(LINE_STATUS);
const UNITS = ["LS", "SF", "LF", "SY", "CY", "EA", "TON", "HR", "DAY", "MO", "LOT", "ALLOW"];

export const SHEET_STATUS = {
  not_started: ["Not started", ""], in_progress: ["In progress", "pill--teal"], submitted: ["Submitted", "pill--gold"],
  changes_requested: ["Changes requested", "pill--red"], accepted: ["Accepted", "pill--navy"],
};
export const sheetPill = (s) => { const [l, c] = SHEET_STATUS[s] || [s, ""]; return `<span class="pill pill--dot ${c}">${esc(l)}</span>`; };

/** A line counts as answered when it has a price, or is excluded / TBD with a note saying why. */
export const lineAnswered = (l) => (["excluded", "tbd"].includes(l.line_status) ? !!(l.note || "").trim() : l.amount != null);
const countsInTotal = (l) => l.line_status !== "excluded" && l.amount != null;

/** Subtotal, OH&P, total, $/SF, progress, and (when a budget is given) budget totals. */
export function sovTotals(sheet, lines, budget = null) {
  let subtotal = 0, answered = 0, bLow = 0, bBase = 0, bHigh = 0, hasBudget = false, pricedAmt = 0, pricedBudget = 0;
  const sections = new Map();
  for (const l of lines) {
    const key = l.section || "";
    const s = sections.get(key) || { amount: 0, budget: 0, answered: 0, count: 0, pricedAmt: 0, pricedBudget: 0 };
    s.count++;
    if (countsInTotal(l)) { subtotal += Number(l.amount); s.amount += Number(l.amount); }
    if (lineAnswered(l)) { answered++; s.answered++; }
    const b = budget?.get(l.id);
    if (b) {
      hasBudget = true;
      bLow += Number(b.low ?? b.base ?? 0); bBase += Number(b.base ?? 0); bHigh += Number(b.high ?? b.base ?? 0);
      s.budget += Number(b.base ?? 0);
      // Like for like: only lines that have a price, against those lines' budget.
      if (countsInTotal(l) && b.base != null) { pricedAmt += Number(l.amount); pricedBudget += Number(b.base); s.pricedAmt += Number(l.amount); s.pricedBudget += Number(b.base); }
    }
    sections.set(key, s);
  }
  const ohp = Math.round(subtotal * Number(sheet.ohp_pct || 0)) / 100;
  const total = subtotal + ohp;
  return {
    subtotal, ohp, total, answered, count: lines.length, sections,
    perSf: sheet.building_sf ? total / Number(sheet.building_sf) : null,
    budget: hasBudget ? { low: bLow, base: bBase, high: bHigh, pricedBudget, variance: pricedAmt - pricedBudget, complete: answered === lines.length, totalVariance: total - bBase } : null,
  };
}

/** Starting lines for a new sheet. */
export const SOV_TEMPLATES = {
  csi: {
    label: "Commercial building: CSI divisions 01–33",
    lines: [
      ["Building", "01", "General requirements", "Supervision, temporary facilities, insurance, bonds, cleanup"],
      ["Building", "02", "Existing conditions / demolition", ""],
      ["Building", "03", "Concrete", "Foundations, slab on grade, flatwork"],
      ["Building", "04", "Masonry", ""],
      ["Building", "05", "Metals", "Structural steel, misc. metals"],
      ["Building", "06", "Wood, plastics and composites", "Framing, millwork"],
      ["Building", "07", "Thermal and moisture protection", "Roofing, insulation, waterproofing"],
      ["Building", "08", "Openings", "Doors, frames, hardware, storefront, glazing"],
      ["Building", "09", "Finishes", "Drywall, ceilings, flooring, paint"],
      ["Building", "10", "Specialties", "Toilet accessories, signage, fire extinguishers"],
      ["Building", "11", "Equipment", ""],
      ["Building", "12", "Furnishings", ""],
      ["Building", "21", "Fire suppression", ""],
      ["Building", "22", "Plumbing", ""],
      ["Building", "23", "HVAC", ""],
      ["Building", "26", "Electrical", ""],
      ["Building", "27", "Communications / low voltage", ""],
      ["Building", "28", "Electronic safety and security", "Fire alarm, access control, cameras"],
      ["Site", "31", "Earthwork", "Clearing, grading, excavation, compaction"],
      ["Site", "32", "Exterior improvements", "Paving, striping, curbs, landscaping, fencing"],
      ["Site", "33", "Utilities", "Water, sewer, storm, gas, electric service"],
      ["Fees and conditions", "", "Permits and fees", "Building permit, impact and tap fees, if in your scope"],
      ["Fees and conditions", "", "Contingency", "Your contingency, if any, as a separate line"],
    ],
  },
  blank: { label: "Blank sheet", lines: [] },
};

/* -------------------------------------------------------------- grid */
const isNetworkError = (err) => !navigator.onLine || /fetch|network|load failed|timed? ?out|offline|connection/i.test(String(err?.message || err));
const PENDING_KEY = (id) => `sypher-sov-pending:${id}`;

/**
 * Mount a sheet into `el`. role: "contractor" | "owner" | "admin".
 * nameOf(userId) gives a display name. Returns { destroy() }.
 */
export async function mountSov(el, { sheetId, role, me, nameOf = () => "Someone", onStatus = () => {} }) {
  const owner = role === "owner" || role === "admin" || role === "viewer";   // sees the budget
  const reviewer = role === "owner" || role === "admin";                        // may question lines and accept
  const admin = role === "admin";
  let sheet, lines, budget = null, versions = [], compare = null, filter = "all", live = false, destroyed = false;

  // Save queue. Keys: "sheet", "line:<id>", "budget:<id>". Each holds the fields still to send.
  const pending = new Map(), inflight = new Map(), timers = new Map();
  let retryTimer = null, retryDelay = 2000, saveError = "";

  async function load() {
    [sheet, lines] = await Promise.all([store.sovSheet(sheetId), store.sovLines(sheetId)]);
    if (owner) {
      const rows = await store.sovBudget(sheet.engagement_id).catch(() => []);
      budget = new Map(rows.map((b) => [b.line_id, b]));
    }
    versions = await store.sovVersions(sheetId).catch(() => []);
    // Show what changed against the last submitted version (or the one before, once it's submitted again).
    const ref = ["submitted", "accepted"].includes(sheet.status) ? versions[1] : versions[0];
    compare = null;
    if (ref) {
      const v = await store.sovVersion(ref.id).catch(() => null);
      if (v) compare = { version: v.version, total: Number(v.total), amounts: new Map((v.snapshot?.lines || []).map((l) => [l.id, l.amount == null ? null : Number(l.amount)])) };
    }
    restorePending();
  }

  const editable = () => admin || (role === "contractor" && ["not_started", "in_progress", "changes_requested"].includes(sheet.status));
  const lineById = (id) => lines.find((l) => l.id === id);
  const lineFields = () => (admin ? ["code", "description", "quantity", "unit", "unit_cost", "amount", "budget", "line_status", "note"]
    : editable() ? ["quantity", "unit", "unit_cost", "amount", "line_status", "note"] : []);

  /* ---------------- pending edits survive a reload or a dropped connection */
  function persist() {
    try {
      const all = {};
      for (const [k, v] of inflight) all[k] = { ...v };
      for (const [k, v] of pending) all[k] = { ...(all[k] || {}), ...v };
      if (Object.keys(all).length) localStorage.setItem(PENDING_KEY(sheetId), JSON.stringify(all));
      else localStorage.removeItem(PENDING_KEY(sheetId));
    } catch (_) { /* storage unavailable: the in-memory queue still works */ }
  }
  function restorePending() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PENDING_KEY(sheetId)) || "null"); } catch (_) { saved = null; }
    if (!saved || !editable()) { try { localStorage.removeItem(PENDING_KEY(sheetId)); } catch (_) { /* ignore */ } return; }
    for (const [key, patch] of Object.entries(saved)) {
      if (key === "sheet") Object.assign(sheet, patch);
      else if (key.startsWith("line:")) { const l = lineById(key.slice(5)); if (!l) continue; Object.assign(l, patch); }
      else if (key.startsWith("budget:") && budget) { const id = key.slice(7); budget.set(id, { ...(budget.get(id) || { line_id: id }), ...patch }); }
      pending.set(key, patch);
    }
    if (pending.size) setTimeout(flushAll, 300);
  }

  function queue(key, field, value) {
    const p = pending.get(key) || {};
    p[field] = value;
    pending.set(key, p);
    persist();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => flush(key), 500));
    paintStatus();
  }

  async function flush(key) {
    clearTimeout(timers.get(key));
    if (inflight.has(key) || !pending.has(key)) return;
    const patch = pending.get(key);
    pending.delete(key);
    inflight.set(key, patch);
    paintStatus();
    try {
      if (key === "sheet") {
        const row = await store.sovUpdateSheet(sheetId, patch);
        inflight.delete(key);
        merge(sheet, row, "sheet");
      } else if (key.startsWith("line:")) {
        const row = await store.sovSaveLine(key.slice(5), patch);
        inflight.delete(key);
        const l = lineById(row.id);
        if (l) { merge(l, row, key); paintLine(l); }
      } else if (key.startsWith("budget:")) {
        const id = key.slice(7);
        await store.sovSaveBudget({ line_id: id, engagement_id: sheet.engagement_id, ...patch });
      }
      saveError = "";
      retryDelay = 2000;
    } catch (err) {
      if (isNetworkError(err)) {
        // Put it back under anything typed since, and try again shortly.
        pending.set(key, { ...patch, ...(pending.get(key) || {}) });
        scheduleRetry();
      } else {
        saveError = err.message;
        toast(`Couldn’t save: ${err.message}`, true);
        // Show what the database actually holds.
        if (/locked/i.test(err.message)) await refresh();
        else await resync(key);
      }
    } finally {
      inflight.delete(key);
      persist();
      paintTotals();
      paintStatus();
      if (pending.has(key) && !retryTimer) flush(key);
    }
  }
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; flushAll(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
  async function flushAll() { await Promise.all([...pending.keys()].map(flush)); }
  async function resync(key) {
    try {
      if (key === "sheet") { Object.assign(sheet, await store.sovSheet(sheetId)); render(); }
      else if (key.startsWith("line:")) {
        const fresh = (await store.sovLines(sheetId)).find((x) => x.id === key.slice(5));
        const l = lineById(key.slice(5));
        if (fresh && l) { Object.assign(l, fresh); const r = el.querySelector(`tr[data-row="${CSS.escape(l.id)}"]`); if (r) r.outerHTML = lineRow(l); }
      }
    } catch (_) { /* leave it; the next load corrects it */ }
  }

  /** Take the server's row, keeping any field still waiting to be sent (and, for live events
   *  that may predate a save in flight, the fields in flight too). */
  function merge(target, row, key, { live = false } = {}) {
    const waiting = { ...(live ? inflight.get(key) || {} : {}), ...(pending.get(key) || {}) };
    for (const [k, v] of Object.entries(row)) if (!(k in waiting)) target[k] = v;
  }

  /* ---------------- rendering */
  const sectionsInOrder = () => {
    const out = [];
    for (const l of lines) { const k = l.section || ""; if (!out.includes(k)) out.push(k); }
    return out;
  };
  const isOpenLine = (l) => !lineAnswered(l) || !!l.review_note;
  const visible = (l) => filter === "all" || (filter === "open" ? isOpenLine(l) : !!l.review_note);

  function cell(l, field) {
    const id = l.id;
    const canEdit = lineFields().includes(field);
    const label = `${field.replace("_", " ")} for ${l.description}`;
    if (field === "line_status") {
      if (!canEdit) return `<span class="sov-status sov-status--${esc(l.line_status)}">${esc(STATUS_LABEL[l.line_status])}</span>`;
      return `<select class="sov-in sov-in--status" data-line="${esc(id)}" data-field="line_status" aria-label="${esc(label)}">${LINE_STATUS.map(([v, t]) => `<option value="${v}"${l.line_status === v ? " selected" : ""}>${t}</option>`).join("")}</select>`;
    }
    const value = field === "budget" ? budget?.get(id)?.base : l[field];
    if (!canEdit) return field === "note" ? `<span class="sov-note">${esc(l.note || "")}</span>` : `<span>${esc(fmtField(field, value))}</span>`;
    const num = NUM_FIELDS.has(field);
    const derived = field === "amount" && l.quantity != null && l.unit_cost != null;
    return `<input class="sov-in${num ? " sov-in--num" : ""}" data-line="${esc(id)}" data-field="${field}" value="${esc(fmtField(field, value))}"
      ${num ? 'inputmode="decimal"' : ""}${field === "unit" ? ' list="sov-units"' : ""}${derived ? ' readonly title="Quantity × unit cost. Clear either to enter a lump sum."' : ""}
      ${field === "note" ? `placeholder="${["excluded", "tbd"].includes(l.line_status) ? "Why? (needed)" : "Note"}"` : ""} aria-label="${esc(label)}" autocomplete="off" spellcheck="${field === "note" || field === "description"}">`;
  }

  function lineRow(l) {
    const b = budget?.get(l.id);
    const was = compare?.amounts.has(l.id) ? compare.amounts.get(l.id) : undefined;
    const changed = compare && (was === undefined || was !== (l.amount == null ? null : Number(l.amount)));
    const varc = b?.base != null && countsInTotal(l) ? Number(l.amount) - Number(b.base) : null;
    const canDelete = editable() && (admin || l.created_by === me);
    const desc = admin ? cell(l, "description") : `<span class="sov-desc__text">${esc(l.description)}</span>`;
    return `<tr class="sov-row is-${esc(l.line_status)}${lineAnswered(l) ? " is-answered" : ""}" data-row="${esc(l.id)}"${visible(l) ? "" : " hidden"}>
      <td class="sov-c-code">${admin ? cell(l, "code") : esc(l.code || "")}</td>
      <td class="sov-c-desc"><div class="sov-desc">${desc}
        ${l.hint ? `<span class="sov-hint">${esc(l.hint)}</span>` : ""}
        ${l.review_note ? `<span class="sov-question"><b>Question:</b> ${esc(l.review_note)}</span>` : ""}
        ${changed && compare ? `<span class="sov-was">v${compare.version}: ${was === undefined ? "new line" : money(was)}</span>` : ""}</div></td>
      <td class="sov-c-num">${cell(l, "quantity")}</td>
      <td class="sov-c-unit">${cell(l, "unit")}</td>
      <td class="sov-c-num">${cell(l, "unit_cost")}</td>
      <td class="sov-c-num sov-c-amt">${cell(l, "amount")}</td>
      ${owner ? `<td class="sov-c-num sov-c-bud">${admin ? cell(l, "budget") : esc(b?.base != null ? money(Number(b.base)) : "")}${b && (b.low != null || b.high != null) ? `<span class="sov-range" title="Budget range">${compact(Number(b.low ?? b.base))}–${compact(Number(b.high ?? b.base))}</span>` : ""}</td>
        <td class="sov-c-num sov-c-var${varc > 0 ? " is-over" : varc < 0 ? " is-under" : ""}" data-var>${varc == null ? "" : esc(signed(varc))}</td>` : ""}
      <td class="sov-c-st">${cell(l, "line_status")}</td>
      <td class="sov-c-note">${cell(l, "note")}</td>
      <td class="sov-c-act">${reviewer ? `<button type="button" class="sov-icon" data-ask="${esc(l.id)}" title="${l.review_note ? "Edit your question" : "Ask about this line"}" aria-label="Ask about ${esc(l.description)}">?</button>` : ""}
        ${canDelete ? `<button type="button" class="sov-icon sov-icon--del" data-del="${esc(l.id)}" title="Remove line" aria-label="Remove ${esc(l.description)}">×</button>` : ""}</td>
    </tr>`;
  }

  function sectionRows(key, t) {
    const s = t.sections.get(key) || { amount: 0, budget: 0, answered: 0, count: 0, pricedAmt: 0, pricedBudget: 0 };
    const rows = lines.filter((l) => (l.section || "") === key);
    const cols = owner ? 11 : 9;
    return `<tbody class="sov-sec" data-section="${esc(key)}">
      <tr class="sov-sec__head"><th colspan="5" scope="colgroup">${esc(key || "Lines")}<span class="sov-sec__count">${s.answered} of ${s.count}</span></th>
        <td class="sov-c-num" data-sec-amt>${money(s.amount)}</td>
        ${owner ? `<td class="sov-c-num" data-sec-bud>${s.budget ? money(s.budget) : ""}</td><td class="sov-c-num" data-sec-var title="Priced lines against their budget">${s.pricedBudget ? esc(signed(s.pricedAmt - s.pricedBudget)) : ""}</td>` : ""}
        <td colspan="3"></td></tr>
      ${rows.map(lineRow).join("")}
      ${editable() ? `<tr class="sov-sec__add"><td></td><td colspan="${cols - 1}"><button type="button" class="p-linkbtn" data-add-line="${esc(key)}">+ Add a line${key ? ` to ${esc(key)}` : ""}</button></td></tr>` : ""}
    </tbody>`;
  }

  function banner() {
    const by = sheet.contractor_id ? nameOf(sheet.contractor_id) : "the contractor";
    const when = sheet.submitted_at ? fmtDate(sheet.submitted_at, { month: "short", day: "numeric" }) : "";
    if (sheet.status === "submitted") {
      return `<div class="sov-banner sov-banner--gold"><b>Submitted${sheet.version ? ` · version ${sheet.version}` : ""}${when ? ` on ${esc(when)}` : ""}.</b>
        ${role === "contractor" ? "The sheet is locked while it’s reviewed. You’ll be told if anything needs changing." : `${esc(by)}’s pricing is ready to review. Accept it, or send it back with what needs to change.`}</div>`;
    }
    if (sheet.status === "changes_requested") {
      return `<div class="sov-banner sov-banner--rust"><b>Changes requested.</b> ${sheet.review_note ? esc(sheet.review_note) : ""}
        ${role === "contractor" ? " Lines with a question are marked. Update them and submit again." : ""}</div>`;
    }
    if (sheet.status === "accepted") return `<div class="sov-banner sov-banner--navy"><b>Accepted${sheet.reviewed_at ? ` on ${esc(fmtDate(sheet.reviewed_at, { month: "short", day: "numeric" }))}` : ""}.</b> ${sheet.review_note ? esc(sheet.review_note) : ""}</div>`;
    if (role === "contractor") return `<div class="sov-banner"><b>Your entries save as you type.</b> Price each line as quantity × unit cost or a lump sum. Mark scope you don’t carry as Excluded, or TBD, with a note. Paste a column from Excel straight into the grid.</div>`;
    return "";
  }

  function detailField(name, label, opts = {}) {
    const v = sheet[name];
    const can = editable();
    const shown = opts.type === "date" ? (v || "") : fmtField(name, v);
    if (!can) return `<div class="sov-detail"><dt>${esc(label)}</dt><dd>${opts.type === "date" ? esc(v ? fmtDate(v) : "—") : esc(shown || "—")}${shown && opts.suffix ? esc(opts.suffix) : ""}</dd></div>`;
    const tag = opts.long ? `<textarea class="p-textarea sov-sheet-in" rows="2" data-sheet="${name}" id="sov-${name}" placeholder="${esc(opts.placeholder || "")}">${esc(v || "")}</textarea>`
      : `<input class="p-input sov-sheet-in" data-sheet="${name}" id="sov-${name}" value="${esc(shown)}"${opts.type === "date" ? ' type="date"' : ""}${NUM_FIELDS.has(name) ? ' inputmode="decimal"' : ""} placeholder="${esc(opts.placeholder || "")}">`;
    return `<div class="p-field${opts.long ? " sov-span" : ""}"><label for="sov-${name}">${esc(label)}${opts.required ? ' <span class="sov-req">needed to submit</span>' : ""}</label>${tag}</div>`;
  }

  function details() {
    const fields = [
      detailField("building_sf", "Building area (SF)", { placeholder: "e.g. 6,500", suffix: " SF" }),
      detailField("location", "Location / ZIP", { placeholder: "City, ZIP" }),
      detailField("valid_until", "Price valid until", { type: "date", required: true }),
      detailField("ohp_pct", "Overhead & profit (%)", { placeholder: "e.g. 10", suffix: "%" }),
      detailField("ohp_basis", "What OH&P covers", { long: true, placeholder: "e.g. on the subtotal; general conditions carried in Division 01" }),
      detailField("schedule_note", "Schedule", { long: true, placeholder: "Duration, start date, long-lead items" }),
      detailField("basis_note", "Basis, assumptions and exclusions", { long: true, placeholder: "Drawings and revision used, allowances, what is not included" }),
    ];
    return editable() ? `<div class="p-form p-form--2 sov-details">${fields.join("")}</div>` : `<dl class="sov-details sov-details--ro">${fields.join("")}</dl>`;
  }

  function summary(t) {
    const pct = t.count ? Math.round((t.answered / t.count) * 100) : 0;
    const actions = [];
    if (role === "contractor" && editable()) actions.push(`<button type="button" class="btn btn--gold btn--sm" data-submit>${sheet.version ? "Submit revised pricing" : "Submit pricing"}</button>`);
    if (reviewer && sheet.status === "submitted") actions.push(`<button type="button" class="btn btn--ghost btn--sm" data-review="changes">Request changes</button>`, `<button type="button" class="btn btn--gold btn--sm" data-review="accept">Accept pricing</button>`);
    if (admin && !["submitted", "accepted"].includes(sheet.status)) actions.push(`<button type="button" class="btn btn--ghost btn--sm" data-submit>Submit as version ${sheet.version + 1}</button>`);
    if (admin && ["submitted", "accepted"].includes(sheet.status)) actions.push(`<button type="button" class="p-linkbtn" data-reopen>Reopen for edits</button>`);
    return `<div class="sov-bar" role="region" aria-label="Totals">
      <div class="sov-bar__figs">
        <div><span>Subtotal</span><b data-t="subtotal">${money(t.subtotal)}</b></div>
        <div><span>OH&amp;P${sheet.ohp_pct != null ? ` ${esc(NF2.format(sheet.ohp_pct))}%` : ""}</span><b data-t="ohp">${money(t.ohp)}</b></div>
        <div class="sov-bar__total"><span>Total</span><b data-t="total">${money(t.total)}</b></div>
        <div><span>Per SF</span><b data-t="persf">${t.perSf ? `$${NF2.format(t.perSf)}` : "—"}</b></div>
        ${t.budget ? `<div><span>Budget</span><b data-t="budget">${money(t.budget.base)}</b></div><div><span title="Priced lines against their own budget">Variance, priced lines</span><b data-t="variance" class="${t.budget.variance > 0 ? "is-over" : "is-under"}">${esc(signed(t.budget.variance))}</b></div>` : ""}
        ${compare ? `<div><span>v${compare.version} total</span><b>${money(compare.total)}</b></div>` : ""}
      </div>
      <div class="sov-bar__side">
        <div class="sov-bar__prog"><span data-t="prog">${t.answered} of ${t.count} lines answered</span><div class="p-progress"><span data-t="progbar" style="transform:scaleX(${pct / 100})"></span></div></div>
        <span class="sov-save" data-save aria-live="polite"></span>
        <div class="btn-row">${actions.join("")}</div>
      </div>
    </div>`;
  }

  function render() {
    const focus = document.activeElement && el.contains(document.activeElement) ? { line: document.activeElement.dataset.line, field: document.activeElement.dataset.field, sheet: document.activeElement.dataset.sheet, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
    const t = sovTotals(sheet, lines, budget);
    const head = `<tr><th class="sov-c-code" scope="col">Code</th><th class="sov-c-desc" scope="col">Scope</th><th class="sov-c-num" scope="col">Qty</th><th class="sov-c-unit" scope="col">Unit</th>
      <th class="sov-c-num" scope="col">Unit cost</th><th class="sov-c-num" scope="col">Amount</th>
      ${owner ? `<th class="sov-c-num" scope="col">Budget</th><th class="sov-c-num" scope="col">Variance</th>` : ""}
      <th class="sov-c-st" scope="col">Status</th><th class="sov-c-note" scope="col">Note</th><th class="sov-c-act" scope="col"><span class="visually-hidden">Actions</span></th></tr>`;
    const qCount = lines.filter((l) => l.review_note).length;
    el.innerHTML = `<div class="sov">
      <header class="sov-head">
        <div class="sov-print-brand" aria-hidden="true"><img src="../assets/img/sypher-mark-sm.webp" alt="" width="46" height="48"><span>SYPHER <small>Solutions</small></span></div>
        <div class="sov-head__row"><div><p class="p-kicker">Schedule of values</p><h2 class="sov-title">${esc(sheet.title)}</h2>
          <p class="p-muted">${sheet.contractor_id ? `Priced by ${esc(nameOf(sheet.contractor_id))}` : "No contractor assigned yet"}${sheet.updated_at ? ` · last change ${esc(relTime(sheet.updated_at))}` : ""}</p></div>
          <div class="sov-head__side">${sheetPill(sheet.status)}<span class="sov-live${live ? " is-on" : ""}" data-live title="Changes from others appear as they’re made">${live ? "Live" : "Connecting…"}</span></div></div>
        ${sheet.intro ? `<div class="sov-intro">${paragraphs(sheet.intro)}</div>` : ""}
        ${banner()}
        ${editable() ? "" : details()}
      </header>
      <div class="sov-tools">
        <label class="sov-filter"><span>Show</span><select class="p-select p-select--sm" data-filter>
          <option value="all"${filter === "all" ? " selected" : ""}>All lines (${lines.length})</option>
          <option value="open"${filter === "open" ? " selected" : ""}>Still to answer (${lines.filter(isOpenLine).length})</option>
          <option value="questions"${filter === "questions" ? " selected" : ""}>With questions (${qCount})</option></select></label>
        <span class="sov-tools__hint p-muted">${editable() ? "Enter moves down · Esc undoes the cell · paste a column from Excel" : ""}</span>
        <div class="btn-row"><button type="button" class="p-linkbtn" data-csv>Download CSV</button><button type="button" class="p-linkbtn" data-print>Print / PDF</button>
          ${admin && editable() ? `<button type="button" class="p-linkbtn" data-add-section>+ Add a section</button>` : ""}</div>
      </div>
      <div class="sov-wrap" tabindex="-1"><table class="sov-table${owner ? " sov-table--owner" : ""}">
        <thead>${head}</thead>
        ${lines.length ? sectionsInOrder().map((k) => sectionRows(k, t)).join("") : `<tbody><tr><td colspan="${owner ? 11 : 9}"><p class="p-empty">No lines yet.${editable() ? " Add the first one below." : ""}</p>${editable() ? `<button type="button" class="p-linkbtn" data-add-line="">+ Add a line</button>` : ""}</td></tr></tbody>`}
      </table></div>
      ${editable() ? `<section class="sov-terms" aria-label="The terms of this price"><h3 class="room-sub">The terms of ${role === "contractor" ? "your" : "this"} price</h3>${details()}</section>` : ""}
      <datalist id="sov-units">${UNITS.map((u) => `<option value="${u}">`).join("")}</datalist>
      ${summary(t)}
      ${versions.length ? `<details class="sov-versions"><summary class="p-linkbtn">${versions.length} submitted version${versions.length > 1 ? "s" : ""}</summary><ul class="p-list">${versions.map((v) => `<li class="p-row"><span><b>Version ${v.version}</b> · ${esc(fmtDate(v.created_at, { month: "short", day: "numeric", year: "numeric" }))}${v.submitted_by ? ` · ${esc(nameOf(v.submitted_by))}` : ""}</span><span>${money(Number(v.total))} <button type="button" class="p-linkbtn" data-version-csv="${esc(v.id)}">CSV</button></span></li>`).join("")}</ul></details>` : ""}
    </div>`;
    paintStatus();
    if (focus) {
      const sel = focus.line ? `[data-line="${CSS.escape(focus.line)}"][data-field="${focus.field}"]` : focus.sheet ? `[data-sheet="${focus.sheet}"]` : null;
      const node = sel && el.querySelector(sel);
      if (node) { node.focus({ preventScroll: true }); try { node.setSelectionRange(focus.start, focus.end); } catch (_) { /* select */ } }
    }
  }

  /** Repaint one line's derived bits (amount, variance, answered state) without touching the cell being typed in. */
  function paintLine(l) {
    const row = el.querySelector(`tr[data-row="${CSS.escape(l.id)}"]`);
    if (!row) return;
    row.classList.toggle("is-answered", lineAnswered(l));
    for (const s of ["priced", "allowance", "excluded", "tbd"]) row.classList.toggle(`is-${s}`, l.line_status === s);
    const amt = row.querySelector('[data-field="amount"]');
    if (amt) {
      const derived = l.quantity != null && l.unit_cost != null;
      amt.readOnly = derived;
      amt.title = derived ? "Quantity × unit cost. Clear either to enter a lump sum." : "";
      if (document.activeElement !== amt) amt.value = fmtField("amount", l.amount);
    } else {
      const span = row.querySelector(".sov-c-amt span");
      if (span) span.textContent = fmtField("amount", l.amount);
    }
    for (const f of ["quantity", "unit", "unit_cost", "note", "code", "description"]) {
      const input = row.querySelector(`[data-field="${f}"]`);
      if (input && document.activeElement !== input && !(f in (pending.get(`line:${l.id}`) || {}))) input.value = fmtField(f, l[f]);
    }
    const st = row.querySelector('[data-field="line_status"]');
    if (st && document.activeElement !== st) st.value = l.line_status;
    const note = row.querySelector('[data-field="note"]');
    if (note) note.placeholder = ["excluded", "tbd"].includes(l.line_status) ? "Why? (needed)" : "Note";
    const v = row.querySelector("[data-var]");
    if (v) {
      const b = budget?.get(l.id);
      const varc = b?.base != null && countsInTotal(l) ? Number(l.amount) - Number(b.base) : null;
      v.textContent = varc == null ? "" : signed(varc);
      v.classList.toggle("is-over", varc > 0); v.classList.toggle("is-under", varc < 0);
    }
  }

  function paintTotals() {
    const t = sovTotals(sheet, lines, budget);
    const set = (k, v) => { const n = el.querySelector(`[data-t="${k}"]`); if (n) n.textContent = v; };
    set("subtotal", money(t.subtotal)); set("ohp", money(t.ohp)); set("total", money(t.total));
    set("persf", t.perSf ? `$${NF2.format(t.perSf)}` : "—");
    set("prog", `${t.answered} of ${t.count} lines answered`);
    const bar = el.querySelector('[data-t="progbar"]'); if (bar) bar.style.transform = `scaleX(${t.count ? t.answered / t.count : 0})`;
    if (t.budget) {
      set("budget", money(t.budget.base)); set("variance", signed(t.budget.variance));
      const vn = el.querySelector('[data-t="variance"]'); if (vn) { vn.classList.toggle("is-over", t.budget.variance > 0); vn.classList.toggle("is-under", t.budget.variance <= 0); }
    }
    for (const sec of el.querySelectorAll("tbody[data-section]")) {
      const s = t.sections.get(sec.dataset.section);
      if (!s) continue;
      sec.querySelector("[data-sec-amt]").textContent = money(s.amount);
      sec.querySelector(".sov-sec__count").textContent = `${s.answered} of ${s.count}`;
      const sb = sec.querySelector("[data-sec-bud]"); if (sb) sb.textContent = s.budget ? money(s.budget) : "";
      const sv = sec.querySelector("[data-sec-var]"); if (sv) sv.textContent = s.pricedBudget ? signed(s.pricedAmt - s.pricedBudget) : "";
    }
    onStatus({ sheet, totals: t });
  }

  function paintStatus() {
    const n = el.querySelector("[data-save]");
    if (!n) return;
    const waiting = pending.size + inflight.size;
    let text = "", cls = "";
    if (retryTimer && pending.size) { text = `Offline · ${pending.size} change${pending.size > 1 ? "s" : ""} will save when you’re back`; cls = "is-offline"; }
    else if (inflight.size || pending.size) { text = "Saving…"; cls = "is-saving"; }
    else if (saveError) { text = "Last change didn’t save"; cls = "is-error"; }
    else if (editable()) { text = "All changes saved"; cls = "is-saved"; }
    n.textContent = text;
    n.className = `sov-save ${cls}`;
    n.dataset.waiting = String(waiting);
  }

  /* ---------------- editing */
  function applyInput(input) {
    const field = input.dataset.field;
    const l = lineById(input.dataset.line);
    if (!l) return;
    let value = input.value;
    if (NUM_FIELDS.has(field)) {
      value = parseNum(value);
      input.classList.toggle("is-invalid", Number.isNaN(value));
      if (Number.isNaN(value)) return;
    } else if (field !== "line_status") value = value.trim();
    if (field === "budget") {
      const b = budget.get(l.id) || { line_id: l.id, engagement_id: sheet.engagement_id };
      b.base = value; budget.set(l.id, b);
      queue(`budget:${l.id}`, "base", value);
    } else {
      if (field === "description" && !value) return;
      l[field] = value === "" ? null : value;
      if (field === "line_status") l.line_status = value;
      // Keep the amount in step with quantity × unit cost while typing; the database does the same.
      if ((field === "quantity" || field === "unit_cost") && l.quantity != null && l.unit_cost != null) l.amount = Math.round(l.quantity * l.unit_cost * 100) / 100;
      queue(`line:${l.id}`, field, l[field]);
    }
    paintLine(l);
    paintTotals();
  }

  function applySheetInput(input) {
    const name = input.dataset.sheet;
    let value = input.value;
    if (NUM_FIELDS.has(name)) {
      value = parseNum(value);
      input.classList.toggle("is-invalid", Number.isNaN(value));
      if (Number.isNaN(value)) return;
    } else value = value.trim() || null;
    sheet[name] = value;
    queue("sheet", name, value);
    paintTotals();
    if (name === "ohp_pct") { const lab = el.querySelector('[data-t="ohp"]')?.previousElementSibling; if (lab) lab.textContent = `OH&P${value != null ? ` ${NF2.format(value)}%` : ""}`; }
  }

  const gridInputs = () => [...el.querySelectorAll("tr.sov-row:not([hidden]) .sov-in")];
  function move(from, dRow, dCol) {
    const all = gridInputs();
    const fields = lineFields();
    const rows = [...new Set(all.map((i) => i.dataset.line))];
    let r = rows.indexOf(from.dataset.line) + dRow;
    let c = fields.indexOf(from.dataset.field) + dCol;
    if (c < 0) { c = fields.length - 1; r--; } else if (c >= fields.length) { c = 0; r++; }
    if (r < 0 || r >= rows.length) return false;
    const target = all.find((i) => i.dataset.line === rows[r] && i.dataset.field === fields[c]);
    if (!target) return false;
    target.focus();
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }

  /** Esc puts the cell back to what it held when you entered it (and saves that). */
  function revert(input) {
    if (input.dataset.orig === undefined || input.value === input.dataset.orig) return;
    input.value = input.dataset.orig;
    applyInput(input);
  }

  /** Paste a block (rows by newline, cells by tab) starting at the focused cell. */
  function paste(input, text) {
    const rowsText = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((r) => r.split("\t"));
    if (rowsText.length === 1 && rowsText[0].length === 1) return false;
    const all = gridInputs();
    const fields = lineFields();
    const rowIds = [...new Set(all.map((i) => i.dataset.line))];
    const r0 = rowIds.indexOf(input.dataset.line);
    const c0 = fields.indexOf(input.dataset.field);
    let n = 0;
    rowsText.forEach((cells, dr) => {
      const id = rowIds[r0 + dr];
      if (!id) return;
      cells.forEach((v, dc) => {
        const f = fields[c0 + dc];
        const target = f && all.find((i) => i.dataset.line === id && i.dataset.field === f);
        if (!target || target.readOnly) return;
        if (f === "line_status") {
          const match = LINE_STATUS.find(([k, label]) => k === v.trim().toLowerCase() || label.toLowerCase() === v.trim().toLowerCase());
          if (!match) return;
          target.value = match[0];
        } else target.value = v.trim();
        applyInput(target);
        if (NUM_FIELDS.has(f) && !target.classList.contains("is-invalid")) target.value = fmtField(f, f === "budget" ? budget.get(id)?.base : lineById(id)[f]);
        n++;
      });
    });
    if (n) toast(`Pasted ${n} cell${n > 1 ? "s" : ""}. Saving…`);
    return true;
  }

  /* ---------------- events */
  const on = (type, fn) => el.addEventListener(type, fn);
  on("input", (e) => {
    if (e.target.matches(".sov-in")) applyInput(e.target);
    else if (e.target.matches(".sov-sheet-in")) applySheetInput(e.target);
  });
  on("change", (e) => {
    if (e.target.matches("select.sov-in")) { applyInput(e.target); flush(`line:${e.target.dataset.line}`); }
    else if (e.target.matches("[data-filter]")) { filter = e.target.value; for (const l of lines) { const r = el.querySelector(`tr[data-row="${CSS.escape(l.id)}"]`); if (r) r.hidden = !visible(l); } }
  });
  // Entering a cell selects its contents, as in a spreadsheet, so typing replaces it. A click's
  // mouseup would clear that selection, so the first mouseup after focusing is swallowed.
  let selectOnUp = null;
  on("focusin", (e) => {
    if (!e.target.matches(".sov-in")) return;
    e.target.dataset.orig = e.target.value;
    if (e.target.tagName === "INPUT" && !e.target.readOnly) { try { e.target.select(); } catch (_) { /* gone */ } selectOnUp = e.target; }
  });
  on("mousedown", (e) => { if (e.target !== document.activeElement) selectOnUp = null; });
  on("mouseup", (e) => { if (selectOnUp && e.target === selectOnUp) { e.preventDefault(); selectOnUp = null; } });
  on("focusout", (e) => {
    const t = e.target;
    if (t.matches(".sov-in")) {
      const key = t.dataset.field === "budget" ? `budget:${t.dataset.line}` : `line:${t.dataset.line}`;
      if (pending.has(key)) flush(key);
      if (NUM_FIELDS.has(t.dataset.field) && !t.classList.contains("is-invalid")) {
        const l = lineById(t.dataset.line);
        if (l) t.value = fmtField(t.dataset.field, t.dataset.field === "budget" ? budget?.get(l.id)?.base : l[t.dataset.field]);
      }
    } else if (t.matches(".sov-sheet-in")) {
      if (pending.has("sheet")) flush("sheet");
      if (NUM_FIELDS.has(t.dataset.sheet) && !t.classList.contains("is-invalid")) t.value = fmtField(t.dataset.sheet, sheet[t.dataset.sheet]);
    }
  });
  on("keydown", (e) => {
    const t = e.target;
    if (!t.matches(".sov-in")) return;
    const isSelect = t.tagName === "SELECT";
    const atStart = !isSelect && t.selectionStart === 0 && t.selectionEnd === 0;
    const atEnd = !isSelect && t.selectionStart === t.value.length && t.selectionEnd === t.value.length;
    if (e.key === "Enter") { e.preventDefault(); move(t, e.shiftKey ? -1 : 1, 0); }
    else if (e.key === "Escape") { e.preventDefault(); revert(t); }
    else if (!isSelect && e.key === "ArrowDown") { e.preventDefault(); move(t, 1, 0); }
    else if (!isSelect && e.key === "ArrowUp") { e.preventDefault(); move(t, -1, 0); }
    else if (e.key === "ArrowRight" && (isSelect || atEnd || t.readOnly)) { if (move(t, 0, 1)) e.preventDefault(); }
    else if (e.key === "ArrowLeft" && (isSelect || atStart || t.readOnly)) { if (move(t, 0, -1)) e.preventDefault(); }
  });
  on("paste", (e) => {
    if (!e.target.matches(".sov-in")) return;
    const text = e.clipboardData?.getData("text/plain") || "";
    if (/[\t\n]/.test(text.replace(/\n$/, "")) && paste(e.target, text)) e.preventDefault();
  });
  on("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.hasAttribute("data-add-line")) {
        const section = b.dataset.addLine;
        const d = await promptDialog({ title: `Add a line${section ? ` to ${section}` : ""}`, label: "What the line covers", placeholder: "e.g. Grease interceptor", confirmLabel: "Add line", required: true, multiline: false });
        if (!d) return;
        const row = await store.sovAddLine(sheetId, section, d);
        if (!lineById(row.id)) lines.push(row);
        if (sheet.status === "not_started") sheet.status = "in_progress";
        render();
        el.querySelector(`[data-line="${CSS.escape(row.id)}"]`)?.focus();
      } else if (b.hasAttribute("data-add-section")) {
        const s = await promptDialog({ title: "Add a section", label: "Section name", placeholder: "e.g. Alternates", confirmLabel: "Next", required: true, multiline: false });
        if (!s) return;
        const d = await promptDialog({ title: `First line in ${s}`, label: "What the line covers", confirmLabel: "Add", required: true, multiline: false });
        if (!d) return;
        lines.push(await store.sovAddLine(sheetId, s, d));
        render();
      } else if (b.dataset.del) {
        const l = lineById(b.dataset.del);
        if (!l || !await confirmDialog({ title: "Remove this line?", body: `<p><strong>${esc(l.description)}</strong> is removed from the sheet for everyone.</p>`, confirmLabel: "Remove" })) return;
        await store.sovDeleteLine(l.id);
        pending.delete(`line:${l.id}`); persist();
        lines = lines.filter((x) => x.id !== l.id);
        render();
      } else if (b.dataset.ask) {
        const l = lineById(b.dataset.ask);
        const note = await promptDialog({ title: "Ask about this line", body: `<p class="p-muted">${esc(l.description)}. The contractor sees your question on the line. Leave it empty to clear it.</p>`, label: "Question", value: l.review_note || "", confirmLabel: "Save question" });
        if (note === null) return;
        await store.sovLineReview(l.id, note);
        l.review_note = note || null;
        render();
        toast(note ? "Question added to the line." : "Question cleared.");
      } else if (b.hasAttribute("data-submit")) {
        await submit();
      } else if (b.dataset.review) {
        await review(b.dataset.review === "accept");
      } else if (b.hasAttribute("data-reopen")) {
        if (!await confirmDialog({ title: "Reopen the sheet?", body: "<p>The contractor can edit it again. Submitted versions are kept.</p>", confirmLabel: "Reopen" })) return;
        await store.sovReopen(sheetId);
        await refresh();
        toast("Reopened.");
      } else if (b.hasAttribute("data-csv")) {
        download(`${slug(sheet.title)}-schedule-of-values.csv`, csv(sheet, lines, budget), "text/csv");
      } else if (b.dataset.versionCsv) {
        const v = await store.sovVersion(b.dataset.versionCsv);
        download(`${slug(sheet.title)}-v${v.version}.csv`, csv(v.snapshot.sheet, v.snapshot.lines, budget), "text/csv");
      } else if (b.hasAttribute("data-print")) {
        await flushAll();
        document.body.classList.add("is-printing-sov");
        window.print();
        setTimeout(() => document.body.classList.remove("is-printing-sov"), 500);
      }
    } catch (err) { toast(err.message, true); }
  });

  async function submit() {
    await flushAll();
    if (pending.size || inflight.size) throw new Error("Some changes haven’t saved yet. Check your connection and try again.");
    const open = lines.filter((l) => !lineAnswered(l));
    if (open.length) {
      filter = "open";
      render();
      const first = el.querySelector(`tr[data-row="${CSS.escape(open[0].id)}"] .sov-in`);
      first?.focus();
      throw new Error(`${open.length} line${open.length > 1 ? "s" : ""} still need a price, or a note saying why not. They’re shown now.`);
    }
    if (!sheet.valid_until) { el.querySelector('[data-sheet="valid_until"]')?.focus(); throw new Error("Add the date this price is valid until."); }
    const t = sovTotals(sheet, lines, null);
    const ok = await confirmDialog({
      title: "Submit this pricing?",
      body: `<p>Total <strong>${money(t.total)}</strong>${t.perSf ? ` ($${NF2.format(t.perSf)}/SF)` : ""}, valid until ${esc(fmtDate(sheet.valid_until))}.</p><p class="p-muted">The sheet locks while it’s reviewed, and a copy is kept as version ${sheet.version + 1}.</p>`,
      confirmLabel: "Submit",
    });
    if (!ok) return;
    await store.sovSubmit(sheetId);
    await refresh();
    toast("Submitted. Everyone on the owner side has been told.");
  }

  async function review(accept) {
    let note = null;
    if (accept) {
      if (!await confirmDialog({ title: "Accept this pricing?", body: `<p>Version ${sheet.version}, total <strong>${money(sovTotals(sheet, lines).total)}</strong>. The contractor is told it’s accepted.</p>`, confirmLabel: "Accept" })) return;
    } else {
      note = await promptDialog({ title: "Request changes", body: `<p class="p-muted">Say what needs to change. Questions you’ve added on individual lines are shown to the contractor too.</p>`, label: "What needs to change", required: true, confirmLabel: "Send back" });
      if (!note) return;
    }
    await store.sovReview(sheetId, accept, note);
    await refresh();
    toast(accept ? "Accepted." : "Sent back with your note.");
  }

  async function refresh() {
    await load();
    render();
    paintTotals();
  }

  /* ---------------- live updates */
  let unsubscribe = null;
  function onRemote({ table, eventType, new: row, old }) {
    if (destroyed) return;
    if (table === "sov_sheets") {
      if (!row?.id) return;
      const statusChanged = row.status !== sheet.status;
      merge(sheet, row, "sheet", { live: true });
      if (statusChanged) { refresh(); if (row.updated_at && role === "contractor") toast(`The sheet is now ${SHEET_STATUS[row.status]?.[0].toLowerCase()}.`); return; }
      for (const input of el.querySelectorAll(".sov-sheet-in")) if (document.activeElement !== input && !(input.dataset.sheet in (pending.get("sheet") || {}))) input.value = input.type === "date" ? (sheet[input.dataset.sheet] || "") : fmtField(input.dataset.sheet, sheet[input.dataset.sheet]);
      paintTotals();
      return;
    }
    if (eventType === "DELETE") {
      if (!old?.id || !lineById(old.id)) return;
      lines = lines.filter((l) => l.id !== old.id);
      render();
      return;
    }
    const l = lineById(row.id);
    if (!l) { lines.push(row); lines.sort((a, b) => a.position - b.position); render(); return; }
    const before = JSON.stringify([l.quantity, l.unit_cost, l.amount, l.line_status, l.note, l.unit, l.review_note]);
    const prevQuestion = l.review_note, prevDesc = l.description, prevHint = l.hint;
    merge(l, row, `line:${l.id}`, { live: true });
    paintLine(l);
    paintTotals();
    if (row.updated_by && row.updated_by !== me && before !== JSON.stringify([l.quantity, l.unit_cost, l.amount, l.line_status, l.note, l.unit, l.review_note])) {
      const r = el.querySelector(`tr[data-row="${CSS.escape(l.id)}"]`);
      if (r) { r.classList.remove("is-flash"); void r.offsetWidth; r.classList.add("is-flash"); r.title = `Updated by ${nameOf(row.updated_by)}`; }
    }
    if (l.review_note !== prevQuestion || l.description !== prevDesc || l.hint !== prevHint) {
      // A new or changed question or description: rebuild the row (unless someone is typing in it).
      const r = el.querySelector(`tr[data-row="${CSS.escape(l.id)}"]`);
      if (r && !r.contains(document.activeElement)) r.outerHTML = lineRow(l);
    }
  }

  const onUnload = (e) => { if (pending.size || inflight.size) { flushAll(); e.preventDefault(); e.returnValue = ""; } };
  const onOnline = () => { clearTimeout(retryTimer); retryTimer = null; retryDelay = 2000; flushAll(); };
  const onHide = () => { if (document.hidden) flushAll(); };
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onHide);

  await load();
  render();
  paintTotals();
  store.subscribe(`sov-${sheetId}`, [{ table: "sov_lines", filter: `sheet_id=eq.${sheetId}` }, { table: "sov_sheets", filter: `id=eq.${sheetId}` }], onRemote, (status) => {
    live = status === "SUBSCRIBED";
    const n = el.querySelector("[data-live]");
    if (n) { n.classList.toggle("is-on", live); n.textContent = live ? "Live" : status === "CLOSED" ? "Offline" : "Connecting…"; }
  }).then((u) => { if (destroyed) u(); else unsubscribe = u; }).catch((err) => console.warn("Live updates unavailable:", err.message));

  return {
    get sheet() { return sheet; },
    get waiting() { return pending.size + inflight.size; },
    flush: flushAll,
    destroy() {
      destroyed = true;
      flushAll();
      unsubscribe?.();
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onHide);
    },
  };
}

/* ------------------------------------------------------------ export */
const slug = (s) => String(s || "pricing").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const cellCsv = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** CSV of a sheet. Budget columns only when a budget map is given (owner side). */
export function csv(sheet, lines, budget = null) {
  const withBudget = budget && budget.size;
  const head = ["Section", "Code", "Description", "Quantity", "Unit", "Unit cost", "Amount", "Status", "Note", ...(withBudget ? ["Budget low", "Budget base", "Budget high", "Variance"] : [])];
  const rows = [head];
  for (const l of lines) {
    const b = budget?.get(l.id);
    const amt = l.amount == null ? "" : Number(l.amount);
    rows.push([l.section || "", l.code || "", l.description, l.quantity ?? "", l.unit || "", l.unit_cost ?? "", amt, STATUS_LABEL[l.line_status] || l.line_status, l.note || "",
      ...(withBudget ? [b?.low ?? "", b?.base ?? "", b?.high ?? "", b?.base != null && countsInTotal(l) ? Number(l.amount) - Number(b.base) : ""] : [])]);
  }
  const t = sovTotals(sheet, lines, withBudget ? budget : null);
  rows.push([], ["", "", "Subtotal", "", "", "", t.subtotal], ["", "", `Overhead & profit${sheet.ohp_pct != null ? ` (${sheet.ohp_pct}%)` : ""}`, "", "", "", t.ohp], ["", "", "Total", "", "", "", t.total]);
  if (t.perSf) rows.push(["", "", "Per SF", "", "", "", Math.round(t.perSf * 100) / 100]);
  if (t.budget) rows.push(["", "", "Budget (base)", "", "", "", t.budget.base], ["", "", "Variance", "", "", "", t.budget.variance]);
  rows.push([], ["Building area (SF)", sheet.building_sf ?? ""], ["Location", sheet.location || ""], ["Valid until", sheet.valid_until || ""],
    ["OH&P basis", sheet.ohp_basis || ""], ["Schedule", sheet.schedule_note || ""], ["Basis and exclusions", sheet.basis_note || ""]);
  return rows.map((r) => r.map(cellCsv).join(",")).join("\r\n");
}
