// A private proposal, opened from the link Michael sends: /for/?p=<slug>.<token>
// No sign-in. The token is the key; the server returns only what the client may see.
import { store, isDemo, tokenFromParam } from "./portal/store.js";
import { esc, paragraphs, fmtDate } from "./portal/ui.js";

const main = document.getElementById("main");
const token = tokenFromParam(new URLSearchParams(location.search).get("p"));
const MODEL = { fixed: "Fixed fee", retainer: "Monthly retainer", advisory: "Advisory" };
const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
let proposal = null;

function notFound() {
  main.innerHTML = `<section class="prop-empty container">
    <p class="eyebrow">Private proposal</p>
    <h1>This link isn’t active.</h1>
    <p>It may have been mistyped, replaced by a newer version or withdrawn. Michael can send you the current one.</p>
    <p><a class="btn btn--navy" href="mailto:michael@sypher.solutions?subject=Proposal%20link">Email Michael</a></p>
  </section>`;
}

// Terms read like a contract summary: a bold lead-in ("Fees.") then the clause.
function terms(text) {
  return String(text || "").trim().split(/\n{2,}/).map((para) => {
    const m = para.match(/^([A-Z][^.\n]{1,28}\.)\s+([\s\S]*)$/);
    return m ? `<p><strong>${esc(m[1])}</strong> ${esc(m[2]).replace(/\n/g, "<br>")}</p>` : `<p>${esc(para).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

function option(o, i) {
  const chosen = proposal.accepted_option === o.id;
  const open = ["sent", "viewed"].includes(proposal.status) && !proposal.expired;
  return `<article class="opt${o.recommended ? " opt--rec" : ""}${chosen ? " opt--chosen" : ""}">
    ${o.recommended ? `<p class="opt__badge">Recommended</p>` : ""}
    ${chosen ? `<p class="opt__badge opt__badge--ok">Accepted</p>` : ""}
    <p class="opt__num">Option ${ROMAN[i] || i + 1}</p>
    <h3 class="opt__name">${esc(o.name)}</h3>
    <p class="opt__model">${esc(MODEL[o.model] || "")}${o.timeline ? ` · ${esc(o.timeline)}` : ""}</p>
    <p class="opt__fee">${esc(o.fee || "To be agreed")}</p>
    ${o.fee_note ? `<p class="opt__note">${esc(o.fee_note)}</p>` : ""}
    ${(o.includes || []).length ? `<ul class="opt__list">${o.includes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${open ? `<label class="opt__pick"><input type="radio" name="option" value="${esc(o.id)}"${o.recommended ? " checked" : ""}><span>Choose this option</span></label>` : ""}
  </article>`;
}

function responseBlock() {
  const c = proposal.content || {};
  const options = c.options || [];
  if (proposal.status === "accepted") {
    const o = options.find((x) => x.id === proposal.accepted_option);
    return `<div class="prop-seal">
      <p class="prop-seal__kicker">Accepted</p>
      <p class="prop-seal__sig">${esc(proposal.signer_name)}</p>
      <p class="prop-seal__meta">${esc(proposal.signer_title || "")}${proposal.signer_title ? " · " : ""}${esc(fmtDate(proposal.responded_at))}</p>
      ${o ? `<p class="prop-seal__opt">${esc(o.name)}${o.fee ? ` · ${esc(o.fee)}` : ""}</p>` : ""}
      <p>Thank you. Michael will be in touch to schedule the kickoff, and you’ll receive an invitation to your private client room, where the plan, milestones and every update will live.</p>
    </div>`;
  }
  if (proposal.status === "declined") {
    return `<div class="prop-seal prop-seal--muted"><p class="prop-seal__kicker">Declined</p><p>Thank you for letting Michael know. If the timing or the scope changes, he’d be glad to revisit it.</p></div>`;
  }
  if (proposal.expired) {
    return `<div class="prop-seal prop-seal--muted"><p class="prop-seal__kicker">This proposal has expired</p><p>Fees and timing were held until ${esc(fmtDate(proposal.valid_until))}. <a class="accent" href="mailto:michael@sypher.solutions?subject=${encodeURIComponent(`Updated proposal: ${proposal.title}`)}">Ask Michael for an updated version.</a></p></div>`;
  }
  if (proposal.status === "draft" || proposal.status === "withdrawn") {
    return `<div class="prop-seal prop-seal--muted"><p class="prop-seal__kicker">Preview</p><p>The acceptance form appears here once the proposal is sent.</p></div>`;
  }
  return `<form class="prop-accept" id="accept-form" novalidate>
    <div class="prop-accept__choice" aria-live="polite"></div>
    <div class="form prop-accept__fields">
      <div class="field"><label for="sig-name">Full name</label><input id="sig-name" name="name" autocomplete="name" required value="${esc(proposal.client_name || "")}"></div>
      <div class="field"><label for="sig-title">Title</label><input id="sig-title" name="title" autocomplete="organization-title"></div>
      <div class="field form__full"><label for="sig-email">Email</label><input id="sig-email" name="email" type="email" autocomplete="email" required></div>
      <div class="form__full prop-accept__sig" aria-hidden="true"><span class="prop-accept__line"></span><span class="prop-accept__preview"></span></div>
      <label class="prop-accept__agree form__full"><input type="checkbox" name="agree" required> <span>I accept this proposal and the terms above, and authorize Sypher Solutions to begin. Typing my name serves as my signature.</span></label>
    </div>
    <p class="prop-accept__error" role="alert"></p>
    <div class="btn-row btn-row--between">
      <details class="prop-decline"><summary>Not the right fit?</summary>
        <div class="field"><label for="decline-note">A note for Michael (optional)</label><textarea id="decline-note" rows="3"></textarea></div>
        <button type="button" class="btn btn--ghost btn--sm" data-decline>Decline this proposal</button>
      </details>
      <button class="btn btn--gold" type="submit">Accept and sign
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M1 8h13M9 3l5 5-5 5"/></svg></button>
    </div>
  </form>`;
}

function render() {
  const p = proposal;
  const c = p.content || {};
  const who = [p.client_name, p.company].filter(Boolean).join(", ");
  document.title = `${p.title} | Sypher Solutions`;
  const letterParas = String(c.letter || "").trim().split(/\n{2,}/);
  main.innerHTML = `
  ${isDemo ? `<p class="prop-demo"><strong>Demo mode</strong> A fictional sample, saved only in this browser.</p>` : ""}
  ${p.status === "draft" ? `<p class="prop-demo"><strong>Draft preview</strong> Only you can see this. The client sees it once it’s marked as sent.</p>` : ""}
  <section class="prop-cover">
    <img class="prop-cover__mark" src="../assets/img/sypher-mark-480.webp" alt="" width="375" height="483">
    <div class="container">
      <p class="prop-cover__kicker">Proposal${who ? ` · Prepared for ${esc(who)}` : ""}</p>
      <h1 class="prop-cover__title">${esc(p.title)}</h1>
      <span class="prop-cover__rule"></span>
      <dl class="prop-cover__meta">
        <div><dt>From</dt><dd>Michael Furth, Managing Principal</dd></div>
        <div><dt>Date</dt><dd>${esc(fmtDate(p.sent_at))}</dd></div>
        ${p.valid_until ? `<div><dt>Valid until</dt><dd>${esc(fmtDate(p.valid_until))}</dd></div>` : ""}
      </dl>
    </div>
  </section>

  ${c.letter ? `<section class="prop-sec prop-letter"><div class="container container--narrow">
    <p class="eyebrow">A note from Michael</p>
    <div class="prop-letter__body">${letterParas.map((x) => `<p>${esc(x).replace(/\n/g, "<br>")}</p>`).join("")}</div>
    <p class="prop-letter__sign">Michael Furth</p><p class="prop-letter__role">Managing Principal, Sypher Solutions</p>
  </div></section>` : ""}

  ${c.situation_quote || c.situation ? `<section class="prop-sec prop-sec--stone"><div class="container prop-two">
    <div><p class="eyebrow">What we heard</p>${c.situation_quote ? `<blockquote class="prop-quote">${esc(c.situation_quote)}</blockquote>` : ""}</div>
    <div class="prop-prose">${paragraphs(c.situation)}</div>
  </div></section>` : ""}

  ${(c.objectives || []).length ? `<section class="prop-sec"><div class="container prop-two">
    <div><p class="eyebrow">What this sets out to do</p><h2 class="prop-h2">By the end, you <em>will have</em></h2></div>
    <ol class="prop-objectives">${c.objectives.map((o, i) => `<li><span>${ROMAN[i] || i + 1}.</span>${esc(o)}</li>`).join("")}</ol>
  </div></section>` : ""}

  ${(c.phases || []).length ? `<section class="prop-sec prop-sec--dark"><div class="container">
    <p class="eyebrow">How the work runs</p><h2 class="prop-h2">The plan, <em>phase by phase</em></h2>
    <ol class="prop-phases">${c.phases.map((ph, i) => `<li>
      <p class="prop-phases__n">${String(i + 1).padStart(2, "0")}${ph.duration ? ` · ${esc(ph.duration)}` : ""}</p>
      <h3>${esc(ph.name)}</h3><p>${esc(ph.detail || "")}</p>
      ${(ph.deliverables || []).length ? `<ul>${ph.deliverables.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
    </li>`).join("")}</ol>
  </div></section>` : ""}

  ${(c.timeline || []).length ? `<section class="prop-sec"><div class="container">
    <p class="eyebrow">Milestones</p>
    <ol class="prop-timeline" tabindex="0" aria-label="Milestones">${c.timeline.map((t) => `<li><span class="prop-timeline__when">${esc(t.when)}</span><span class="prop-timeline__what">${esc(t.milestone)}</span></li>`).join("")}</ol>
  </div></section>` : ""}

  ${(c.options || []).length ? `<section class="prop-sec prop-sec--stone" id="options"><div class="container">
    <p class="eyebrow">Options and fees</p><h2 class="prop-h2">Choose the <em>shape that fits</em></h2>
    <div class="prop-options">${c.options.map(option).join("")}</div>
  </div></section>` : ""}

  ${c.terms ? `<section class="prop-sec"><div class="container prop-two">
    <div><p class="eyebrow">Terms, in brief</p><p class="prop-muted">A short engagement letter follows signature and governs the work.</p></div>
    <div class="prop-terms">${terms(c.terms)}</div>
  </div></section>` : ""}

  <section class="prop-sec prop-sec--respond" id="respond"><div class="container container--narrow">
    <p class="eyebrow">Next</p>
    ${c.next_steps ? `<p class="prop-next">${esc(c.next_steps)}</p>` : ""}
    ${responseBlock()}
  </div></section>`;

  document.querySelector("[data-print]").hidden = false;
  bindForm();
}

function bindForm() {
  const form = document.getElementById("accept-form");
  if (!form) return;
  const choice = form.querySelector(".prop-accept__choice");
  const preview = form.querySelector(".prop-accept__preview");
  const options = proposal.content.options || [];
  const f = (n) => form.querySelector(`[name="${n}"]`);
  const update = () => {
    const id = main.querySelector('input[name="option"]:checked')?.value;
    const o = options.find((x) => x.id === id);
    choice.innerHTML = o ? `<span>You’re accepting</span><strong>${esc(o.name)}</strong>${o.fee ? `<em>${esc(o.fee)}</em>` : ""}` : `<span>Choose an option above to continue.</span>`;
    preview.textContent = f("name").value;
  };
  main.addEventListener("change", update);
  form.addEventListener("input", update);
  update();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector(".prop-accept__error");
    const id = main.querySelector('input[name="option"]:checked')?.value;
    if (!id) { err.textContent = "Choose one of the options above."; return; }
    if (f("name").value.trim().length < 2) { err.textContent = "Type your full name to sign."; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f("email").value.trim())) { err.textContent = "Add a valid email for your confirmation."; return; }
    if (!f("agree").checked) { err.textContent = "Tick the box to confirm you accept."; return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      proposal = await store.respondProposal(token, "accept", { option: id, name: f("name").value, title: f("title").value, email: f("email").value });
      render();
      document.getElementById("respond").scrollIntoView({ block: "start" });
    } catch (error) { err.textContent = error.message; btn.disabled = false; }
  });

  form.querySelector("[data-decline]").addEventListener("click", async () => {
    if (!confirm("Decline this proposal? Michael will be told, along with your note.")) return;
    try {
      proposal = await store.respondProposal(token, "decline", { reason: form.querySelector("#decline-note").value.trim() });
      render();
    } catch (error) { form.querySelector(".prop-accept__error").textContent = error.message; }
  });
}

document.querySelector("[data-print]").addEventListener("click", () => window.print());

(async () => {
  if (!token) return notFound();
  try {
    proposal = await store.proposalByToken(token);
    if (!proposal) return notFound();
    render();
  } catch (err) {
    console.error(err);
    notFound();
  }
})();
