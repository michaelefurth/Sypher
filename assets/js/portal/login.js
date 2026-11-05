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
    let showCode = true;
    sent.classList.remove("is-error");
    try {
      await store.sendMagicLink(email, "dashboard.html");
      sent.hidden = false;
      sent.textContent = `Check your inbox. A secure sign-in link is on its way to ${email}. It can take a minute; check Junk if it isn't there.`;
    } catch (err) {
      sent.hidden = false;
      console.warn(err.code || err.status, err.message);
      if (err.code === "over_email_send_rate_limit" || err.status === 429) {
        // One email per address per minute.
        sent.textContent = "A sign-in email was sent to this address moments ago. Use the newest one, or wait a minute and ask again.";
      } else if (err.code === "otp_disabled" || err.code === "user_not_found" || err.status === 422 || err.status === 400) {
        // No account for that address: the same words as success, so addresses can't be probed.
        sent.textContent = "If that address has a portal invitation, a sign-in link is on its way.";
      } else {
        // The account exists but the email could not be sent (mail service or network).
        showCode = false;
        sent.classList.add("is-error");
        sent.innerHTML = 'We couldn\u2019t send the email just now. Try again in a few minutes, or write to <a href="mailto:michael@sypher.solutions">michael@sypher.solutions</a>.';
      }
    } finally {
      button.disabled = false;
    }
    // The email also carries a code, for when a mail scanner has already used the link.
    sentTo = email;
    codeForm.hidden = !showCode;
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
