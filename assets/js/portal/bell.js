// The bell in the portal header: unread alerts, a drawer to read them, live as they arrive.
// Notifications are written by the database (one per person per event, only for things that
// person may see); this module reads the signed-in person's own and marks them read.
import { store } from "./store.js";
import { esc, relTime, toast } from "./ui.js";

const ICONS = {
  message: "✉", document: "◆", file: "◇", request: "✓", request_file: "◇", request_submitted: "✓", request_accepted: "✓",
  request_changes: "↺", questionnaire: "?", decision: "§", milestone: "◎", pricing: "$",
};

/**
 * Mount the bell. open(n) is called when a notification is chosen (after it's marked read).
 * titleOf(engagementId) labels alerts when someone has more than one engagement.
 * Returns { list, unread(engagementId?, link?), markRead(filter), refresh(), destroy() }.
 */
export async function mountBell({ me, open, titleOf = () => "", onChange = () => {} }) {
  const nav = document.querySelector(".p-header__nav");
  if (!nav) return null;
  let list = [];
  let liveOn = false, pollTimer = null, unsubscribe = null;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "p-bell";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span class="p-bell__count" hidden></span>`;
  nav.insertBefore(btn, nav.querySelector(".p-user") || nav.firstChild);

  const drawer = document.createElement("aside");
  drawer.className = "p-drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "Alerts");
  drawer.hidden = true;
  document.body.appendChild(drawer);

  const unreadList = (eng, link) => list.filter((n) => !n.read_at && (!eng || n.engagement_id === eng) && (!link || n.link === link));

  function paintCount() {
    const n = unreadList().length;
    const c = btn.querySelector(".p-bell__count");
    c.hidden = !n;
    c.textContent = n > 99 ? "99+" : String(n);
    btn.setAttribute("aria-label", n ? `Alerts, ${n} unread` : "Alerts");
    btn.classList.toggle("has-unread", !!n);
  }

  function item(n) {
    const eng = titleOf(n.engagement_id);
    return `<li><button type="button" class="p-alert${n.read_at ? "" : " is-unread"}" data-n="${esc(n.id)}">
      <span class="p-alert__icon p-alert__icon--${esc(n.kind.split("_")[0])}" aria-hidden="true">${ICONS[n.kind] || "•"}</span>
      <span class="p-alert__text"><span class="p-alert__title">${esc(n.title)}</span>${n.body ? `<span class="p-alert__body">${esc(n.body)}</span>` : ""}
        <span class="p-alert__meta">${esc(relTime(n.created_at))}${eng ? ` · ${esc(eng)}` : ""}</span></span></button></li>`;
  }

  function paintDrawer() {
    const fresh = list.filter((n) => !n.read_at);
    const older = list.filter((n) => n.read_at).slice(0, 30);
    drawer.innerHTML = `<div class="p-drawer__head"><h2>Alerts</h2>
        <div class="btn-row">${fresh.length ? `<button type="button" class="p-linkbtn" data-read-all>Mark all read</button>` : ""}<button type="button" class="p-drawer__close" data-close aria-label="Close alerts">×</button></div></div>
      <div class="p-drawer__body">
        ${fresh.length ? `<h3 class="p-drawer__sub">New</h3><ul class="p-alerts">${fresh.map(item).join("")}</ul>` : `<p class="p-drawer__empty">You’re all caught up.</p>`}
        ${older.length ? `<h3 class="p-drawer__sub">Earlier</h3><ul class="p-alerts">${older.map(item).join("")}</ul>` : ""}
        <p class="p-drawer__live">${liveOn ? "New alerts appear here as they happen." : "Checking for new alerts every minute."}</p>
      </div>`;
  }

  function openDrawer() {
    paintDrawer();
    drawer.hidden = false;
    requestAnimationFrame(() => drawer.classList.add("is-open"));
    btn.setAttribute("aria-expanded", "true");
    drawer.querySelector(".p-alert, [data-close]")?.focus();
  }
  function closeDrawer() {
    drawer.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
    setTimeout(() => { drawer.hidden = true; }, 200);
  }

  async function markRead(ids) {
    const now = new Date().toISOString();
    const targets = list.filter((n) => !n.read_at && (!ids || ids.includes(n.id)));
    if (!targets.length) return;
    targets.forEach((n) => { n.read_at = now; });
    paintCount(); onChange();
    try { await store.markNotificationsRead(ids); } catch (err) { console.warn(err); }
  }

  btn.addEventListener("click", () => (drawer.hidden ? openDrawer() : closeDrawer()));
  drawer.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.hasAttribute("data-close")) return closeDrawer();
    if (t.hasAttribute("data-read-all")) { await markRead(null); paintDrawer(); return; }
    const n = list.find((x) => x.id === t.dataset.n);
    if (!n) return;
    closeDrawer();
    await markRead([n.id]);
    open(n);
  });
  const onKey = (e) => { if (e.key === "Escape" && !drawer.hidden) { closeDrawer(); btn.focus(); } };
  const onDoc = (e) => { if (!drawer.hidden && !drawer.contains(e.target) && !btn.contains(e.target)) closeDrawer(); };
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onDoc);

  async function refresh() {
    try { list = await store.notifications(80); } catch (err) { console.warn(err); return; }
    paintCount();
    if (!drawer.hidden) paintDrawer();
    onChange();
  }

  await refresh();
  store.subscribe("alerts", [{ table: "notifications", filter: `user_id=eq.${me}` }], ({ eventType, new: row }) => {
    if (eventType !== "INSERT" || !row?.id || list.some((n) => n.id === row.id)) return;
    list.unshift(row);
    paintCount();
    if (!drawer.hidden) paintDrawer();
    btn.classList.remove("is-ring"); void btn.offsetWidth; btn.classList.add("is-ring");
    if (document.visibilityState === "visible" && drawer.hidden) toast(row.title);
    onChange(row);
  }, (status) => {
    liveOn = status === "SUBSCRIBED";
    clearInterval(pollTimer);
    if (!liveOn) pollTimer = setInterval(refresh, 60000);
  }).then((u) => { unsubscribe = u; }).catch(() => { pollTimer = setInterval(refresh, 60000); });

  return {
    get list() { return list; },
    unread: (eng, link) => unreadList(eng, link),
    markRead,
    /** Mark read everything for an engagement that opens at this link (e.g. when that tab is viewed). */
    markSeen(eng, links) {
      const ids = list.filter((n) => !n.read_at && n.engagement_id === eng && links.includes(n.link)).map((n) => n.id);
      if (ids.length) markRead(ids);
    },
    refresh,
    destroy() { unsubscribe?.(); clearInterval(pollTimer); btn.remove(); drawer.remove(); document.removeEventListener("keydown", onKey); document.removeEventListener("click", onDoc); },
  };
}
