// Transactional email via Resend (https://resend.com). If RESEND_API_KEY is
// not configured the message is logged and skipped, so the portal still works.
import { button, emailShell } from "./brand-email.js";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("EMAIL_FROM") ?? "Sypher Solutions <portal@sypher.solutions>";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Brand email: the shared shell in brand-email.js, also used by the Supabase sign-in emails. */
export function layout(heading: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const preheader = escapeHtml(bodyHtml.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 140));
  const body = cta ? `${bodyHtml}${button(escapeHtml(cta.label), escapeHtml(cta.url))}` : bodyHtml;
  return emailShell({ heading: escapeHtml(heading), body, preheader });
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_API_KEY) {
    console.log(`[email skipped: RESEND_API_KEY not set] to=${to} subject=${subject}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  if (!res.ok) console.error(`Resend error ${res.status}: ${await res.text()}`);
}
