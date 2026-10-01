// Fictional sample data for the portal's demo mode. No real client appears here.
const CLIENT_ID = "demo-client";
const ADMIN_ID = "demo-admin";
const ENG_ID = "demo-eng-1";
const Q_ID = "demo-q-1";
const ASG_ID = "demo-asg-1";

const Q = [
  ["A", "Where things stand today", "1", "Have you made any sales since launch? If so, how many units by month, and at what average price?", "Replaces the first months of the ramp with actual results.", "rerun"],
  ["A", "Where things stand today", "2", "What cash has been spent to date, on what, and from whose money?", "Pre-opening cost and founder contribution.", null],
  ["A", "Where things stand today", "3", "What has been signed that cannot be undone: leases, equipment purchases, notes?", "Which paths in the report are still open.", null],
  ["B", "Customers and price", "4", "Which named customers have committed to a price and volume in writing for the first 90 days?", "First-quarter volume and the first item on the diligence list.", "critical"],
  ["B", "Customers and price", "5", "What do your target customers pay their current supplier today?", "Tests the planned price; every 5% moves Year 3 profit materially.", "rerun"],
  ["B", "Customers and price", "6", "What payment terms do customers actually keep: days from delivery to cash?", "Working capital and the size of the credit line.", null],
  ["C", "Cost inputs", "7", "Who supplies your main raw material, at what delivered price, and is there a second source?", "The largest variable cost and the top supply risk.", "rerun"],
  ["C", "Cost inputs", "8", "What hourly rate and head count sit behind the monthly payroll allowance?", "Fixed cost per month.", null],
  ["C", "Cost inputs", "9", "What are the insurance quotes for liability, auto and workers' compensation?", "The monthly insurance allowance.", null],
  ["D", "Capital and financing", "10", "How much can the founders and their network realistically raise as patient capital, and by when?", "Whether the recommended capital structure is reachable.", null],
  ["D", "Capital and financing", "11", "Will current investors accept no principal repayment before the business stabilises?", "The single largest fix in the financing plan.", "critical"],
  ["D", "Capital and financing", "12", "Has any lender reviewed the plan? What did they say?", "Whether the proposed term loan is realistic.", null],
];

export function demoSeed() {
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();
  const questions = Q.map(([code, title, number, prompt, why, priority], i) => ({
    id: `demo-qq-${i + 1}`, questionnaire_id: Q_ID, position: i + 1, number,
    section_code: code, section_title: title, prompt, why, priority,
    answer_type: "long_text", required: false,
  }));
  return {
    profiles: [
      { id: ADMIN_ID, email: "michael@sypher.solutions", full_name: "Michael Furth", company: "Sypher Solutions", role: "admin", created_at: iso(120) },
      { id: CLIENT_ID, email: "avery@northwind.example", full_name: "Avery Morgan", company: "Northwind Ready-Mix (sample)", role: "client", created_at: iso(30) },
    ],
    engagements: [{
      id: ENG_ID, client_id: CLIENT_ID, status: "active", created_at: iso(30),
      title: "Business Feasibility Study",
      summary: "A feasibility study of the proposed launch: market, unit economics, financing and decision gates.",
      report_context: "Sample report context (demo). Base case assumes a $150 average selling price, a 36-month volume ramp, a $94 variable cost per unit and a $730k raise. Verdict: feasible as a business, not feasible as currently financed. Key sensitivities: price (each $5 moves Year 3 EBITDA by about $280k), supplier cost, and investor repayment timing.",
    }],
    questionnaires: [{
      id: Q_ID, created_at: iso(14),
      title: "Follow-up questions for the principal",
      description: "Twelve questions that decide whether the model needs to be rerun.",
      intro: "These questions are ordered by how much each answer moves the model. Answer what you can; mark anything you don't know yet and add a note on when you'll have it.",
    }],
    questions,
    assignments: [{
      id: ASG_ID, engagement_id: ENG_ID, questionnaire_id: Q_ID, status: "open",
      due_date: new Date(now + 9 * 864e5).toISOString().slice(0, 10),
      message: "Thank you for your time on these. The four marked High impact matter most, so please start there. — Michael",
      submitted_at: null, created_at: iso(14),
    }],
    answers: [
      { id: "demo-a-1", assignment_id: ASG_ID, question_id: "demo-qq-1", value: "No sales yet. First pours are now planned for November.", state: "answered", note: null, updated_at: iso(3) },
      { id: "demo-a-2", assignment_id: ASG_ID, question_id: "demo-qq-2", value: "About $86,000 so far, mostly site work and permits, all from the two founders.", state: "answered", note: null, updated_at: iso(3) },
      { id: "demo-a-5", assignment_id: ASG_ID, question_id: "demo-qq-5", value: "", state: "unknown", note: "Gathering three quotes from contractors this week.", updated_at: iso(2) },
    ],
    files: [],
    report_drafts: [],
    publications: [{
      id: "demo-pub-1", engagement_id: ENG_ID, draft_id: null, published_at: iso(14),
      title: "Your feasibility report is ready",
      body: "The full report is attached to our engagement. The short version: the business works at scale, but the financing as proposed does not yet cover the ramp. The follow-up questions now in your portal will tell us which of the paths in the report is right for you.",
    }],
    activity: [
      { id: "demo-act-1", engagement_id: ENG_ID, actor: ADMIN_ID, kind: "assignment_created", detail: { assignment_id: ASG_ID }, created_at: iso(14) },
    ],
  };
}

/** A canned draft for demo mode, built from whatever the visitor answered. */
export function demoDraft(questions, answers) {
  const byQ = new Map(answers.map((a) => [a.question_id, a]));
  const answered = questions.filter((q) => (byQ.get(q.id)?.value || "").trim() && byQ.get(q.id)?.state !== "unknown");
  const open = questions.filter((q) => !answered.includes(q)).map((q) => q.number);
  const rerun = answered.filter((q) => q.priority === "rerun");
  return {
    summary: `Demo draft. ${answered.length} of ${questions.length} questions were answered. In production, Claude reads every answer against your report context and drafts this section by section for your review.`,
    client_summary: "Thank you for working through the follow-up questions. Your answers are already sharpening the picture, and I'm reviewing what they mean for the model now. I'll come back to you shortly with the updated view and the few items still open.",
    data_points: answered.slice(0, 6).map((q) => ({
      question_number: q.number, label: q.prompt.split("?")[0].slice(0, 60), value: byQ.get(q.id).value.slice(0, 80),
      unit: "", confidence: "stated", source_quote: byQ.get(q.id).value.slice(0, 120),
    })),
    section_updates: answered.slice(0, 3).map((q) => ({
      section: q.section_title, change_type: q.priority === "rerun" ? "revise" : "confirm",
      rationale: `Answer to question ${q.number} (sample analysis).`,
      proposed_text: `Sample proposed wording reflecting the client's answer to question ${q.number}. In production this is written in your report's voice.`,
      question_numbers: [q.number],
    })),
    model_rerun: { required: rerun.length > 0, reasons: rerun.map((q) => `Question ${q.number} changes a model input.`), input_changes: [] },
    flags: open.length ? [{ severity: "high", issue: `${open.length} questions are still open, including high-impact ones.`, question_numbers: open.slice(0, 6) }] : [],
    follow_up_questions: open.slice(0, 3).map((n) => ({ question: `Could you confirm the answer to question ${n}, with any supporting quote or document?`, reason: "Still open after this round.", related_question_number: n })),
    open_questions: open,
  };
}

export const DEMO_IDS = { CLIENT_ID, ADMIN_ID };
