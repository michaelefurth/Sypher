// Sign-in: magic link (live) or role picker (demo).
import { store, isDemo } from "./store.js";
import { $, $$, toast } from "./ui.js";

const go = (session) => location.replace(session.profile.role === "admin" ? "admin.html" : "dashboard.html");

(async () => {
  try {
    const session = await store.session();
    if (session) return go(session);
  } catch (err) { console.error(err); }

  const form = $("#login-form");
  const sent = $("#login-sent");

  if (isDemo) {
    $("#login-demo").hidden = false;
    $$("[data-demo]").forEach((btn) => btn.addEventListener("click", async () => {
      const session = await store.signIn(btn.dataset.demo);
      go(session);
    }));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!form.checkValidity() || !email) { form.reportValidity(); return; }
    if (isDemo) { toast("Demo mode: use the buttons below to explore."); return; }
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await store.sendMagicLink(email, "dashboard.html");
      sent.hidden = false;
      sent.textContent = `Check your inbox. A secure sign-in link is on its way to ${email}.`;
    } catch (err) {
      // Same message whether or not the address exists, so accounts can't be probed.
      sent.hidden = false;
      sent.textContent = "If that address has a portal invitation, a sign-in link is on its way.";
      console.warn(err.message);
    } finally {
      button.disabled = false;
    }
  });
})();
