// POST { kind: "message" | "deliverable" | "action_item" | "team_file" | "request_update" | "pricing", id }   (signed-in users)
// Emails the right people when something new lands in a client room:
//   message, private thread  client -> Michael (with the text); Michael -> client (a nudge to read it)
//   message, team thread     everyone else on the team who can message (a nudge, never the text)
//   deliverable              Michael -> client
//   action_item              whoever it's asked of (the client, a team member, or Michael)
//   request_update           answered: whoever asked, and Michael; reviewed: whoever answers it
//   pricing                  submitted: the client and Michael; reviewed: the contractor
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
  const { data } = await admin.from("engagements").select("id, title, client_id, profiles!engagements_client_id_fkey!inner(email, full_name, company)").eq("id", id).single();
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

  // Every send goes through mail(); if Resend refuses any of them the answer says so, so the
  // portal never tells someone "they've been emailed" when they haven't been.
  let failed = 0;
  const mail = async (to: string, subject: string, html: string) => { if (!(await sendEmail(to, subject, html))) failed++; };
  const done = (body: Record<string, unknown>) => json(failed ? { ...body, sent: false, reason: "email failed", failed } : body);

  const { kind, id } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || !["message", "deliverable", "action_item", "team_file", "request_update", "pricing"].includes(kind)) {
    return json({ error: "kind and id are required" }, 400);
  }

  if (kind === "message") {
    const { data: msg } = await admin.from("messages").select("id, engagement_id, author_id, body, thread, notified_at").eq("id", id).single();
    if (!msg || msg.author_id !== caller.id) return json({ error: "Message not found" }, 404);
    if (msg.notified_at) return done({ sent: false, reason: "already notified" });
    const eng = await engagementOf(msg.engagement_id);
    if (!eng) return json({ error: "Engagement not found" }, 404);

    // Throttle per thread and author.
    const since = new Date(Date.now() - COOLDOWN_MS).toISOString();
    const { count } = await admin.from("messages").select("id", { count: "exact", head: true })
      .eq("engagement_id", msg.engagement_id).eq("thread", msg.thread).eq("author_id", caller.id).gte("notified_at", since);
    if ((count ?? 0) > 0) return done({ sent: false, reason: "throttled" });

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
        await mail(to, `New team message: ${eng.title}`,
          layout("A new team message", `<p>${greet(name)}</p><p>${escapeHtml(author)} wrote in the team thread for <em>${escapeHtml(eng.title)}</em>. You can read it and reply in the portal.</p>`,
            { label: "Open the team thread", url: roomUrl(to === client.email ? "team" : "messages") }));
      }
      return done({ sent: recipients.size > 0 });
    }

    // Private thread: only the client and Michael.
    if (caller.role !== "admin" && eng.client_id !== caller.id) return json({ error: "Not allowed" }, 403);
    await admin.from("messages").update({ notified_at: new Date().toISOString() }).eq("id", msg.id);
    if (caller.role === "admin") {
      await mail(client.email, `A message from Michael: ${eng.title}`,
        layout("A message from Michael", `<p>${greet(client.full_name)}</p><p>Michael has written to you about <em>${escapeHtml(eng.title)}</em>. You can read it and reply in your client room.</p>`,
          { label: "Read the message", url: roomUrl("messages") }));
    } else {
      const who = [client.full_name, client.company].filter(Boolean).join(", ") || client.email;
      const text = escapeHtml(msg.body.slice(0, 2000)).replace(/\n/g, "<br>");
      await mail(ADMIN_EMAIL, `New message from ${who}`,
        layout(`New message from ${firstName(client.full_name) || who}`, `<p><em>${escapeHtml(eng.title)}</em></p><blockquote style="margin:0;padding:12px 16px;border-left:2px solid #D4B483;background:#F4F1EA">${text}</blockquote>`,
          { label: "Reply in the portal", url: `${SITE_URL}/portal/admin.html#engagement=${eng.id}` }));
    }
    return done({ sent: true });
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
    if (caller.id !== eng.client_id) await mail(eng.profiles.email, `New team file: ${f.name}`, html(eng.profiles.full_name));
    if (caller.role !== "admin") await mail(ADMIN_EMAIL, `New team file: ${f.name}`, html("Michael"));
    return done({ sent: true });
  }

  // Who someone is on an engagement, for "X has asked you…" lines.
  const nameOn = (eng: Engagement, members: Member[], uid: string | null) =>
    !uid ? null
      : uid === eng.client_id ? (eng.profiles.full_name || eng.profiles.email)
      : members.find((x) => x.user_id === uid)?.full_name || members.find((x) => x.user_id === uid)?.email || null;
  /** The email address for a person on an engagement: the client, a team member, or Michael. */
  async function addressOf(eng: Engagement, members: Member[], uid: string | null): Promise<[string, string | null] | null> {
    if (!uid || uid === eng.client_id) return [eng.profiles.email, eng.profiles.full_name];
    const m = members.find((x) => x.user_id === uid);
    if (m) return [m.email, m.full_name];
    const { data: p } = await admin.from("profiles").select("role").eq("id", uid).single();
    return p?.role === "admin" ? [ADMIN_EMAIL, "Michael"] : null;
  }
  const KIND_WORD: Record<string, string> = { task: "a to-do", document: "a document", answer: "an answer", approval: "your approval", pricing: "pricing" };

  if (kind === "action_item") {
    const { data: row } = await admin.from("action_items").select("id, engagement_id, title, detail, due_date, assignee_id, created_by, kind").eq("id", id).single();
    if (!row) return json({ error: "Not found" }, 404);
    const eng = await engagementOf(row.engagement_id);
    if (!eng) return json({ error: "Engagement not found" }, 404);
    if (caller.role !== "admin" && row.created_by !== caller.id) return json({ error: "Not allowed" }, 403);
    const members = await activeMembers(eng.id);
    if (row.assignee_id === caller.id || (!row.assignee_id && caller.id === eng.client_id)) return done({ sent: false, reason: "own to-do" });
    const to = await addressOf(eng, members, row.assignee_id);
    if (!to) return done({ sent: false, reason: "assignee has no access" });
    const from = caller.role === "admin" ? "Michael" : nameOn(eng, members, caller.id) || "Someone on the team";
    const due = row.due_date ? ` by ${new Date(row.due_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
    const url = to[0] === ADMIN_EMAIL ? `${SITE_URL}/portal/admin.html#engagement=${eng.id}` : roomUrl(row.kind === "pricing" ? "pricing" : "requests");
    await mail(to[0], `${row.kind === "task" ? "Something for you" : "A request for you"}: ${row.title}`,
      layout(row.kind === "task" ? "Something for you" : "A request for you", `<p>${greet(to[1])}</p><p>${escapeHtml(from)} has asked you for ${KIND_WORD[row.kind] ?? "something"} on <em>${escapeHtml(eng.title)}</em>${escapeHtml(due)}:</p><p><strong>${escapeHtml(row.title)}</strong></p>${row.detail ? `<p>${escapeHtml(row.detail)}</p>` : ""}<p>${row.kind === "task" ? "Tick it off in the portal once it's done." : "You can answer, and attach files, in the portal."}</p>`,
        { label: "Open the portal", url }));
    return done({ sent: true });
  }

  // A request was answered (tell whoever asked, and Michael) or reviewed (tell whoever answers it).
  if (kind === "request_update") {
    const { data: row } = await admin.from("action_items").select("id, engagement_id, title, kind, status, assignee_id, created_by, submitted_by, review_note, response").eq("id", id).single();
    if (!row) return json({ error: "Not found" }, 404);
    const eng = await engagementOf(row.engagement_id);
    if (!eng) return json({ error: "Engagement not found" }, 404);
    const members = await activeMembers(eng.id);
    const isParty = caller.role === "admin" || caller.id === eng.client_id || members.some((m) => m.user_id === caller.id);
    if (!isParty) return json({ error: "Not allowed" }, 403);
    const who = caller.role === "admin" ? "Michael" : nameOn(eng, members, caller.id) || "Someone on the team";
    const send = new Map<string, string | null>();
    if (row.status === "submitted") {
      if (row.submitted_by !== caller.id) return done({ sent: false, reason: "not the responder" });
      const a = await addressOf(eng, members, row.created_by); if (a && row.created_by !== caller.id) send.set(a[0], a[1]);
      if (caller.role !== "admin") send.set(ADMIN_EMAIL, "Michael");
      for (const [to, name] of send) {
        await mail(to, `Answered: ${row.title}`,
          layout("A request has been answered", `<p>${greet(name)}</p><p>${escapeHtml(who)} has answered <strong>${escapeHtml(row.title)}</strong> on <em>${escapeHtml(eng.title)}</em>. Review it in the portal: accept it, or ask for changes.</p>`,
            { label: "Review it", url: to === ADMIN_EMAIL ? `${SITE_URL}/portal/admin.html#engagement=${eng.id}` : roomUrl("requests") }));
      }
    } else if (row.status === "accepted" || row.status === "changes_requested") {
      const target = row.assignee_id ?? eng.client_id;
      if (target === caller.id) return done({ sent: false, reason: "own request" });
      const a = await addressOf(eng, members, target);
      if (!a) return done({ sent: false, reason: "no access" });
      const accepted = row.status === "accepted";
      await mail(a[0], `${accepted ? "Accepted" : "Changes requested"}: ${row.title}`,
        layout(accepted ? "Accepted, thank you" : "A change is needed", `<p>${greet(a[1])}</p><p>${escapeHtml(who)} has ${accepted ? "accepted" : "asked for changes to"} <strong>${escapeHtml(row.title)}</strong> on <em>${escapeHtml(eng.title)}</em>.</p>${row.review_note ? `<blockquote style="margin:0;padding:12px 16px;border-left:2px solid #D4B483;background:#F4F1EA">${escapeHtml(row.review_note)}</blockquote>` : ""}`,
          { label: "Open the portal", url: a[0] === ADMIN_EMAIL ? `${SITE_URL}/portal/admin.html#engagement=${eng.id}` : roomUrl(row.kind === "pricing" ? "pricing" : "requests") }));
      send.set(a[0], a[1]);
    }
    return done({ sent: send.size > 0 });
  }

  // Pricing: a submitted sheet goes to the client and Michael; a review goes to the contractor.
  if (kind === "pricing") {
    const { data: s } = await admin.from("sov_sheets").select("id, engagement_id, title, status, version, contractor_id, review_note").eq("id", id).single();
    if (!s) return json({ error: "Not found" }, 404);
    const eng = await engagementOf(s.engagement_id);
    if (!eng) return json({ error: "Engagement not found" }, 404);
    const members = await activeMembers(eng.id);
    if (s.status === "submitted") {
      if (caller.role !== "admin" && caller.id !== s.contractor_id) return json({ error: "Not allowed" }, 403);
      const who = nameOn(eng, members, s.contractor_id) || "The contractor";
      const html = (name: string | null) => layout("Pricing submitted", `<p>${greet(name)}</p><p>${escapeHtml(who)} has submitted pricing for <strong>${escapeHtml(s.title)}</strong> (version ${s.version}) on <em>${escapeHtml(eng.title)}</em>. It's in the Pricing tab, line by line beside the budget.</p>`,
        { label: "Review the pricing", url: roomUrl("pricing") });
      await mail(eng.profiles.email, `Pricing submitted: ${s.title}`, html(eng.profiles.full_name));
      if (caller.role !== "admin") await mail(ADMIN_EMAIL, `Pricing submitted: ${s.title}`, html("Michael"));
      return done({ sent: true });
    }
    if (s.status === "accepted" || s.status === "changes_requested") {
      if (caller.role !== "admin" && caller.id !== eng.client_id) return json({ error: "Not allowed" }, 403);
      const a = await addressOf(eng, members, s.contractor_id);
      if (!a || !s.contractor_id) return done({ sent: false, reason: "no contractor" });
      const accepted = s.status === "accepted";
      await mail(a[0], `${accepted ? "Pricing accepted" : "Changes requested"}: ${s.title}`,
        layout(accepted ? "Your pricing is accepted" : "A change to your pricing", `<p>${greet(a[1])}</p><p>Your pricing for <strong>${escapeHtml(s.title)}</strong> on <em>${escapeHtml(eng.title)}</em> has been ${accepted ? "accepted" : "sent back with a note"}.</p>${s.review_note ? `<blockquote style="margin:0;padding:12px 16px;border-left:2px solid #D4B483;background:#F4F1EA">${escapeHtml(s.review_note)}</blockquote>` : ""}${accepted ? "" : "<p>Lines with questions are marked on the sheet. Your earlier figures are kept.</p>"}`,
          { label: "Open the sheet", url: roomUrl("pricing") }));
      return done({ sent: true });
    }
    return done({ sent: false, reason: "nothing to send" });
  }

  // Deliverables: only Michael shares them.
  if (caller.role !== "admin") return json({ error: "Admin only" }, 403);
  const { data: d } = await admin.from("deliverables").select("id, engagement_id, title").eq("id", id).single();
  if (!d) return json({ error: "Not found" }, 404);
  const eng = await engagementOf(d.engagement_id);
  if (!eng) return json({ error: "Engagement not found" }, 404);
  await mail(eng.profiles.email, `New document: ${d.title}`,
    layout("A new document for you", `<p>${greet(eng.profiles.full_name)}</p><p>Michael has shared <strong>${escapeHtml(d.title)}</strong> for <em>${escapeHtml(eng.title)}</em>. It's in the Documents section of your client room.</p>`,
      { label: "Open your documents", url: roomUrl("documents") }));
  return done({ sent: true });
});
