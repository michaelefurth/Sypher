// POST { kind: "message" | "deliverable" | "action_item", id }   (signed-in users)
// Emails the other side when something new lands in a client room:
//   message      client -> Michael (with the text), Michael -> client (a nudge to read it)
//   deliverable  Michael -> client
//   action_item  Michael -> client
// Message alerts are throttled: at most one email per thread and direction every 10 minutes,
// so a burst of short messages becomes a single alert. Only sent alerts start the window.
import { json, preflight } from "../_shared/http.ts";
import { admin, getCaller } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "michael@sypher.solutions";
const COOLDOWN_MS = 10 * 60 * 1000;

type Engagement = { id: string; title: string; client_id: string; profiles: { email: string; full_name: string | null; company: string | null } };

async function engagementOf(id: string): Promise<Engagement | null> {
  const { data } = await admin.from("engagements").select("id, title, client_id, profiles!inner(email, full_name, company)").eq("id", id).single();
  return data as unknown as Engagement | null;
}

const firstName = (name: string | null) => (name ? name.split(" ")[0] : "");
const roomUrl = (tab: string) => `${SITE_URL}/portal/dashboard.html#${tab}`;

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in first" }, 401);

  const { kind, id } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || !["message", "deliverable", "action_item"].includes(kind)) {
    return json({ error: "kind and id are required" }, 400);
  }

  if (kind === "message") {
    const { data: msg } = await admin.from("messages").select("id, engagement_id, author_id, body, created_at, notified_at").eq("id", id).single();
    if (!msg || msg.author_id !== caller.id) return json({ error: "Message not found" }, 404);
    if (msg.notified_at) return json({ sent: false, reason: "already notified" });

    const eng = await engagementOf(msg.engagement_id);
    if (!eng) return json({ error: "Engagement not found" }, 404);
    if (caller.role !== "admin" && eng.client_id !== caller.id) return json({ error: "Not allowed" }, 403);

    // Throttle: skip if this author already triggered an alert on this thread recently.
    const since = new Date(Date.now() - COOLDOWN_MS).toISOString();
    const { count } = await admin.from("messages").select("id", { count: "exact", head: true })
      .eq("engagement_id", msg.engagement_id).eq("author_id", caller.id).gte("notified_at", since);
    if ((count ?? 0) > 0) return json({ sent: false, reason: "throttled" });
    await admin.from("messages").update({ notified_at: new Date().toISOString() }).eq("id", msg.id);

    const client = eng.profiles;
    if (caller.role === "admin") {
      const hello = client.full_name ? `Dear ${escapeHtml(firstName(client.full_name))},` : "Hello,";
      await sendEmail(client.email, `A message from Michael: ${eng.title}`,
        layout("A message from Michael", `<p>${hello}</p><p>Michael has written to you about <em>${escapeHtml(eng.title)}</em>. You can read it and reply in your client room.</p>`,
          { label: "Read the message", url: roomUrl("messages") }));
    } else {
      const who = [client.full_name, client.company].filter(Boolean).join(", ") || client.email;
      const body = escapeHtml(msg.body.slice(0, 2000)).replace(/\n/g, "<br>");
      await sendEmail(ADMIN_EMAIL, `New message from ${who}`,
        layout(`New message from ${firstName(client.full_name) || who}`, `<p><em>${escapeHtml(eng.title)}</em></p><blockquote style="margin:0;padding:12px 16px;border-left:2px solid #D4B483;background:#F4F1EA">${body}</blockquote>`,
          { label: "Reply in the portal", url: `${SITE_URL}/portal/admin.html#engagement=${eng.id}` }));
    }
    return json({ sent: true });
  }

  // Deliverables and action items: only Michael shares them, so only Michael can announce them.
  if (caller.role !== "admin") return json({ error: "Admin only" }, 403);
  const table = kind === "deliverable" ? "deliverables" : "action_items";
  const { data: row } = await admin.from(table).select("id, engagement_id, title, due_date").eq("id", id).single();
  if (!row) return json({ error: "Not found" }, 404);
  const eng = await engagementOf(row.engagement_id);
  if (!eng) return json({ error: "Engagement not found" }, 404);

  const client = eng.profiles;
  const hello = client.full_name ? `Dear ${escapeHtml(firstName(client.full_name))},` : "Hello,";
  if (kind === "deliverable") {
    await sendEmail(client.email, `New document: ${row.title}`,
      layout("A new document for you", `<p>${hello}</p><p>Michael has shared <strong>${escapeHtml(row.title)}</strong> for <em>${escapeHtml(eng.title)}</em>. It's in the Documents section of your client room.</p>`,
        { label: "Open your documents", url: roomUrl("documents") }));
  } else {
    const due = row.due_date ? ` by ${new Date(row.due_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
    await sendEmail(client.email, `Something for you: ${row.title}`,
      layout("Something for you", `<p>${hello}</p><p>Michael has added an item to your list for <em>${escapeHtml(eng.title)}</em>${escapeHtml(due)}:</p><p><strong>${escapeHtml(row.title)}</strong></p><p>Tick it off in your client room once it's done.</p>`,
        { label: "Open your client room", url: roomUrl("overview") }));
  }
  return json({ sent: true });
});
