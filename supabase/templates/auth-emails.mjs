// Supabase sign-in emails for the Sypher client portal, in the brand shell.
//
// Deployed by .github/workflows/deploy-supabase.yml, which sends these to Supabase's Management
// API (PATCH /v1/projects/{ref}/config/auth). Only the email subjects, bodies and the link
// lifetime are sent; no other auth setting is touched.
//
//   node supabase/templates/auth-emails.mjs payload        JSON for the API
//   node supabase/templates/auth-emails.mjs preview <dir>  HTML previews with sample values
//
// {{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }} and the rest are Supabase template tags
// (Go templates), filled in by Supabase when it sends each email.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emailShell, button, codeBlock, fallbackLink } from "../functions/_shared/brand-email.js";

/** How long sign-in links and codes last, in seconds. The emails promise "one hour". */
export const LINK_LIFETIME_SECONDS = 3600;

const LINK = "{{ .ConfirmationURL }}";
const PORTAL = "https://sypher.solutions/portal/";

export const templates = {
  magic_link: {
    subject: "Your sign-in link for the Sypher client portal",
    html: emailShell({
      preheader: "Sign in to your client portal. The link and code work once, for one hour.",
      heading: "Sign in to your client portal",
      body: `<p style="margin:0">Use the button below to sign in as <strong style="color:#0B2D3B">{{ .Email }}</strong>.</p>
${button("Sign in", LINK)}
${codeBlock("Or enter this code on the sign-in page:", "{{ .Token }}")}
${fallbackLink(LINK)}`,
      note: "The link and the code each work once and expire after one hour. If you didn't ask to sign in, you can ignore this email: nobody can get in without it.",
    }),
  },

  invite: {
    subject: "Your Sypher Solutions client portal is ready",
    html: emailShell({
      preheader: "Michael Furth has set up a private workspace for your engagement.",
      heading: "Your client portal is ready",
      body: `<p style="margin:0 0 14px">{{ if .Data.full_name }}Hello {{ .Data.full_name }},{{ else }}Hello,{{ end }}</p>
<p style="margin:0 0 14px">I've set up a private, secure workspace for our work together. Your plan and milestones, the documents we share, the questions I need answered and a direct line to me are all in one place.</p>
<p style="margin:0">There's no password to remember: each time you sign in, the portal emails you a one-time link.</p>
${button("Open your portal", LINK)}
${fallbackLink(LINK)}`,
      note: `This invitation link works once. If it has expired, go to <a href="${PORTAL}" style="color:#1E7F7A">sypher.solutions/portal</a> and enter this email address for a new one.`,
      signoff: true,
    }),
  },

  confirmation: {
    subject: "Confirm your email for the Sypher client portal",
    html: emailShell({
      preheader: "One step to finish setting up your client portal account.",
      heading: "Confirm your email address",
      body: `<p style="margin:0">Confirm <strong style="color:#0B2D3B">{{ .Email }}</strong> to finish setting up your client portal account.</p>
${button("Confirm email", LINK)}
${fallbackLink(LINK)}`,
      note: "If you didn't request this, you can ignore this email.",
    }),
  },

  recovery: {
    subject: "Reset your Sypher client portal password",
    html: emailShell({
      preheader: "A link to choose a new password for your client portal.",
      heading: "Choose a new password",
      body: `<p style="margin:0">Someone asked to reset the password for <strong style="color:#0B2D3B">{{ .Email }}</strong>. If it was you, choose a new one below.</p>
${button("Choose a new password", LINK)}
${fallbackLink(LINK)}`,
      note: "This link works once and expires after one hour. If you didn't ask for it, ignore this email and your password stays as it is.",
    }),
  },

  email_change: {
    subject: "Confirm your new email address",
    html: emailShell({
      preheader: "Confirm the new address for your Sypher client portal.",
      heading: "Confirm your new email address",
      body: `<p style="margin:0">Confirm that <strong style="color:#0B2D3B">{{ .NewEmail }}</strong> should replace {{ .Email }} as the address for your client portal.</p>
${button("Confirm new address", LINK)}
${fallbackLink(LINK)}`,
      note: `If you didn't ask for this change, write to <a href="mailto:michael@sypher.solutions" style="color:#1E7F7A">michael@sypher.solutions</a> straight away.`,
    }),
  },

  reauthentication: {
    subject: "{{ .Token }} is your Sypher verification code",
    html: emailShell({
      preheader: "Your one-time verification code for the client portal.",
      heading: "Your verification code",
      body: `<p style="margin:0">Enter this code where the portal asked for it.</p>
${codeBlock("Your code:", "{{ .Token }}")}`,
      note: "The code works once and expires after one hour. If you didn't ask for it, you can ignore this email.",
    }),
  },
};

/** The Management API body: subjects, contents and the link lifetime, nothing else. */
export function payload() {
  const body = { mailer_otp_exp: LINK_LIFETIME_SECONDS };
  for (const [name, t] of Object.entries(templates)) {
    body[`mailer_subjects_${name}`] = t.subject;
    body[`mailer_templates_${name}_content`] = t.html;
  }
  return body;
}

const SAMPLE = {
  ".ConfirmationURL": "https://pswzqwmluigojvizvfdc.supabase.co/auth/v1/verify?token=0a1b2c3d4e5f&type=magiclink&redirect_to=https://sypher.solutions/portal/dashboard.html",
  ".Token": "482913",
  ".Email": "client@example.com",
  ".NewEmail": "new-address@example.com",
};

/** Fill the template tags with sample values, the way Supabase would. */
export function sample(html) {
  return html
    .replace(/\{\{ if \.Data\.full_name \}\}Hello \{\{ \.Data\.full_name \}\},\{\{ else \}\}Hello,\{\{ end \}\}/g, "Hello Alejandra Islas,")
    .replace(/\{\{ (\.[A-Za-z]+) \}\}/g, (m, key) => SAMPLE[key] ?? m);
}

const [cmd, dir] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "payload") {
    process.stdout.write(JSON.stringify(payload()));
  } else if (cmd === "preview" && dir) {
    mkdirSync(dir, { recursive: true });
    for (const [name, t] of Object.entries(templates)) writeFileSync(join(dir, `${name}.html`), sample(t.html));
    console.log(`Wrote ${Object.keys(templates).length} previews to ${dir}`);
  } else {
    console.error("usage: node supabase/templates/auth-emails.mjs payload | preview <dir>");
    process.exit(2);
  }
}
