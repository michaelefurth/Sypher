// POST { name, email, company?, role?, phone?, practices[], answers[], website?, started_at? }   (public)
// Receives the website diagnostic. Stores it for Michael (admin-only), confirms
// receipt to the prospect, and drafts a pre-call brief with Claude in the
// background before emailing Michael.
// Deploy with: supabase functions deploy submit-inquiry --no-verify-jwt
import { generateBrief, PRACTICES, type InquiryAnswer, type InquiryBrief } from "../_shared/brief.ts";
import { json, preflight } from "../_shared/http.ts";
import { admin } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "michael@sypher.solutions";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const raw = await req.text();
  if (raw.length > 60_000) return json({ error: "That's more than we can take in one go. Please shorten a few answers." }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid request" }, 400); }

  // Bots fill the hidden field or submit instantly. Accept quietly, store nothing.
  const startedAt = Number(body.started_at) || 0;
  if (clip(body.website, 200) || (startedAt && Date.now() - startedAt < 4000)) return json({ ok: true });

  const name = clip(body.name, 200);
  const email = clip(body.email, 320).toLowerCase();
  if (name.length < 2 || !EMAIL_RE.test(email)) return json({ error: "Please give your name and a valid email." }, 400);

  const practices = (Array.isArray(body.practices) ? body.practices : [])
    .filter((p): p is string => typeof p === "string" && ([...PRACTICES, "Not sure"] as string[]).includes(p))
    .slice(0, 8);
  const answers: InquiryAnswer[] = (Array.isArray(body.answers) ? body.answers : []).slice(0, 40)
    .map((a: Record<string, unknown>) => ({ key: clip(a?.key, 60), section: clip(a?.section, 80), question: clip(a?.question, 400), answer: clip(a?.answer, 4000) }))
    .filter((a) => a.question && a.answer);
  if (!answers.length) return json({ error: "Please answer at least one question." }, 400);

  // A light limit per address, so a stuck button or a script can't flood the inbox.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("inquiries").select("id", { count: "exact", head: true }).eq("email", email).gte("created_at", since);
  if ((count ?? 0) >= 3) return json({ error: "We already have your notes. Michael will be in touch." }, 429);

  const row = {
    name, email, practices, answers,
    company: clip(body.company, 200) || null,
    role: clip(body.role, 200) || null,
    phone: clip(body.phone, 60) || null,
    brief_status: Deno.env.get("ANTHROPIC_API_KEY") ? "pending" : "skipped",
  };
  const { data: inquiry, error } = await admin.from("inquiries").insert(row).select("id").single();
  if (error || !inquiry) return json({ error: "Something went wrong saving your answers. Please email michael@sypher.solutions." }, 500);

  const first = name.split(/\s+/)[0];
  await sendEmail(email, "Michael has your notes",
    layout(`Thank you, ${first}.`, `<p>Your answers are with Michael Furth. He reads every one himself before the first conversation, so the thirty minutes go on your situation rather than on background.</p><p>He'll reply from michael@sypher.solutions to arrange a time. If anything changes in the meantime, simply reply to that email.</p>`));

  const work = finish(inquiry.id, row);
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;

  return json({ ok: true, id: inquiry.id }, 201);
});

async function finish(id: string, row: { name: string; email: string; company: string | null; role: string | null; phone: string | null; practices: string[]; answers: InquiryAnswer[]; brief_status: string }) {
  let brief: InquiryBrief | null = null;
  if (row.brief_status === "pending") {
    try {
      const out = await generateBrief(row);
      brief = out.brief;
      await admin.from("inquiries").update({ brief, brief_status: "ready", brief_model: out.model }).eq("id", id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("brief failed", id, message);
      await admin.from("inquiries").update({ brief_status: "failed", brief_error: message }).eq("id", id);
    }
  }

  const who = [row.name, row.role, row.company].filter(Boolean).map((x) => escapeHtml(x!)).join(" · ");
  const briefHtml = brief
    ? `<p>${escapeHtml(brief.summary)}</p>
       <p style="font-style:italic;color:#0B2D3B">“${escapeHtml(brief.in_their_words)}”</p>
       <p style="font:14px Arial,sans-serif;color:#0B2D3B"><strong>Ask first:</strong> ${escapeHtml(brief.questions_for_the_call[0] ?? "")}</p>`
    : "";
  const answersHtml = row.answers.slice(0, 12).map((a) =>
    `<p style="margin:0 0 12px"><strong style="font:13px Arial,sans-serif;color:#0B2D3B">${escapeHtml(a.question)}</strong><br>${escapeHtml(a.answer)}</p>`).join("");
  await sendEmail(ADMIN_EMAIL, `New diagnostic: ${row.company || row.name}`,
    layout("A new diagnostic is in", `<p>${who}<br><a href="mailto:${escapeHtml(row.email)}">${escapeHtml(row.email)}</a>${row.phone ? ` · ${escapeHtml(row.phone)}` : ""}</p>
      <p style="font:13px Arial,sans-serif;color:#6B7780">Practices: ${escapeHtml(row.practices.join(", ") || "Not sure")}</p>
      ${briefHtml}${briefHtml ? `<div style="height:1px;background:#EAE6DF;margin:20px 0"></div>` : ""}${answersHtml}`,
      { label: "Open the brief", url: `${SITE_URL}/portal/admin.html#inquiry=${id}` }));
}
