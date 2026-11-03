// POST { kind: "message" | "deliverable" | "action_item" | "team_file", id }   (signed-in users)
// Emails the right people when something new lands in a client room:
//   message, private thread  client -> Michael (with the text); Michael -> client (a nudge to read it)
//   message, team thread     everyone else on the team who can message (a nudge, never the text)
//   deliverable              Michael -> client
//   action_item              whoever it's assigned to (the client, or a team member)
//   team_file                the client and Michael, whoever didn't upload it
// Message alerts are throttled: at most one email per thread and author every 10 minutes,
// so a burst of short messages becomes a single alert. Only sent alerts start the window.
import { json, preflight } from "../_shared/http.ts";
import { admin, getCaller } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "michael@sypher.solutions";
const COOLDOWN_MS = 10 * 60 * 1000;

type Engagement = { id: string; title: string; client_id: string; profiles: { email: string; full_name: string | null; company: string | null } };
type Member = { user_id: string; email: string; full_name: string | null; role_label: string | null; can_message: boolean; can_files: boolean };

async function engagementOf(id: string): Promise<Engagement | null> {
  const { data } = await admin.from("engagements").select("id, title, client_id, profiles!inner(email, full_name, company)").eq("id", id).single();
  return data as unknown as Engagement | null;
}

async function activeMembers(engagementId: string): Promise<Member[]> {
  const { data } = await admin.from("engagement_members").select("user_id, email, full_name, role_label, can_message, can_files, expires_at")
    .eq("engagement_id", engagementId).eq("status", "active");
  const now = Date.now();
  return ((data ?? []) as (Member & { expires_at: string | null })[]).filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > now);
}

const firstName = (name: string | null) => (name ? name.split(" ")[0] : "");
const greet = (name: string | null) => (name ? `Dear ${escapeHtml(firstName(name))},` : "Hello,");
const roomUrl = (tab: string) => `${SITE_URL}/portal/dashboard.html#${tab}`;

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in first" }, 401);

  const { kind, id } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || !["message", "deliverable", "action_item", "team_file"].includes(kind)) {
    return json({ error: "kind and id are required" }, 400);
  }

  if (kind === "message") {
    const { data: msg } = await admin.from("messages").select("id, engagement_id, author_id, body, thread, notified_at").eq("id", id).single();
    if (!msg || msg.author_id !== caller.id) return json({ error: "Message not found" }, 404);
    if (msg.notified_at) return json({ sent: false, reason: "already notified" });
    const eng = await engagementOf(msg.engagement_id);
    if (!eng) return json({ error: "Engagement not found" }, 404);

    // Throttle per thread and author.
    const since = new Date(Date.now() - COOLDOWN_MS).toISOString();
    const { count } = await admin.from("messages").select("id", { count: "exact", head: true })
      .eq("engagement_id", msg.engagement_id).eq("thread", msg.thread).eq("author_id", caller.id).gte("notified_at", since);
    if ((count ?? 0) > 0) return json({ sent: false, reason: "throttled" });

    const client = eng.profiles;
    if (msg.thread === "team") {
      const members = await activeMembers(eng.id);
      const author = caller.role === "admin" ? "Michael Furth"
        : caller.id === eng.client_id ? (client.full_name || client.email)
        : (() => { const m = members.find((x) => x.user_id === caller.id); return m ? [m.full_name || m.email, m.role_label].filter(Boolean).join(", ") : "A team member"; })();
      if (caller.role !== "admin" && caller.id !== eng.client_id && !members.some((m) => m.user_id === caller.id && m.can_message)) {
        return json({ error: "Not allowed" }, 403);
      }
      const recipients = new Map<string, string | null>();
      if (caller.id !== eng.client_id) recipients.set(client.email, client.full_name);
      if (caller.role !== "admin") recipients.set(ADMIN_EMAIL, "Michael");
      for (const m of members) if (m.can_message && m.user_id !== caller.id) recipients.set(m.email, m.full_name);
      await admin.from("messages").update({ notified_at: new Date().toISOString() }).eq("id", msg.id);
      for (const [to, name] of recipients) {
        await sendEmail(to, `New team message: ${eng.title}`,
          layout("A new team message", `<p>${greet(name)}</p><p>${escapeHtml(author)} wrote in the team thread for <em>${escapeHtml(eng.title)}</em>. You can read it and reply in the portal.</p>`,
            { label: "Open the team thread", url: roomUrl(to === client.email ? "team" : "messages") }));
      }
      return json({ sent: recipients.size > 0 });
    }

    // Private thread: only the client and Michael.
    if (caller.role !== "admin" && eng.client_id !== caller.id) return json({ error: "Not allowed" }, 403);
    await admin.from("messages").update({ notified_at: new Date().toISOString() }).eq("id", msg.id);
    if (caller.role === "admin") {
      await sendEmail(client.email, `A message from Michael: ${eng.title}`,
        layout("A message from Michael", `<p>${greet(client.full_name)}</p><p>Michael has written to you about <em>${escapeHtml(eng.title)}</em>. You can read it and reply in your client room.</p>`,
          { label: "Read the message", url: roomUrl("messages") }));
    } else {
      const who = [client.full_name, client.company].filter(Boolean).join(", ") || client.email;
      const text = escapeHtml(msg.body.slice(0, 2000)).replace(/\n/g, "<br>");
      await sendEmail(ADMIN_EMAIL, `New message from ${who}`,
        layout(`New message from ${firstName(client.full_name) || who}`, `<p><em>${escapeHtml(eng.title)}</em></p><blockquote style="margin:0;padding:12px 16px;border-left:2px solid #D4B483;background:#F4F1EA">${text}</blockquote>`,
          { label: "Reply in the portal", url: `${SITE_URL}/portal/admin.html#engagement=${eng.id}` }));
    }
    return json({ sent: true });
  }

  if (kind === "team_file") {
    const { data: f } = await admin.from("team_files").select("id, engagement_id, name, uploaded_by").eq("id", id).single();
    if (!f || f.uploaded_by !== caller.id) return json({ error: "Not found" }, 404);
    const eng = await engagementOf(f.engagement_id);
    if (!eng) return json({ error: "Engagement not found" }, 404);
    const members = await activeMembers(eng.id);
    const m = members.find((x) => x.user_id === caller.id);
    const who = caller.role === "admin" ? "Michael Furth" : caller.id === eng.client_id ? (eng.profiles.full_name || eng.profiles.email) : m ? [m.full_name || m.email, m.role_label].filter(Boolean).join(", ") : "A team member";
    const html = (name: string | null) => layout("A new team file", `<p>${greet(name)}</p><p>${escapeHtml(who)} added <strong>${escapeHtml(f.name)}</strong> to the team files for <em>${escapeHtml(eng.title)}</em>.</p>`,
      { label: "Open the portal", url: `${SITE_URL}/portal/` });
    if (caller.id !== eng.client_id) await sendEmail(eng.profiles.email, `New team file: ${f.name}`, html(eng.profiles.full_name));
    if (caller.role !== "admin") await sendEmail(ADMIN_EMAIL, `New team file: ${f.name}`, html("Michael"));
    return json({ sent: true });
  }

  if (kind === "action_item") {
    const { data: row } = await admin.from("action_items").select("id, engagement_id, title, due_date, assignee_id, created_by").eq("id", id).single();
    if (!row) return json({ error: "Not found" }, 404);
    const eng = await engagementOf(row.engagement_id);
    if (!eng) return json({ error: "Engagement not found" }, 404);
    if (caller.role !== "admin" && !(caller.id === eng.client_id && row.created_by === caller.id)) return json({ error: "Not allowed" }, 403);
    let to = eng.profiles.email, name = eng.profiles.full_name;
    if (row.assignee_id && row.assignee_id !== eng.client_id) {
      const m = (await activeMembers(eng.id)).find((x) => x.user_id === row.assignee_id);
      if (!m) return json({ sent: false, reason: "assignee has no access" });
      to = m.email; name = m.full_name;
    } else if (caller.id === eng.client_id) {
      return json({ sent: false, reason: "own to-do" });
    }
    const from = caller.role === "admin" ? "Michael" : (eng.profiles.full_name || "Your client");
    const due = row.due_date ? ` by ${new Date(row.due_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
    await sendEmail(to, `Something for you: ${row.title}`,
      layout("Something for you", `<p>${greet(name)}</p><p>${escapeHtml(from)} has added an item for you on <em>${escapeHtml(eng.title)}</em>${escapeHtml(due)}:</p><p><strong>${escapeHtml(row.title)}</strong></p><p>Tick it off in the portal once it's done.</p>`,
        { label: "Open the portal", url: `${SITE_URL}/portal/` }));
    return json({ sent: true });
  }

  // Deliverables: only Michael shares them.
  if (caller.role !== "admin") return json({ error: "Admin only" }, 403);
  const { data: d } = await admin.from("deliverables").select("id, engagement_id, title").eq("id", id).single();
  if (!d) return json({ error: "Not found" }, 404);
  const eng = await engagementOf(d.engagement_id);
  if (!eng) return json({ error: "Engagement not found" }, 404);
  await sendEmail(eng.profiles.email, `New document: ${d.title}`,
    layout("A new document for you", `<p>${greet(eng.profiles.full_name)}</p><p>Michael has shared <strong>${escapeHtml(d.title)}</strong> for <em>${escapeHtml(eng.title)}</em>. It's in the Documents section of your client room.</p>`,
      { label: "Open your documents", url: roomUrl("documents") }));
  return json({ sent: true });
});
