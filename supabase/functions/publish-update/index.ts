// POST { engagement_id, title, body, draft_id? }   (admin only)
// Publishes an approved update to the client's portal and emails them.
import { json, preflight } from "../_shared/http.ts";
import { admin, getCaller, logActivity } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const caller = await getCaller(req);
  if (!caller || caller.role !== "admin") return json({ error: "Admin only" }, 403);

  const { engagement_id, title, body, draft_id } = await req.json().catch(() => ({}));
  if (typeof engagement_id !== "string" || typeof title !== "string" || typeof body !== "string" || !title.trim() || !body.trim()) {
    return json({ error: "engagement_id, title and body are required" }, 400);
  }

  const { data: engagement } = await admin
    .from("engagements")
    .select("id, title, profiles!inner(email, full_name)")
    .eq("id", engagement_id)
    .single();
  if (!engagement) return json({ error: "Engagement not found" }, 404);

  const { data: publication, error } = await admin
    .from("publications")
    .insert({ engagement_id, title: title.trim(), body: body.trim(), draft_id: draft_id ?? null })
    .select("id, published_at")
    .single();
  if (error || !publication) return json({ error: "Could not publish" }, 500);

  if (draft_id) {
    await admin.from("report_drafts").update({ status: "published", reviewed_at: new Date().toISOString() }).eq("id", draft_id);
  }
  await logActivity(engagement_id, caller.id, "update_published", { publication_id: publication.id, title });

  const client = engagement.profiles as unknown as { email: string; full_name: string | null };
  const greeting = client.full_name ? `Dear ${escapeHtml(client.full_name.split(" ")[0])},` : "Hello,";
  await sendEmail(client.email, `An update from Sypher Solutions: ${title}`,
    layout(title, `<p>${greeting}</p><p>Michael has published a new update to your engagement, <em>${escapeHtml(engagement.title)}</em>. You can read it in your client portal.</p>`,
      { label: "Open your portal", url: `${SITE_URL}/portal/` }));

  return json({ publication_id: publication.id, published_at: publication.published_at });
});
