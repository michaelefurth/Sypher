// POST { token }   (public; called by the proposal page right after a response)
// Tells Michael a proposal was accepted or declined, and sends the signer a
// confirmation of what they accepted. Runs once per proposal (notified_at).
// Deploy with: supabase functions deploy proposal-response --no-verify-jwt
import { json, preflight } from "../_shared/http.ts";
import { admin } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "michael@sypher.solutions";

interface Option { id: string; name?: string; fee?: string; timeline?: string }

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { token } = await req.json().catch(() => ({}));
  if (typeof token !== "string" || token.length < 20 || token.length > 80) return json({ error: "Invalid request" }, 400);

  const { data: p } = await admin.from("proposals").select("*").eq("token", token).maybeSingle();
  if (!p || !["accepted", "declined"].includes(p.status)) return json({ ok: false }, 404);
  if (p.notified_at) return json({ ok: true });

  // Claim the notification first so a double call can't send twice.
  const { data: claimed } = await admin.from("proposals").update({ notified_at: new Date().toISOString() })
    .eq("id", p.id).is("notified_at", null).select("id");
  if (!claimed?.length) return json({ ok: true });

  const who = escapeHtml(p.company || p.client_name || "A client");
  if (p.status === "accepted") {
    const option = ((p.content?.options ?? []) as Option[]).find((o) => o.id === p.accepted_option);
    const optionLine = option ? `${escapeHtml(option.name ?? "")}${option.fee ? ` · ${escapeHtml(option.fee)}` : ""}${option.timeline ? ` · ${escapeHtml(option.timeline)}` : ""}` : escapeHtml(p.accepted_option ?? "");
    await sendEmail(ADMIN_EMAIL, `Accepted: ${p.title}`,
      layout(`${who} accepted`, `<p><strong>${escapeHtml(p.title)}</strong><br>${optionLine}</p>
        <p>Signed by ${escapeHtml(p.signer_name ?? "")}${p.signer_title ? `, ${escapeHtml(p.signer_title)}` : ""} (${escapeHtml(p.signer_email ?? "")})</p>
        <p>Open the engagement from the proposal to invite them to their client room.</p>`,
        { label: "Open the proposal", url: `${SITE_URL}/portal/admin.html#proposal=${p.id}` }));
    if (p.signer_email) {
      await sendEmail(p.signer_email, `Confirmed: ${p.title}`,
        layout("Thank you. We're under way.", `<p>This confirms your acceptance of <em>${escapeHtml(p.title)}</em>:</p>
          <p><strong>${optionLine}</strong></p>
          <p>Michael will be in touch to schedule the kickoff, and you'll receive an invitation to your private client room, where the plan, milestones and every update will live.</p>
          <p>A copy of the proposal stays available at the link you used.</p>`,
          { label: "View the proposal", url: `${SITE_URL}/for/?p=${encodeURIComponent((p.slug ? p.slug + "." : "") + p.token)}` }));
    }
  } else {
    await sendEmail(ADMIN_EMAIL, `Declined: ${p.title}`,
      layout(`${who} declined`, `<p><strong>${escapeHtml(p.title)}</strong></p>${p.decline_reason ? `<p>Their note: “${escapeHtml(p.decline_reason)}”</p>` : "<p>No reason was given.</p>"}`,
        { label: "Open the proposal", url: `${SITE_URL}/portal/admin.html#proposal=${p.id}` }));
  }
  return json({ ok: true });
});
