// POST { email, full_name?, company?, engagement_title, engagement_summary? }   (admin only)
// Invites a client by email (magic-link sign-up) and opens their first engagement.
import { json, preflight } from "../_shared/http.ts";
import { admin, getCaller, logActivity } from "../_shared/supabase.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const caller = await getCaller(req);
  if (!caller || caller.role !== "admin") return json({ error: "Admin only" }, 403);

  const { email, full_name, company, engagement_title, engagement_summary } = await req.json().catch(() => ({}));
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || typeof engagement_title !== "string" || !engagement_title.trim()) {
    return json({ error: "A valid email and engagement title are required" }, 400);
  }

  // Reuse the profile if this client already has an account.
  let clientId: string | null = null;
  const { data: existing } = await admin.from("profiles").select("id").eq("email", email.toLowerCase()).maybeSingle();
  if (existing) {
    clientId = existing.id;
  } else {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email.toLowerCase(), {
      data: { full_name: full_name ?? null, company: company ?? null },
      redirectTo: `${SITE_URL}/portal/dashboard.html`,
    });
    if (error || !data.user) return json({ error: error?.message ?? "Invite failed" }, 400);
    clientId = data.user.id;
    // The auth trigger creates the profile; make sure name/company are set.
    await admin.from("profiles").upsert({ id: clientId, email: email.toLowerCase(), full_name: full_name ?? null, company: company ?? null });
  }

  const { data: engagement, error: engError } = await admin
    .from("engagements")
    .insert({ client_id: clientId, title: engagement_title.trim(), summary: engagement_summary ?? null })
    .select("id")
    .single();
  if (engError || !engagement) return json({ error: "Could not create the engagement" }, 500);

  await logActivity(engagement.id, caller.id, "client_invited", { email });
  return json({ client_id: clientId, engagement_id: engagement.id, invited: !existing });
});
