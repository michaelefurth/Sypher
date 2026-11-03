// Two clients: one acting as the caller (so their identity is verified by
// Supabase Auth) and one with the service role for trusted server-side work.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = Deno.env.get("SUPABASE_URL")!;

export const admin: SupabaseClient = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface Caller {
  id: string;
  email: string;
  role: "admin" | "client";
}

/** The assurance level in a session token ("aal1" email link, "aal2" verified authenticator code). */
function assuranceLevel(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.aal === "string" ? payload.aal : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the signed-in user from the request's Authorization header.
 * Admin requests need a two-step session (aal2), matching public.is_admin() in the database.
 * The token is verified by Supabase Auth (getUser) before its claims are read.
 */
export async function getCaller(req: Request): Promise<Caller | null> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: profile } = await admin.from("profiles").select("role, email").eq("id", data.user.id).single();
  if (!profile) return null;
  if (profile.role === "admin" && assuranceLevel(token) !== "aal2") return null;
  return { id: data.user.id, email: profile.email, role: profile.role };
}

export async function logActivity(engagementId: string | null, actor: string | null, kind: string, detail: Record<string, unknown>) {
  await admin.from("activity").insert({ engagement_id: engagementId, actor, kind, detail });
}
