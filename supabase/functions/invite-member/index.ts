// POST { engagement_id, email, full_name?, organization?, role_label?, can_message?, can_files?, expires_at? }
// The client (for their own engagement) or Michael adds an outside adviser to the team.
//   - New people get a Supabase invitation email (magic link) to set up access.
//   - People who already have a portal account get a short note from us instead.
//   - When a client adds someone, Michael is emailed so he can review or remove them.
// Members see only the team space; the database rules (20261104000000_team_access.sql) enforce that.
import { json, preflight } from "../_shared/http.ts";
import { admin, getCaller } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "michael@sypher.solutions";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_ACTIVE = 25;
const clip = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in first" }, 401);

  const body = await req.json().catch(() => ({}));
  const engagementId = typeof body.engagement_id === "string" ? body.engagement_id : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!engagementId || !EMAIL_RE.test(email)) return json({ error: "Please enter a valid email address." }, 400);

  const { data: eng } = await admin.from("engagements").select("id, title, status, client_id, profiles!inner(email, full_name, company)").eq("id", engagementId).single();
  if (!eng) return json({ error: "Engagement not found" }, 404);
  const isOwner = eng.client_id === caller.id;
  if (!isOwner && caller.role !== "admin") return json({ error: "Only the client or Michael can add people to this engagement." }, 403);
  if (eng.status !== "active") return json({ error: "This engagement isn't active, so people can't be added." }, 400);

  const client = eng.profiles as unknown as { email: string; full_name: string | null; company: string | null };
  if (email === client.email.toLowerCase() || email === ADMIN_EMAIL.toLowerCase()) {
    return json({ error: "That person already has full access to this engagement." }, 400);
  }

  let expiresAt: string | null = null;
  if (body.expires_at) {
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return json({ error: "The access end date must be in the future." }, 400);
    expiresAt = d.toISOString();
  }

  const { count } = await admin.from("engagement_members").select("id", { count: "exact", head: true }).eq("engagement_id", engagementId).eq("status", "active");
  if ((count ?? 0) >= MAX_ACTIVE) return json({ error: `An engagement can have up to ${MAX_ACTIVE} people on its team.` }, 400);

  const fullName = clip(body.full_name, 120);
  const organization = clip(body.organization, 160);
  const roleLabel = clip(body.role_label, 60);

  // Find or create the person's portal account.
  let userId: string | null = null;
  let isNew = false;
  const { data: existing } = await admin.from("profiles").select("id, role").eq("email", email).maybeSingle();
  if (existing) {
    if (existing.role === "admin") return json({ error: "That person already has full access to this engagement." }, 400);
    userId = existing.id;
  } else {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, company: organization },
      redirectTo: `${SITE_URL}/portal/dashboard.html`,
    });
    if (error || !data.user) return json({ error: "Could not send the invitation. Please try again." }, 500);
    userId = data.user.id;
    isNew = true;
  }

  const { data: member, error } = await admin.from("engagement_members").upsert({
    engagement_id: engagementId, user_id: userId, email, full_name: fullName, organization, role_label: roleLabel,
    can_message: body.can_message !== false, can_files: body.can_files !== false,
    expires_at: expiresAt, status: "active", invited_by: caller.id,
  }, { onConflict: "engagement_id,user_id" }).select("id").single();
  if (error || !member) return json({ error: "Could not add them to the team." }, 500);

  const inviter = isOwner ? (client.full_name || client.email) : "Michael Furth";
  const company = client.company ? ` at ${escapeHtml(client.company)}` : "";
  const until = expiresAt ? new Date(expiresAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "the end of the engagement";

  if (!isNew) {
    const hello = fullName ? `Dear ${escapeHtml(fullName.split(" ")[0])},` : "Hello,";
    await sendEmail(email, `${inviter} added you to ${eng.title}`,
      layout("You've been added to an engagement", `<p>${hello}</p><p>${escapeHtml(inviter)}${company} has added you to <em>${escapeHtml(eng.title)}</em>, an engagement with Sypher Solutions. You can share files, message the team and see tasks assigned to you. Access runs until ${escapeHtml(until)}.</p>`,
        { label: "Open the portal", url: `${SITE_URL}/portal/` }));
  }
  if (isOwner) {
    const who = [fullName || email, roleLabel, organization].filter(Boolean).join(", ");
    await sendEmail(ADMIN_EMAIL, `${client.full_name || client.email} added ${fullName || email} to ${eng.title}`,
      layout("Someone joined a client team", `<p><strong>${escapeHtml(who)}</strong> (${escapeHtml(email)}) now has team access to <em>${escapeHtml(eng.title)}</em> until ${escapeHtml(until)}.</p><p>They can see the team thread, team files and their own tasks, and nothing else. You can change or remove their access from the engagement page.</p>`,
        { label: "Review the team", url: `${SITE_URL}/portal/admin.html#engagement=${eng.id}` }));
  }

  return json({ member_id: member.id, invited: isNew });
});
