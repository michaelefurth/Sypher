// POST { assignment_id }
// Called by the portal right after a client submits a questionnaire (or by the
// admin to regenerate). Creates an admin-only draft, returns immediately, and
// finishes the Claude analysis in the background, then emails Michael.
import { generateDraft, type QuestionAnswer } from "../_shared/claude.ts";
import { json, preflight } from "../_shared/http.ts";
import { admin, getCaller, logActivity } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "michael@sypher.solutions";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);

  const { assignment_id } = await req.json().catch(() => ({}));
  if (typeof assignment_id !== "string") return json({ error: "assignment_id is required" }, 400);

  const { data: assignment } = await admin
    .from("assignments")
    .select("id, status, engagement_id, questionnaire_id, engagements!inner(id, title, client_id, report_context), questionnaires!inner(title)")
    .eq("id", assignment_id)
    .single();
  if (!assignment) return json({ error: "Not found" }, 404);

  const engagement = assignment.engagements as unknown as { id: string; title: string; client_id: string; report_context: string | null };
  const questionnaire = assignment.questionnaires as unknown as { title: string };
  const isOwner = engagement.client_id === caller.id;
  if (!isOwner && caller.role !== "admin") return json({ error: "Not allowed" }, 403);
  if (caller.role !== "admin" && assignment.status !== "submitted") {
    return json({ error: "Submit the questionnaire first" }, 409);
  }

  const { data: draftRow, error: insertError } = await admin
    .from("report_drafts")
    .insert({ engagement_id: engagement.id, assignment_id, status: "drafting" })
    .select("id")
    .single();
  if (insertError || !draftRow) return json({ error: "Could not start the draft" }, 500);

  const work = buildDraft(draftRow.id, assignment_id, assignment.questionnaire_id, engagement, questionnaire.title);
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;

  return json({ draft_id: draftRow.id, status: "drafting" }, 202);
});

async function buildDraft(
  draftId: string,
  assignmentId: string,
  questionnaireId: string,
  engagement: { id: string; title: string; report_context: string | null },
  questionnaireTitle: string,
) {
  try {
    const [{ data: questions }, { data: answers }, { data: files }] = await Promise.all([
      admin.from("questions").select("id, number, section_code, section_title, prompt, why, priority").eq("questionnaire_id", questionnaireId).order("position"),
      admin.from("answers").select("question_id, value, state, note").eq("assignment_id", assignmentId),
      admin.from("files").select("question_id, name").eq("assignment_id", assignmentId),
    ]);

    const byQuestion = new Map((answers ?? []).map((a) => [a.question_id, a]));
    const qa: QuestionAnswer[] = (questions ?? []).map((q) => {
      const a = byQuestion.get(q.id);
      return {
        number: q.number,
        section: [q.section_code, q.section_title].filter(Boolean).join(". ") || null,
        priority: q.priority,
        prompt: q.prompt,
        why: q.why,
        value: a?.value ?? null,
        state: a?.state ?? null,
        note: a?.note ?? null,
        attachments: (files ?? []).filter((f) => f.question_id === q.id).map((f) => f.name),
      };
    });

    const { draft, model } = await generateDraft({
      engagementTitle: engagement.title,
      reportContext: engagement.report_context,
      questionnaireTitle,
      questions: qa,
    });

    await admin.from("report_drafts").update({ status: "awaiting_review", draft, model }).eq("id", draftId);
    await logActivity(engagement.id, null, "draft_ready", { draft_id: draftId });

    const flags = draft.flags.filter((f) => f.severity === "high").length;
    const body = `<p>${escapeHtml(engagement.title)}: the answers to <em>${escapeHtml(questionnaireTitle)}</em> have been analysed.</p>
      <p>${escapeHtml(draft.summary)}</p>
      <p style="font:14px Arial,sans-serif;color:#0B2D3B">${draft.section_updates.length} proposed section updates &middot; ${flags} high-priority flags &middot; ${draft.follow_up_questions.length} follow-up questions${draft.model_rerun.required ? " &middot; <strong>model rerun recommended</strong>" : ""}</p>`;
    await sendEmail(ADMIN_EMAIL, `Draft ready for review: ${engagement.title}`,
      layout("A draft update is ready for your review", body, { label: "Review the draft", url: `${SITE_URL}/portal/admin.html#draft=${draftId}` }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("draft failed", draftId, message);
    await admin.from("report_drafts").update({ status: "failed", error: message }).eq("id", draftId);
    await sendEmail(ADMIN_EMAIL, `Draft failed: ${engagement.title}`,
      layout("A draft could not be generated", `<p>${escapeHtml(message)}</p><p>You can regenerate it from the admin portal.</p>`,
        { label: "Open the portal", url: `${SITE_URL}/portal/admin.html` }));
  }
}
