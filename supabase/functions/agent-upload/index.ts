// POST { action, ... }   with the header  X-Agent-Key: <AGENT_UPLOAD_KEY>   (no portal sign-in)
//
// Lets an assistant (for example, Claude working in a cloud session) file documents it has
// prepared for Michael's review. It can do exactly two things:
//   context  {}  → the engagements (id, title, status, client name) with their milestones, the
//                  documents already shared and those already waiting, so it can file in the right place
//   upload   { engagement_id, title, filename, data_base64, note?, milestone_id?, suggest_team?, notify? }
//                → stores the file in the admin-only "inbox" bucket and lists it under
//                  admin → engagement → Documents → "Waiting for your review"; emails Michael
//                  unless notify is false (to send one email for a batch, pass false on all but the last)
//
// It can't read or download any document, change or delete anything, or reach a client or team
// member: nothing it files is visible to them until Michael shares it.
//
// Switched on by the AGENT_UPLOAD_KEY function secret (at least 32 random characters). Remove the
// secret to switch it off. The same key is saved for the assistant's environment, where the network
// proxy adds it to requests, so the assistant itself never sees it.
import { json } from "../_shared/http.ts";
import { admin } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";
import { fileType, fromBase64, keyMatches, MIN_KEY_LENGTH, safeName } from "../_shared/agent.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "michael@sypher.solutions";
const MAX_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const expected = Deno.env.get("AGENT_UPLOAD_KEY");
  if (!expected || expected.length < MIN_KEY_LENGTH) return json({ error: "Agent uploads are switched off" }, 503);
  if (!keyMatches(req.headers.get("X-Agent-Key"), expected)) return json({ error: "Not allowed" }, 401);
  const body = await req.json().catch(() => ({}));

  try {
    if (body.action === "context") {
      const [{ data: engs }, { data: ms }, { data: docs }, { data: waiting }] = await Promise.all([
        admin.from("engagements").select("id, title, status, client:client_id (full_name, company)").order("created_at"),
        admin.from("milestones").select("id, engagement_id, title, status, position").order("position"),
        admin.from("deliverables").select("engagement_id, title, name, milestone_id, shared_with_team, created_at").order("created_at"),
        admin.from("inbox_documents").select("engagement_id, title, name, created_at").order("created_at"),
      ]);
      return json({
        engagements: (engs ?? []).map((e) => ({
          ...e,
          milestones: (ms ?? []).filter((m) => m.engagement_id === e.id).map(({ engagement_id: _, ...m }) => m),
          shared: (docs ?? []).filter((d) => d.engagement_id === e.id).map(({ engagement_id: _, ...d }) => d),
          waiting_for_review: (waiting ?? []).filter((d) => d.engagement_id === e.id).map(({ engagement_id: _, ...d }) => d),
        })),
      });
    }

    if (body.action === "upload") {
      const engagementId = body.engagement_id, milestoneId = body.milestone_id || null;
      const title = text(body.title, 200), filename = text(body.filename, 200);
      if (typeof engagementId !== "string" || !UUID.test(engagementId)) return json({ error: "engagement_id is required" }, 400);
      if (milestoneId !== null && (typeof milestoneId !== "string" || !UUID.test(milestoneId))) return json({ error: "milestone_id must be a milestone's id" }, 400);
      if (!title || !filename) return json({ error: "title and filename are required" }, 400);
      const contentType = fileType(filename);
      if (!contentType) return json({ error: "That kind of file isn't accepted (PDF, Office documents, CSV, text and images are)" }, 400);
      if (typeof body.data_base64 !== "string" || body.data_base64.length > Math.ceil(MAX_BYTES / 3) * 4 + 8) return json({ error: "data_base64 is required, up to 20 MB" }, 400);
      const bytes = fromBase64(body.data_base64);
      if (!bytes || !bytes.length) return json({ error: "data_base64 isn't valid base64" }, 400);

      const { data: eng } = await admin.from("engagements").select("id, title").eq("id", engagementId).maybeSingle();
      if (!eng) return json({ error: "Engagement not found" }, 404);
      if (milestoneId) {
        const { data: m } = await admin.from("milestones").select("id").eq("id", milestoneId).eq("engagement_id", engagementId).maybeSingle();
        if (!m) return json({ error: "That milestone isn't in this engagement" }, 400);
      }

      const path = `${engagementId}/${crypto.randomUUID()}-${safeName(filename)}`;
      const { error: upErr } = await admin.storage.from("inbox").upload(path, bytes, { contentType, upsert: false });
      if (upErr) throw upErr;
      const { data: row, error: insErr } = await admin.from("inbox_documents").insert({
        engagement_id: engagementId, milestone_id: milestoneId, title, note: text(body.note, 2000), path, name: filename,
        size: bytes.length, content_type: contentType, suggest_team: body.suggest_team === true,
      }).select("id, title, name, size, created_at").single();
      if (insErr) {
        await admin.storage.from("inbox").remove([path]);
        throw insErr;
      }

      let emailed = false;
      if (body.notify !== false) {
        const { data: all } = await admin.from("inbox_documents").select("title").eq("engagement_id", engagementId).order("created_at");
        const list = (all ?? []).map((d) => `<li>${escapeHtml(d.title)}</li>`).join("");
        emailed = await sendEmail(ADMIN_EMAIL, `Waiting for your review: ${all?.length ?? 1} document${all?.length === 1 ? "" : "s"} for ${eng.title}`,
          layout("Documents waiting for your review", `<p>Filed for <strong>${escapeHtml(eng.title)}</strong>. Nobody else can see them until you share them.</p><ul>${list}</ul>`,
            { label: "Review them", url: `${SITE_URL}/portal/admin.html#engagement=${engagementId}/documents` }));
      }
      return json({ filed: row, emailed });
    }

    return json({ error: "Unknown action (use context or upload)" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message ?? "Something went wrong" }, 500);
  }
});
