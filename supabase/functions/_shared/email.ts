// Transactional email via Resend (https://resend.com). If RESEND_API_KEY is
// not configured the message is logged and skipped, so the portal still works.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("EMAIL_FROM") ?? "Sypher Solutions <portal@sypher.solutions>";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Brand-styled wrapper: navy header, cream body, champagne rule. */
export function layout(heading: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:32px 0 8px"><a href="${escapeHtml(cta.url)}" style="background:#D4B483;color:#0B2D3B;text-decoration:none;padding:14px 26px;border-radius:999px;font:600 12px/1 Arial,sans-serif;letter-spacing:2px;text-transform:uppercase">${escapeHtml(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#EAE6DF">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EAE6DF;padding:32px 12px"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FDFBF7">
    <tr><td style="background:#0B2D3B;padding:28px 36px;font:500 22px Georgia,serif;letter-spacing:4px;color:#F4F1EA">SYPHER <span style="display:block;font:500 9px Arial,sans-serif;letter-spacing:6px;color:#D4B483;margin-top:6px">SOLUTIONS</span></td></tr>
    <tr><td style="padding:36px;font:16px/1.65 Georgia,serif;color:#3C4852">
      <h1 style="font:400 28px/1.2 Georgia,serif;color:#0B2D3B;margin:0 0 18px">${escapeHtml(heading)}</h1>
      <div style="width:56px;height:1px;background:#D4B483;margin:0 0 24px"></div>
      ${bodyHtml}${button}
    </td></tr>
    <tr><td style="padding:20px 36px 32px;font:12px Arial,sans-serif;color:#6B7780;border-top:1px solid #EAE6DF">Decoding complexity. Revealing solutions.</td></tr>
  </table></td></tr></table></body></html>`;
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
