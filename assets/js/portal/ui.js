// Shared UI helpers for the Client Portal. Every value that came from a user
// or the database goes through esc() before it touches innerHTML.
import { store } from "./store.js";
import { ADMIN_CONTACT } from "./config.js";

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escape, then turn blank lines into paragraphs and single newlines into <br>. */
export function paragraphs(text) {
  return String(text ?? "").trim().split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function fmtDate(value, opts = { month: "long", day: "numeric", year: "numeric" }) {
  if (!value) return "";
  const d = typeof value === "string" && value.length === 10 ? new Date(value + "T12:00:00") : new Date(value);
  return d.toLocaleDateString(undefined, opts);
}

export function relTime(value) {
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} d ago`;
  return fmtDate(value, { month: "short", day: "numeric" });
}

export function initials(name, email) {
  const src = (name || email || "?").trim();
  const parts = src.split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

let toastTimer;
export function toast(message, isError = false) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = message;
  el.classList.toggle("is-error", isError);
  requestAnimationFrame(() => el.classList.add("is-on"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-on"), 3600);
}

/** Promise-based confirm built on <dialog>. Resolves true when confirmed. */
export function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "p-dialog";
    dlg.innerHTML = `<form method="dialog" class="p-dialog__box">
      <h2>${esc(title)}</h2><div>${body}</div>
      <div class="p-dialog__actions">
        <button class="btn btn--ghost btn--sm" value="cancel">${esc(cancelLabel)}</button>
        <button class="btn btn--navy btn--sm" value="ok">${esc(confirmLabel)}</button>
      </div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => { resolve(dlg.returnValue === "ok"); dlg.remove(); });
    dlg.showModal();
  });
}

const ICON = `<img class="wordmark__icon" src="../assets/img/sypher-mark-sm.webp" alt="" width="46" height="48">`;

export function renderChrome(session, { active = "", admin = false } = {}) {
  const header = document.getElementById("p-header");
  if (header) {
    const name = session?.profile?.full_name || session?.user?.email || "";
    const nav = admin
      ? `<a href="admin.html" ${active === "admin" ? 'aria-current="page"' : ""}>Admin</a>`
      : `<a href="dashboard.html" ${active === "dashboard" ? 'aria-current="page"' : ""}>Overview</a>`;
    header.innerHTML = `<div class="container p-header__inner">
      <div class="p-header__brand">
        <a class="wordmark wordmark--light" href="../index.html" aria-label="Sypher Solutions home">${ICON}<span class="wordmark__text"><span class="wordmark__name">SYPHER</span> <span class="wordmark__sub">Solutions</span></span></a>
        <span class="p-header__label">Client Portal</span>
      </div>
      <nav class="p-header__nav" aria-label="Portal">
        ${session ? nav : ""}
        ${session ? `<span class="p-user"><span class="p-avatar" aria-hidden="true">${esc(initials(session.profile?.full_name, session.user.email))}</span><span class="p-user__name">${esc(name)}</span></span><button type="button" data-signout>Sign out</button>` : `<a href="../index.html">Back to site</a>`}
      </nav></div>`;
    header.querySelector("[data-signout]")?.addEventListener("click", async () => {
      await store.signOut();
      location.href = "index.html";
    });
  }
  const footer = document.getElementById("p-footer");
  if (footer) {
    footer.innerHTML = `<span>&copy; ${new Date().getFullYear()} Sypher Solutions · Confidential client workspace</span>
      <span>Questions? <a href="mailto:${esc(ADMIN_CONTACT.email)}">${esc(ADMIN_CONTACT.email)}</a></span>`;
  }
}

/** Ensure a signed-in user (optionally an admin); otherwise redirect to sign-in. */
export async function requireSession({ admin = false } = {}) {
  let session = null;
  try { session = await store.session(); } catch (err) { console.error(err); }
  if (!session) { location.replace("index.html"); return null; }
  if (admin && session.profile.role !== "admin") { location.replace("dashboard.html"); return null; }
  if (admin && !(await twoStepGate(session))) return null;
  return session;
}

/**
 * Admin access needs a two-step session (the database and the server functions enforce
 * it too). Shows setup the first time, then asks for the 6-digit code once per session.
 * Resolves true when the session is already verified.
 */
async function twoStepGate(session) {
  const state = await store.mfaState();
  if (state.level === "aal2") return true;
  renderChrome(session, { active: "admin", admin: true });
  const main = document.getElementById("main");
  const shell = (inner) => `<div class="p-shell"><section class="p-card p-card--accent mfa">${inner}</section></div>`;
  const codeField = `<div class="p-field"><label for="mfa-code">6-digit code</label>
    <input class="p-input mfa__code" id="mfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required></div>`;
  let factorId = state.verified[0]?.id;

  if (factorId) {
    main.innerHTML = shell(`<p class="p-kicker">Two-step sign-in</p><h1 class="mfa__title">Enter your code</h1>
      <p>Open your authenticator app and enter the current code for Sypher Solutions.</p>
      <form class="p-form" id="mfa-form">${codeField}<button class="btn btn--navy" type="submit">Verify</button><p class="mfa__error" role="alert"></p></form>
      <p class="p-muted mfa__help">Lost your phone? In the Supabase dashboard, open Authentication → Users → your account and remove the authenticator, then sign in again to set up a new one.</p>`);
  } else {
    const setup = await store.mfaEnroll();
    factorId = setup.factorId;
    main.innerHTML = shell(`<p class="p-kicker">Two-step sign-in</p><h1 class="mfa__title">Protect the admin account</h1>
      <p>Your admin view shows every client's records, so it needs a code from an authenticator app as well as the email link. Use any authenticator app: Google Authenticator, Microsoft Authenticator, 1Password or similar.</p>
      <ol class="mfa__steps">
        <li><p><strong>Scan this code</strong> with the app.</p><img class="mfa__qr" src="${esc(setup.qr)}" alt="QR code for your authenticator app" width="180" height="180">
          <p class="p-muted">Can't scan it? Enter this key in the app instead:</p><p class="mfa__secret"><code>${esc(setup.secret.replace(/(.{4})/g, "$1 ").trim())}</code></p></li>
        <li><p><strong>Enter the 6-digit code</strong> the app shows.</p>
          <form class="p-form" id="mfa-form">${codeField}<button class="btn btn--navy" type="submit">Turn on two-step sign-in</button><p class="mfa__error" role="alert"></p></form></li>
      </ol>`);
  }
  const form = main.querySelector("#mfa-form");
  form.querySelector("input").focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    const err = form.querySelector(".mfa__error");
    btn.disabled = true; err.textContent = "";
    try {
      await store.mfaVerify(factorId, form.code.value);
      location.reload();
    } catch (error) {
      err.textContent = error.message;
      btn.disabled = false;
      form.code.select();
    }
  });
  return false;
}

export function statusPill(status) {
  const map = {
    open: ["In progress", "pill--teal"], reopened: ["Reopened", "pill--teal"],
    submitted: ["Submitted", "pill--gold"], complete: ["Complete", "pill--navy"],
    drafting: ["Drafting", "pill--gold"], awaiting_review: ["Awaiting review", "pill--gold"],
    published: ["Published", "pill--navy"], dismissed: ["Dismissed", ""], failed: ["Failed", "pill--red"],
    active: ["Active", "pill--teal"], archived: ["Archived", ""],
    new: ["New", "pill--gold"], reviewed: ["Reviewed", ""], call_booked: ["Call booked", "pill--teal"], proposal: ["Proposal", "pill--navy"], closed: ["Closed", ""],
    draft: ["Draft", ""], sent: ["Sent", "pill--teal"], viewed: ["Viewed", "pill--gold"], accepted: ["Accepted", "pill--navy"], declined: ["Declined", "pill--red"], withdrawn: ["Withdrawn", ""],
    pending: ["Brief drafting", "pill--gold"], ready: ["Brief ready", "pill--teal"], skipped: ["No brief", ""],
  };
  const [label, cls] = map[status] || [status, ""];
  return `<span class="pill pill--dot ${cls}">${esc(label)}</span>`;
}

export function progressBar(p) {
  const pct = p.total ? Math.round(((p.answered + p.unknown) / p.total) * 100) : 0;
  return `<div class="p-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${pct}% complete"><span style="width:${pct}%"></span></div>`;
}

export function download(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
