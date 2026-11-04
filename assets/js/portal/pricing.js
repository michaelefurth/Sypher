// A pricing sheet, full width, for Michael: edit lines, descriptions and the budget, key in
// prices, review, reopen. (Clients and contractors use the Pricing tab in their room.)
// pricing.html?s=<sheet id>
import { store } from "./store.js";
import { ADMIN_CONTACT } from "./config.js";
import { esc, renderChrome, requireSession, toast } from "./ui.js";
import { mountSov } from "./sov.js";
import { mountBell } from "./bell.js";

const main = document.getElementById("main");

(async () => {
  const session = await requireSession({ admin: true });
  if (!session) return;
  renderChrome(session, { active: "admin", admin: true });
  const id = new URLSearchParams(location.search).get("s");
  try {
    if (!id) throw new Error("No sheet was given.");
    const sheet = await store.sovSheet(id);
    const [eng, roster] = await Promise.all([store.engagement(sheet.engagement_id), store.roster(sheet.engagement_id).catch(() => null)]);
    const members = roster?.members || [];
    const nameOf = (uid) => {
      if (!uid) return "Someone";
      if (uid === session.user.id) return ADMIN_CONTACT.name;
      if (uid === eng.client_id) return eng.client?.full_name || eng.client?.email || "Client";
      const m = members.find((x) => x.user_id === uid);
      return m ? [m.name, m.organization].filter(Boolean).join(", ") : "Former team member";
    };
    const active = members.filter((m) => m.status === "active");
    main.innerHTML = `<div class="p-shell p-shell--wide sov-page">
      <p class="sov-page__back"><a class="p-linkbtn" href="admin.html#engagement=${esc(eng.id)}">← ${esc(eng.title)}</a></p>
      <details class="room-add sov-settings"><summary class="p-linkbtn">Sheet settings</summary>
        <form class="p-form p-form--2" id="sheet-settings">
          <div class="p-field p-span"><label for="ss-title">Title</label><input class="p-input" id="ss-title" name="title" required value="${esc(sheet.title)}"></div>
          <div class="p-field"><label for="ss-who">Contractor</label><select class="p-select" id="ss-who" name="contractor_id"><option value="">None</option>${active.map((m) => `<option value="${esc(m.user_id)}"${m.user_id === sheet.contractor_id ? " selected" : ""}>${esc(m.name)}${m.role_label ? ` (${esc(m.role_label)})` : ""}</option>`).join("")}</select></div>
          <div class="p-field p-span"><label for="ss-intro">What you need (shown at the top)</label><textarea class="p-textarea" id="ss-intro" name="intro" rows="3">${esc(sheet.intro || "")}</textarea></div>
          <div class="p-span"><button class="btn btn--navy btn--sm" type="submit">Save settings</button> <span class="p-muted">Changing the contractor doesn't move the pricing request; add a new request from the engagement page.</span></div>
        </form></details>
      <div id="sov-root"><div class="p-loading">Loading the sheet…</div></div>
    </div>`;
    document.title = `${sheet.title} | Pricing`;
    let grid = await mountSov(document.getElementById("sov-root"), { sheetId: id, role: "admin", me: session.user.id, nameOf });
    document.getElementById("sheet-settings").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await store.sovAdminUpdateSheet(id, { title: f.elements.title.value.trim(), intro: f.elements.intro.value.trim() || null, contractor_id: f.elements.contractor_id.value || null });
        toast("Saved.");
        grid.destroy();
        grid = await mountSov(document.getElementById("sov-root"), { sheetId: id, role: "admin", me: session.user.id, nameOf });
      } catch (err) { toast(err.message, true); }
    });
    mountBell({ me: session.user.id, open: (n) => { location.href = `admin.html#engagement=${n.engagement_id}`; } }).catch(() => {});
  } catch (err) {
    main.innerHTML = `<div class="p-shell"><p class="p-empty">${esc(err.message)}</p><p><a class="p-linkbtn" href="admin.html#clients">Back to clients</a></p></div>`;
  }
})();
