// Sign-in by one-time email link, for invited addresses only.
import { store } from "./store.js";
import { $ } from "./ui.js";

const go = (session) => location.replace(session.profile.role === "admin" ? "admin.html" : "dashboard.html");

(async () => {
  try {
    const session = await store.session();
    if (session) return go(session);
  } catch (err) { console.error(err); }

  const form = $("#login-form");
  const sent = $("#login-sent");
  const codeForm = $("#code-form");
  const codeError = $("#code-error");
  let sentTo = "";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!form.checkValidity() || !email) { form.reportValidity(); return; }
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
    // The email also carries a code, for when a mail scanner has already used the link.
    sentTo = email;
    codeForm.hidden = false;
    codeError.hidden = true;
  });

  codeForm.code.addEventListener("input", () => {
    codeForm.code.value = codeForm.code.value.replace(/\D/g, "").slice(0, 6);
  });

  codeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = codeForm.code.value.trim();
    if (!/^\d{6}$/.test(code)) {
      codeError.hidden = false;
      codeError.textContent = "Enter the 6 digits from the email.";
      return;
    }
    const button = codeForm.querySelector("button");
    button.disabled = true;
    codeError.hidden = true;
    try {
      await store.verifyEmailCode(sentTo, code);
      const session = await store.session();
      if (session) return go(session);
      throw new Error("No session after verifying the code");
    } catch (err) {
      codeError.hidden = false;
      codeError.textContent = "That code didn't work. Codes work once and expire after an hour; ask for a new email above.";
      console.warn(err.message);
    } finally {
      button.disabled = false;
    }
  });
})();
