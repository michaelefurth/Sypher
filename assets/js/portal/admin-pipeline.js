// Admin: the path from first contact to signed work.
// Routes: #inquiries · #inquiry=<id> · #proposals · #proposal=<id>
import { store, isDemo, proposalLink, slugify, DEFAULT_TERMS } from "./store.js";
import { esc, paragraphs, fmtDate, relTime, toast, confirmDialog, statusPill } from "./ui.js";

const MODELS = [["fixed", "Fixed fee"], ["retainer", "Monthly retainer"], ["advisory", "Advisory"]];
const INQ_STATUS = [["new", "New"], ["reviewed", "Reviewed"], ["call_booked", "Call booked"], ["proposal", "Proposal"], ["closed", "Closed"]];
const today = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const lines = (text) => String(text || "").split("\n").map((x) => x.trim()).filter(Boolean);

function title(h, sub = "", actions = "") {
  return `<div class="admin__title"><div><h1>${h}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="btn-row">${actions}</div></div>`;
}

/* -------------------------------------------------------------- inquiries */
export async function viewInquiries() {
  const list = await store.inquiries();
  return title("Inquiries", "Every diagnostic from the contact page, with Claude’s brief for the first call.") + `
    <section class="p-card">${list.length ? `<div class="p-table-wrap" tabindex="0" role="region" aria-label="Inquiries"><table class="p-table">
      <thead><tr><th>Received</th><th>From</th><th>Regarding</th><th>Brief</th><th>Status</th><th><span class="visually-hidden">Open</span></th></tr></thead>
      <tbody>${list.map((i) => `<tr>
        <td class="p-muted">${esc(relTime(i.created_at))}</td>
        <td><strong>${esc(i.name)}</strong><br><span class="p-muted">${esc([i.role, i.company].filter(Boolean).join(", "))}</span></td>
        <td>${esc(i.practices.join(", "))}</td>
        <td>${statusPill(i.brief_status)}</td>
        <td>${statusPill(i.status)}</td>
        <td><a class="p-linkbtn" href="#inquiry=${esc(i.id)}">Open</a></td></tr>`).join("")}</tbody></table></div>`
      : `<p class="p-empty">No inquiries yet. They arrive from the diagnostic on the contact page.</p>`}</section>`;
}

function briefCard(i) {
  if (i.brief_status === "pending") return `<section class="p-card p-card--accent"><p class="p-kicker">Pre-call brief</p><p class="p-muted">Claude is reading the answers. Refresh in a minute.</p></section>`;
  if (i.brief_status === "failed") return `<section class="p-card p-card--accent"><p class="p-kicker">Pre-call brief</p><p class="p-muted">The brief couldn’t be generated: ${esc(i.brief_error || "unknown error")}. The answers are below.</p></section>`;
  if (!i.brief) return `<section class="p-card p-card--accent"><p class="p-kicker">Pre-call brief</p><p class="p-muted">No brief for this one (Claude isn’t configured). The answers are below.</p></section>`;
  const b = i.brief;
  return `<section class="p-card p-card--accent brief"><p class="p-kicker">Pre-call brief${i.brief_model ? ` · ${esc(i.brief_model)}` : ""}</p>
    ${paragraphs(b.summary)}
    ${b.in_their_words ? `<blockquote class="brief__quote">${esc(b.in_their_words)}</blockquote>` : ""}
    <div class="brief__grid">
      <div><h2 class="p-item">Ask on the call</h2><ol>${b.questions_for_the_call.map((q) => `<li>${esc(q)}</li>`).join("")}</ol></div>
      <div><h2 class="p-item">Likely practices</h2><ul>${b.likely_practices.map((p) => `<li><strong>${esc(p.practice)}</strong>: ${esc(p.why)}</li>`).join("")}</ul>
        ${b.fit_concerns.length ? `<h2 class="p-item">Watch for</h2><ul>${b.fit_concerns.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
        <h2 class="p-item">A first step</h2><p>${esc(b.suggested_first_step)}</p></div>
    </div></section>`;
}

export async function viewInquiry(id) {
  const i = await store.inquiry(id);
  window.__inquiry = i;
  const groups = [];
  for (const a of i.answers) {
    let g = groups.find((x) => x.section === a.section);
    if (!g) { g = { section: a.section, items: [] }; groups.push(g); }
    g.items.push(a);
  }
  const first = i.name.split(/\s+/)[0];
  const reply = `mailto:${encodeURIComponent(i.email)}?subject=${encodeURIComponent("Your notes, and a time to talk")}&body=${encodeURIComponent(`${first},\n\nThank you for the notes. I've read them, and I'd like to hear more about `)}`;
  return title(esc(i.name), `${esc([i.role, i.company].filter(Boolean).join(", "))} · received ${esc(fmtDate(i.created_at))}`,
    `${statusPill(i.status)}<button class="btn btn--navy btn--sm" data-start-proposal="${esc(i.id)}">Start a proposal</button>`) + `
    <div class="draft-grid">
      <div class="p-stack">
        ${briefCard(i)}
        <section class="p-card"><p class="p-kicker">Their answers</p>
          ${groups.map((g) => `<div class="inq-group"><h2 class="p-item">${esc(g.section)}</h2>${g.items.map((a) => `<p class="inq-q">${esc(a.question)}</p><div class="inq-a">${paragraphs(a.answer)}</div>`).join("")}</div>`).join("")}
        </section>
      </div>
      <div class="p-stack">
        <section class="p-card p-card--navy"><p class="p-kicker">Contact</p>
          <h3>${esc(i.name)}</h3>
          <p><a class="link-on-dark" href="mailto:${esc(i.email)}">${esc(i.email)}</a>${i.phone ? `<br>${esc(i.phone)}` : ""}</p>
          <p style="margin-top:1rem"><a class="btn btn--gold btn--sm" href="${esc(reply)}">Reply to set a time</a></p>
        </section>
        <section class="p-card"><p class="p-kicker">Your notes</p>
          <form class="p-form" id="inquiry-form">
            <div class="p-field"><label for="inq-status">Status</label><select class="p-select" id="inq-status" name="status">${INQ_STATUS.map(([v, l]) => `<option value="${v}"${i.status === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
            <div class="p-field"><label for="inq-notes">Private notes</label><textarea class="p-textarea" id="inq-notes" name="admin_notes" rows="5">${esc(i.admin_notes || "")}</textarea></div>
            <button class="btn btn--navy btn--sm" type="submit">Save</button>
          </form>
        </section>
        ${i.proposals?.length ? `<section class="p-card"><p class="p-kicker">Proposals</p><ul class="p-list">${i.proposals.map((p) => `<li class="p-row"><a href="#proposal=${esc(p.id)}">${esc(p.title || "Untitled")}</a>${statusPill(p.status)}</li>`).join("")}</ul></section>` : ""}
      </div>
    </div>`;
}

/* -------------------------------------------------------------- proposals */
export async function viewProposals() {
  const list = await store.proposals();
  return title("Proposals", "Private pages your clients read, choose from and sign. Each link is unique and unlisted.",
    `<button class="btn btn--navy btn--sm" data-new-proposal>New proposal</button>`) + `
    <section class="p-card">${list.length ? `<div class="p-table-wrap" tabindex="0" role="region" aria-label="Proposals"><table class="p-table">
      <thead><tr><th>Proposal</th><th>Status</th><th>Views</th><th>Last opened</th><th>Valid until</th><th><span class="visually-hidden">Open</span></th></tr></thead>
      <tbody>${list.map((p) => `<tr>
        <td><strong>${esc(p.title || "Untitled")}</strong><br><span class="p-muted">${esc([p.client_name, p.company].filter(Boolean).join(", "))}</span></td>
        <td>${statusPill(p.status)}</td>
        <td class="num">${p.view_count || 0}</td>
        <td class="p-muted">${p.last_viewed_at ? esc(relTime(p.last_viewed_at)) : "Not yet"}</td>
        <td class="p-muted">${p.valid_until ? esc(fmtDate(p.valid_until, { month: "short", day: "numeric" })) : ""}</td>
        <td><a class="p-linkbtn" href="#proposal=${esc(p.id)}">Open</a></td></tr>`).join("")}</tbody></table></div>`
      : `<p class="p-empty">No proposals yet. Start one from an inquiry, or from scratch.</p>`}</section>`;
}

function phaseBlock(ph = {}) {
  return `<fieldset class="rep rep--phase"><legend>Phase</legend>
    <div class="p-form p-form--2">
      <div class="p-field"><label>Name<input class="p-input" data-f="name" value="${esc(ph.name || "")}"></label></div>
      <div class="p-field"><label>Duration<input class="p-input" data-f="duration" value="${esc(ph.duration || "")}" placeholder="Weeks 1–3"></label></div>
      <div class="p-field p-span"><label>What happens<textarea class="p-textarea" data-f="detail" rows="2">${esc(ph.detail || "")}</textarea></label></div>
      <div class="p-field p-span"><label>Deliverables, one per line<textarea class="p-textarea" data-f="deliverables" rows="2">${esc((ph.deliverables || []).join("\n"))}</textarea></label></div>
    </div><button type="button" class="p-linkbtn" data-remove>Remove phase</button></fieldset>`;
}

function optionBlock(o = {}) {
  return `<fieldset class="rep rep--option" data-id="${esc(o.id || "")}"><legend>Option</legend>
    <div class="p-form p-form--2">
      <div class="p-field"><label>Name<input class="p-input" data-f="name" value="${esc(o.name || "")}"></label></div>
      <div class="p-field"><label>Model<select class="p-select" data-f="model">${MODELS.map(([v, l]) => `<option value="${v}"${o.model === v ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <div class="p-field"><label>Fee<input class="p-input" data-f="fee" value="${esc(o.fee || "")}" placeholder="$16,500 fixed"></label></div>
      <div class="p-field"><label>Timeline<input class="p-input" data-f="timeline" value="${esc(o.timeline || "")}" placeholder="8 weeks"></label></div>
      <div class="p-field p-span"><label>Fee note<input class="p-input" data-f="fee_note" value="${esc(o.fee_note || "")}" placeholder="Invoiced half at signing"></label></div>
      <div class="p-field p-span"><label>Includes, one per line<textarea class="p-textarea" data-f="includes" rows="3">${esc((o.includes || []).join("\n"))}</textarea></label></div>
      <label class="rep__check"><input type="checkbox" data-f="recommended"${o.recommended ? " checked" : ""}> Recommended</label>
    </div><button type="button" class="p-linkbtn" data-remove>Remove option</button></fieldset>`;
}

export async function viewProposal(id) {
  const p = await store.proposal(id);
  window.__proposal = p;
  const c = p.content || {};
  const link = proposalLink(p);
  const locked = ["accepted", "declined"].includes(p.status);
  const opt = (c.options || []).find((o) => o.id === p.accepted_option);
  const first = (p.client_name || "").split(/\s+/)[0];
  const mail = `mailto:${encodeURIComponent(p.client_email || "")}?subject=${encodeURIComponent(`Proposal: ${p.title}`)}&body=${encodeURIComponent(`${first ? `${first},\n\n` : ""}As promised, here is the proposal we discussed. It's a private page made for you; the options and fees are near the end, and you can accept there when you're ready.\n\n${link}\n\nMichael`)}`;
  return title(esc(p.title || "Untitled proposal"), esc([p.client_name, p.company].filter(Boolean).join(", ")), statusPill(p.status)) + `
    <div class="draft-grid">
      <form class="p-stack" id="proposal-form">
        <fieldset class="p-card prop-edit" ${locked ? "disabled" : ""}>
          <legend class="p-kicker">The essentials</legend>
          ${locked ? `<p class="p-muted">This proposal has a response, so it’s locked. Start a new one to change terms.</p>` : ""}
          <div class="p-form p-form--2">
            <div class="p-field p-span"><label for="pp-title">Title</label><input class="p-input" id="pp-title" name="title" value="${esc(p.title || "")}" required></div>
            <div class="p-field"><label for="pp-name">Client name</label><input class="p-input" id="pp-name" name="client_name" value="${esc(p.client_name || "")}"></div>
            <div class="p-field"><label for="pp-email">Client email</label><input class="p-input" id="pp-email" name="client_email" type="email" value="${esc(p.client_email || "")}"></div>
            <div class="p-field"><label for="pp-company">Company</label><input class="p-input" id="pp-company" name="company" value="${esc(p.company || "")}"></div>
            <div class="p-field"><label for="pp-valid">Valid until</label><input class="p-input" id="pp-valid" name="valid_until" type="date" value="${esc(p.valid_until || "")}"></div>
            <div class="p-field p-span"><label for="pp-slug">Link name</label><input class="p-input" id="pp-slug" name="slug" value="${esc(p.slug || "")}" placeholder="mesa-line"><span class="p-muted">Shown in the link before the private key: …/for/?p=<strong>${esc(p.slug || "name")}</strong>.••••</span></div>
          </div>
        </fieldset>
        <fieldset class="p-card prop-edit" ${locked ? "disabled" : ""}>
          <legend class="p-kicker">Letter and situation</legend>
          <div class="p-form">
            <div class="p-field"><label for="pp-letter">A note from you</label><textarea class="p-textarea" id="pp-letter" name="letter" rows="8">${esc(c.letter || "")}</textarea></div>
            <div class="p-field"><label for="pp-quote">In their words</label><textarea class="p-textarea" id="pp-quote" name="situation_quote" rows="2">${esc(c.situation_quote || "")}</textarea></div>
            <div class="p-field"><label for="pp-sit">The situation as you understand it</label><textarea class="p-textarea" id="pp-sit" name="situation" rows="4">${esc(c.situation || "")}</textarea></div>
            <div class="p-field"><label for="pp-obj">Objectives, one per line</label><textarea class="p-textarea" id="pp-obj" name="objectives" rows="4">${esc((c.objectives || []).join("\n"))}</textarea></div>
          </div>
        </fieldset>
        <fieldset class="p-card prop-edit" ${locked ? "disabled" : ""}>
          <legend class="p-kicker">Plan</legend>
          <div data-list="phases">${(c.phases || []).map(phaseBlock).join("")}</div>
          <button type="button" class="btn btn--ghost btn--sm" data-add="phase">Add a phase</button>
          <div class="p-field" style="margin-top:1.5rem"><label for="pp-tl">Milestones, one per line as <em>when | milestone</em></label><textarea class="p-textarea" id="pp-tl" name="timeline" rows="4" placeholder="Week 1 | Kickoff">${esc((c.timeline || []).map((t) => `${t.when} | ${t.milestone}`).join("\n"))}</textarea></div>
        </fieldset>
        <fieldset class="p-card prop-edit" ${locked ? "disabled" : ""}>
          <legend class="p-kicker">Options and fees</legend>
          <div data-list="options">${(c.options || []).map(optionBlock).join("")}</div>
          <button type="button" class="btn btn--ghost btn--sm" data-add="option">Add an option</button>
        </fieldset>
        <fieldset class="p-card prop-edit" ${locked ? "disabled" : ""}>
          <legend class="p-kicker">Terms and next steps</legend>
          <div class="p-form">
            <div class="p-field"><label for="pp-terms">Terms, in brief</label><textarea class="p-textarea" id="pp-terms" name="terms" rows="8">${esc(c.terms ?? DEFAULT_TERMS)}</textarea><span class="p-muted">Starting text only. Match it to your engagement letter.</span></div>
            <div class="p-field"><label for="pp-next">Next steps</label><textarea class="p-textarea" id="pp-next" name="next_steps" rows="3">${esc(c.next_steps || "")}</textarea></div>
          </div>
          ${locked ? "" : `<button class="btn btn--navy btn--sm" type="submit">Save proposal</button>`}
        </fieldset>
      </form>
      <div class="p-stack">
        <section class="p-card p-card--navy"><p class="p-kicker">Link</p>
          <p class="prop-link">${esc(link)}</p>
          <div class="btn-row" style="gap:.6rem">
            <a class="btn btn--gold btn--sm" href="${esc(link)}" target="_blank" rel="noopener">Preview</a>
            <button type="button" class="btn btn--ghost btn--sm btn--on-dark" data-copy-link>Copy link</button>
          </div>
          ${p.status === "draft" ? `<p style="margin-top:1rem;font-size:.85rem">Clients can’t open a draft. Mark it as sent when it’s ready.</p>` : ""}
        </section>
        <section class="p-card"><p class="p-kicker">Status</p>
          ${p.status === "draft" ? `<div class="btn-row"><button class="btn btn--navy btn--sm" data-proposal-status="sent">Mark as sent</button></div>` : ""}
          ${["sent", "viewed"].includes(p.status) ? `<p><a class="btn btn--navy btn--sm" href="${esc(mail)}">Email the link</a></p>` : ""}
          <dl class="prop-stats">
            <div><dt>Sent</dt><dd>${p.sent_at ? esc(fmtDate(p.sent_at)) : "Not yet"}</dd></div>
            <div><dt>Opened</dt><dd>${p.view_count || 0} time${p.view_count === 1 ? "" : "s"}${p.last_viewed_at ? `, last ${esc(relTime(p.last_viewed_at))}` : ""}</dd></div>
            ${p.valid_until ? `<div><dt>Valid until</dt><dd>${esc(fmtDate(p.valid_until))}</dd></div>` : ""}
          </dl>
          ${p.status === "accepted" ? `<div class="prop-accepted"><p class="p-item">Accepted ${esc(fmtDate(p.responded_at))}</p>
            <p>${esc(p.signer_name)}${p.signer_title ? `, ${esc(p.signer_title)}` : ""}<br><span class="p-muted">${esc(p.signer_email || "")}</span></p>
            ${opt ? `<p><strong>${esc(opt.name)}</strong>${opt.fee ? ` · ${esc(opt.fee)}` : ""}</p>` : ""}
            ${p.engagement_id ? `<a class="btn btn--navy btn--sm" href="#engagement=${esc(p.engagement_id)}">Open the client room</a>`
              : `<button class="btn btn--navy btn--sm" data-open-engagement>Open the engagement</button><p class="p-muted" style="margin-top:.6rem">Invites ${esc(p.signer_email || p.client_email || "the client")} to their client room, with milestones from this proposal.</p>`}
          </div>` : ""}
          ${p.status === "declined" ? `<p><strong>Declined</strong> ${esc(fmtDate(p.responded_at))}</p>${p.decline_reason ? `<blockquote class="brief__quote">${esc(p.decline_reason)}</blockquote>` : ""}` : ""}
          ${["sent", "viewed"].includes(p.status) ? `<p style="margin-top:1rem"><button class="p-linkbtn" data-proposal-status="withdrawn">Withdraw</button></p>` : ""}
          ${p.status === "withdrawn" ? `<p style="margin-top:1rem"><button class="p-linkbtn" data-proposal-status="draft">Return to draft</button></p>` : ""}
        </section>
        ${p.inquiry_id ? `<section class="p-card"><p class="p-kicker">From inquiry</p><a class="p-linkbtn" href="#inquiry=${esc(p.inquiry_id)}">Open the diagnostic</a></section>` : ""}
      </div>
    </div>`;
}

function readProposalForm(form) {
  const v = (n) => form.querySelector(`[name="${n}"]`).value.trim();
  const blocks = (sel) => [...form.querySelectorAll(sel)].map((b) => {
    const o = {};
    b.querySelectorAll("[data-f]").forEach((el) => { o[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value.trim(); });
    return { el: b, o };
  });
  const phases = blocks(".rep--phase").map(({ o }) => ({ name: o.name, duration: o.duration, detail: o.detail, deliverables: lines(o.deliverables) })).filter((x) => x.name);
  const used = new Set();
  const options = blocks(".rep--option").filter(({ o }) => o.name).map(({ el, o }) => {
    let id = el.dataset.id || slugify(o.name) || "option";
    while (used.has(id)) id += "-2";
    used.add(id);
    return { id, name: o.name, model: o.model, fee: o.fee, fee_note: o.fee_note, timeline: o.timeline, includes: lines(o.includes), recommended: !!o.recommended };
  });
  const timeline = lines(v("timeline")).map((l) => { const [when, ...rest] = l.split("|"); return rest.length ? { when: when.trim(), milestone: rest.join("|").trim() } : { when: "", milestone: when.trim() }; });
  return {
    title: v("title"), client_name: v("client_name") || null, client_email: v("client_email") || null, company: v("company") || null,
    valid_until: v("valid_until") || null, slug: slugify(v("slug")) || null,
    content: { letter: v("letter"), situation_quote: v("situation_quote"), situation: v("situation"), objectives: lines(v("objectives")), phases, options, timeline, terms: v("terms"), next_steps: v("next_steps") },
  };
}

export async function pipelineSubmit(form, route) {
  if (form.id === "inquiry-form") {
    await store.updateInquiry(window.__inquiry.id, { status: form.querySelector("[name=status]").value, admin_notes: form.querySelector("[name=admin_notes]").value });
    toast("Saved.");
    return true;
  }
  if (form.id === "proposal-form") {
    const data = readProposalForm(form);
    if (!data.title) throw new Error("Give the proposal a title.");
    if (!data.content.options.length) throw new Error("Add at least one option.");
    await store.updateProposal(window.__proposal.id, data);
    toast("Proposal saved.");
    route();
    return true;
  }
  return false;
}

async function startProposal(inquiryId) {
  const i = inquiryId ? await store.inquiry(inquiryId) : null;
  const b = i?.brief?.proposal_outline;
  const first = (i?.name || "").split(/\s+/)[0];
  const longest = i ? [...i.answers].sort((x, y) => y.answer.length - x.answer.length)[0]?.answer || "" : "";
  const model = b?.engagement_model || "fixed";
  const id = await store.createProposal({
    title: b?.title || (i ? `${i.company || i.name}: a proposal` : "New proposal"),
    client_name: i?.name || null, client_email: i?.email || null, company: i?.company || null,
    slug: slugify(i?.company || i?.name || "") || null, valid_until: today(30), inquiry_id: i?.id || null,
    content: {
      letter: first ? `${first},\n\nThank you for the time on our call. Below is how I'd approach what you described, in the order I'd do it.` : "",
      situation_quote: i?.brief?.in_their_words || longest.split(/(?<=[.!?])\s/)[0] || "",
      situation: "",
      objectives: b?.objectives || [],
      phases: (b?.phases || []).map((ph) => ({ ...ph, deliverables: [] })),
      options: [
        { id: "build", name: "Defined project", model: "fixed", fee: "", fee_note: "", timeline: "", includes: [], recommended: model === "fixed" },
        { id: "embed", name: "Fractional", model: "retainer", fee: "", fee_note: "", timeline: "", includes: [], recommended: model === "retainer" },
        { id: "advise", name: "Advisory", model: "advisory", fee: "", fee_note: "", timeline: "", includes: [], recommended: model === "advisory" },
      ],
      timeline: [],
      terms: DEFAULT_TERMS,
      next_steps: "Choose an option above and sign below. I'll send a short engagement letter and we'll set the kickoff.",
    },
  });
  if (i) await store.updateInquiry(i.id, { status: "proposal" });
  location.hash = `proposal=${id}`;
  toast("Proposal started. Edit it, then mark it as sent.");
}

async function openEngagement(p, route) {
  const email = p.signer_email || p.client_email;
  if (!email) throw new Error("Add the client’s email to the proposal first.");
  const ok = await confirmDialog({
    title: "Open the engagement?",
    body: `<p>This creates the client room for <strong>${esc(p.company || p.client_name || email)}</strong>${isDemo ? "" : ` and emails ${esc(email)} a sign-in link`}. Milestones are copied from the proposal.</p>`,
    confirmLabel: "Open engagement",
  });
  if (!ok) return;
  const c = p.content || {};
  const r = await store.inviteClient({
    email, full_name: p.signer_name || p.client_name || "", company: p.company || "",
    engagement_title: p.title, engagement_summary: (c.objectives || []).slice(0, 3).join(". ") + ((c.objectives || []).length ? "." : ""),
  });
  await store.updateProposal(p.id, { engagement_id: r.engagement_id });
  const items = (c.timeline || []).length ? c.timeline.map((t) => ({ title: t.milestone, due_label: t.when })) : (c.phases || []).map((ph) => ({ title: ph.name, due_label: ph.duration }));
  for (const [n, m] of items.entries()) {
    await store.saveMilestone({ engagement_id: r.engagement_id, position: n + 1, title: m.title, due_label: m.due_label || null, status: n === 0 ? "current" : "upcoming" });
  }
  await store.updateEngagement(r.engagement_id, { kickoff_date: today() });
  toast("Engagement opened.");
  location.hash = `engagement=${r.engagement_id}`;
  route();
}

export async function pipelineClick(t, route) {
  if (t.dataset.startProposal) { t.disabled = true; await startProposal(t.dataset.startProposal); return true; }
  if (t.hasAttribute("data-new-proposal")) { await startProposal(null); return true; }
  if (t.dataset.add) {
    const list = document.querySelector(`[data-list="${t.dataset.add === "phase" ? "phases" : "options"}"]`);
    list.insertAdjacentHTML("beforeend", t.dataset.add === "phase" ? phaseBlock() : optionBlock());
    list.lastElementChild.querySelector("input")?.focus();
    return true;
  }
  if (t.hasAttribute("data-remove")) { t.closest(".rep").remove(); return true; }
  if (t.hasAttribute("data-copy-link")) {
    await navigator.clipboard.writeText(proposalLink(window.__proposal));
    toast("Link copied.");
    return true;
  }
  if (t.dataset.proposalStatus) {
    const s = t.dataset.proposalStatus;
    const p = window.__proposal;
    if (s === "sent") {
      if (!(p.content?.options || []).length) throw new Error("Add at least one option and save before sending.");
      if (!(await confirmDialog({ title: "Mark as sent?", body: "<p>The link starts working for the client. Then use “Email the link”, or paste it into your own message.</p>", confirmLabel: "Mark as sent" }))) return true;
    }
    if (s === "withdrawn" && !(await confirmDialog({ title: "Withdraw this proposal?", body: "<p>The link stops working. You can return it to draft later.</p>", confirmLabel: "Withdraw" }))) return true;
    await store.updateProposal(p.id, { status: s, ...(s === "sent" ? { sent_at: new Date().toISOString() } : {}) });
    toast(s === "sent" ? "Marked as sent. The link is live." : "Updated.");
    route();
    return true;
  }
  if (t.hasAttribute("data-open-engagement")) { await openEngagement(window.__proposal, route); return true; }
  return false;
}
