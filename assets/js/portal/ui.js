// Shared UI helpers for the Client Portal. Every value that came from a user
// or the database goes through esc() before it touches innerHTML.
import { store, isDemo } from "./store.js";
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

const ICON = `<img class="wordmark__icon" src="../assets/img/sypher-mark-sm.webp" alt="" width="34" height="44">`;

export function renderChrome(session, { active = "", admin = false } = {}) {
  const header = document.getElementById("p-header");
  if (header) {
    const name = session?.profile?.full_name || session?.user?.email || "";
    const nav = admin
      ? `<a href="admin.html" ${active === "admin" ? 'aria-current="page"' : ""}>Admin</a>`
      : `<a href="dashboard.html" ${active === "dashboard" ? 'aria-current="page"' : ""}>Overview</a>`;
    header.innerHTML = `<div class="container p-header__inner">
      <div class="p-header__brand">
        <a class="wordmark wordmark--light" href="../index.html">${ICON}<span class="wordmark__text"><span class="wordmark__name">SYPHER</span> <span class="wordmark__sub">Solutions</span></span></a>
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
  if (isDemo && !document.querySelector(".demo-banner")) {
    const bar = document.createElement("div");
    bar.className = "demo-banner";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Demo mode");
    bar.innerHTML = `<strong>Demo mode</strong>Fictional sample data, saved only in this browser. <button type="button">Reset demo</button>`;
    bar.querySelector("button").addEventListener("click", async () => { await store.resetDemo(); location.reload(); });
    header?.after(bar);
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
  return session;
}

export function statusPill(status) {
  const map = {
    open: ["In progress", "pill--teal"], reopened: ["Reopened", "pill--teal"],
    submitted: ["Submitted", "pill--gold"], complete: ["Complete", "pill--navy"],
    drafting: ["Drafting", "pill--gold"], awaiting_review: ["Awaiting review", "pill--gold"],
    published: ["Published", "pill--navy"], dismissed: ["Dismissed", ""], failed: ["Failed", "pill--red"],
    active: ["Active", "pill--teal"], archived: ["Archived", ""],
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
