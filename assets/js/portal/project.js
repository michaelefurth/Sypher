// The project model, full width, for Michael: edit cost lines and assumptions, assign who
// confirms what, ask them, save versions. (The client and advisers with access use the
// Project tab in their room.)  project.html?m=<model id>
import { store } from "./store.js";
import { ADMIN_CONTACT } from "./config.js";
import { esc, renderChrome, requireSession, toast } from "./ui.js";
import { mountModel } from "./model.js";
import { mountBell } from "./bell.js";

const main = document.getElementById("main");

(async () => {
  const session = await requireSession({ admin: true });
  if (!session) return;
  renderChrome(session, { active: "admin", admin: true });
  const id = new URLSearchParams(location.search).get("m");
  try {
    if (!id) throw new Error("No model was given.");
    const model = await store.pmModel(id);
    const [eng, roster, sheets] = await Promise.all([store.engagement(model.engagement_id), store.roster(model.engagement_id).catch(() => null), store.sovSheets(model.engagement_id).catch(() => [])]);
    const members = roster?.members || [];
    const nameOf = (uid) => {
      if (!uid) return ADMIN_CONTACT.name;
      if (uid === session.user.id) return ADMIN_CONTACT.name;
      if (uid === eng.client_id) return eng.client?.full_name || eng.client?.email || "Client";
      const m = members.find((x) => x.user_id === uid);
      return m ? [m.name, m.role_label].filter(Boolean).join(", ") : "Former team member";
    };
    const people = [{ id: eng.client_id, name: `${eng.client?.full_name || "Client"} (client)` },
      ...members.filter((m) => m.status === "active" && m.can_model).map((m) => ({ id: m.user_id, name: [m.name, m.role_label].filter(Boolean).join(", ") }))];
    const noAccess = members.filter((m) => m.status === "active" && !m.can_model && !sheets.some((x) => x.contractor_id === m.user_id));
    main.innerHTML = `<div class="p-shell p-shell--wide sov-page">
      <p class="sov-page__back"><a class="p-linkbtn" href="admin.html#engagement=${esc(eng.id)}">← ${esc(eng.title)}</a></p>
      <details class="room-add sov-settings"><summary class="p-linkbtn">Model settings</summary>
        <form class="p-form p-form--2" id="model-settings">
          <div class="p-field p-span"><label for="ms-title">Title</label><input class="p-input" id="ms-title" name="title" required value="${esc(model.title)}"></div>
          <div class="p-field"><label for="ms-sheet">Hard costs from</label><select class="p-select" id="ms-sheet" name="sheet"><option value="">No pricing sheet</option>${sheets.map((x) => `<option value="${esc(x.id)}"${x.id === model.sov_sheet_id ? " selected" : ""}>${esc(x.title)}</option>`).join("")}</select></div>
          <div class="p-field"><label for="ms-sf">Building area (SF)</label><input class="p-input" id="ms-sf" name="sf" inputmode="decimal" value="${esc(model.building_sf ?? "")}"></div>
          <div class="p-span"><button class="btn btn--navy btn--sm" type="submit">Save settings</button>
            <span class="p-muted">${noAccess.length ? `To have ${esc(noAccess.map((m) => m.name).join(", "))} confirm figures, give them model access on the engagement page first.` : "People with model access appear in “who confirms”."}</span></div>
        </form></details>
      <div id="pm-root"><div class="p-loading">Loading the model…</div></div>
    </div>`;
    document.title = `${model.title} | Project model`;
    const mount = () => mountModel(document.getElementById("pm-root"), { modelId: id, role: "admin", me: session.user.id, nameOf, people, pricingHref: model.sov_sheet_id ? `pricing.html?s=${model.sov_sheet_id}` : "#" });
    let view = await mount();
    document.getElementById("model-settings").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      try {
        await store.pmUpdateModel(id, { title: f.title.value.trim(), sov_sheet_id: f.sheet.value || null, building_sf: Number(f.sf.value.replace(/[,\s]/g, "")) || null, updated_at: new Date().toISOString() });
        toast("Saved.");
        view.destroy();
        view = await mount();
      } catch (err) { toast(err.message, true); }
    });
    mountBell({ me: session.user.id, open: (n) => { location.href = `admin.html#engagement=${n.engagement_id}`; } }).catch(() => {});
  } catch (err) {
    main.innerHTML = `<div class="p-shell"><p class="p-empty">${esc(err.message)}</p><p><a class="p-linkbtn" href="admin.html#clients">Back to clients</a></p></div>`;
  }
})();
