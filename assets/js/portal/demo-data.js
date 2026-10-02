// Fictional sample data for the portal's demo mode. No real client appears here.
const CLIENT_ID = "demo-client";
const ADMIN_ID = "demo-admin";
const ENG_ID = "demo-eng-1";
const Q_ID = "demo-q-1";
const ASG_ID = "demo-asg-1";
const INQ_ID = "demo-inq-1";
const PROP_SENT = "demo-prop-1";
const PROP_DONE = "demo-prop-0";

const Q = [
  ["A", "Where things stand today", "1", "How many cases did the first kitchen sell each month over the last two years, by channel?", "Replaces the assumed ramp with your actual history.", "rerun"],
  ["A", "Where things stand today", "2", "What has been spent on the second site so far, on what, and from whose money?", "Pre-opening cost and owner contribution.", null],
  ["A", "Where things stand today", "3", "What has been signed that can't be undone: a lease, equipment orders, notes?", "Which paths in the report are still open.", null],
  ["B", "Customers and price", "4", "Which wholesale accounts have committed in writing to volume from the new kitchen?", "First-year volume and the first item on the diligence list.", "critical"],
  ["B", "Customers and price", "5", "What do your largest accounts pay per case today, and when did you last raise prices?", "Tests the planned price; small changes move Year 2 profit materially.", "rerun"],
  ["B", "Customers and price", "6", "What payment terms do wholesale accounts actually keep: days from delivery to cash?", "Working capital and the size of the credit line.", null],
  ["C", "Cost inputs", "7", "Who supplies your main ingredients, at what delivered price, and is there a second source?", "The largest variable cost and the top supply risk.", "rerun"],
  ["C", "Cost inputs", "8", "What hourly rate and head count sit behind the monthly payroll allowance?", "Fixed cost per month.", null],
  ["C", "Cost inputs", "9", "What are the insurance quotes for liability, auto and workers' compensation?", "The monthly insurance allowance.", null],
  ["D", "Capital and financing", "10", "How much can the owners and their network realistically put in as patient capital, and by when?", "Whether the recommended capital structure is reachable.", null],
  ["D", "Capital and financing", "11", "Will the current lender accept interest-only payments through the ramp?", "The single largest fix in the financing plan.", "critical"],
  ["D", "Capital and financing", "12", "Has a second lender reviewed the plan? What did they say?", "Whether the proposed term loan is realistic.", null],
];

/** Starting terms for a new proposal. Michael edits these to match his engagement letter. */
export const DEFAULT_TERMS = [
  "Fees. Fixed-fee work is invoiced half at signing and half on delivery. Retainers are invoiced monthly in advance. Expenses only with your prior approval, at cost.",
  "Confidentiality. Everything you share stays confidential and is used only for this engagement. Your name is never used publicly without written permission.",
  "Ownership. Everything built for you is yours on payment: models, documents, accounts and code.",
  "Changes. If the scope changes, a short written change order is agreed before any extra work begins.",
  "Ending early. Either side may end the engagement with 14 days' written notice. Work completed to that date is invoiced.",
  "Licensed advice. Sypher Solutions is not a CPA or law firm. Where tax, legal or regulatory sign-off is needed, it comes from licensed professionals.",
].join("\n\n");

const MESA_CONTENT = {
  letter: "Dana,\n\nThank you for the time on Tuesday, and for being so direct about the books. Most owners take a year longer to say what you said in the first ten minutes: that you can't tell which jobs make money.\n\nBelow is how I'd fix that, in the order I'd do it. The first phase pays for itself if it finds what I expect it to find. If it doesn't, you'll know that too, and you can stop there.",
  situation_quote: "Our books haven't tied out since we switched systems last year, and I honestly can't tell which jobs make money anymore.",
  situation: "Mesa Line moved from desktop accounting to a cloud system fourteen months ago. Opening balances were carried over by hand, job costing was never set up the same way, and two bank accounts have unreconciled items going back to the conversion. Meanwhile the service side has grown faster than install, and pricing hasn't been revisited in two years.",
  objectives: [
    "Books that reconcile to the bank every month, starting from a clean conversion",
    "Job costing that shows margin by job type: install, service agreement and repair",
    "A list of money owed back to you, with a dollar figure on each item",
    "A pricing review for service calls based on the true cost per truck hour",
  ],
  phases: [
    { name: "Reconstruct", duration: "Weeks 1–3", detail: "Rebuild the conversion from bank and card statements, tie out every account and trace each exception to its source.", deliverables: ["Reconciled balance sheet", "Exceptions log with dollar amounts"] },
    { name: "Recover", duration: "Weeks 3–5", detail: "Chase what the reconstruction finds: duplicate vendor payments, unapplied customer credits, unbilled change orders.", deliverables: ["Recovery schedule", "Draft letters for your review"] },
    { name: "Rebuild costing", duration: "Weeks 5–8", detail: "Set up job costing and a chart of accounts your bookkeeper can keep, then a monthly margin report by job type.", deliverables: ["Chart of accounts", "Monthly margin report", "Bookkeeper SOP"] },
  ],
  options: [
    { id: "build", name: "Reconstruct and recover", model: "fixed", fee: "$9,500 fixed", fee_note: "Phases 1 and 2", timeline: "5 weeks", includes: ["Full reconciliation from the conversion date", "Exceptions log and recovery schedule", "A walkthrough with your CPA"], recommended: false },
    { id: "embed", name: "The full rebuild", model: "fixed", fee: "$16,500 fixed", fee_note: "All three phases", timeline: "8 weeks", includes: ["Everything in Reconstruct and recover", "Job costing and chart of accounts", "Monthly margin report and bookkeeper SOP", "Pricing review for service calls"], recommended: true },
    { id: "advise", name: "Rebuild, then monthly review", model: "retainer", fee: "$16,500, then $1,800 a month", fee_note: "Three-month minimum after the rebuild", timeline: "8 weeks, then monthly", includes: ["Everything in The full rebuild", "A monthly close review and margin call", "Quarterly pricing check"], recommended: false },
  ],
  timeline: [
    { when: "Week 1", milestone: "Kickoff and system access" },
    { when: "Week 3", milestone: "Reconciled balance sheet" },
    { when: "Week 5", milestone: "Recovery schedule delivered" },
    { when: "Week 8", milestone: "Margin report and handover" },
  ],
  terms: DEFAULT_TERMS,
  next_steps: "Choose an option above and sign below. I'll send a short engagement letter and a list of the system access I'll need, and we'll set the kickoff for the following week.",
};

export function demoSeed() {
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();
  const day = (offset) => new Date(now + offset * 864e5).toISOString().slice(0, 10);
  const questions = Q.map(([code, title, number, prompt, why, priority], i) => ({
    id: `demo-qq-${i + 1}`, questionnaire_id: Q_ID, position: i + 1, number,
    section_code: code, section_title: title, prompt, why, priority,
    answer_type: "long_text", required: false,
  }));
  const meeting = new Date(now + 5 * 864e5); meeting.setHours(10, 0, 0, 0);
  const inquiryAnswers = [
    { key: "recover_1", section: "Recover", question: "What doesn't tie out, and since when?", answer: "Our books haven't tied out since we switched systems last year, and I honestly can't tell which jobs make money anymore. Two bank accounts still have items from the conversion." },
    { key: "recover_2", section: "Recover", question: "Which system holds the books, and who keeps them?", answer: "QuickBooks Online since last summer. A part-time bookkeeper, 15 hours a week. Our CPA only sees it at year end." },
    { key: "grow_1", section: "Grow", question: "Where do your best customers come from today?", answer: "Referrals from two builders and our service agreements. Google brings calls but mostly one-off repairs." },
    { key: "tried", section: "The shape of it", question: "What have you already tried?", answer: "Had the CPA's office look at it for a week. They fixed the opening balances but not the job costing." },
    { key: "good", section: "The shape of it", question: "If this goes well, what's different in twelve months?", answer: "I know my margin by job type every month and I've raised service prices with confidence." },
    { key: "stage", section: "The shape of it", question: "Stage", answer: "Established small business" },
    { key: "team", section: "The shape of it", question: "Team size", answer: "11–50" },
    { key: "timeline", section: "The shape of it", question: "Timeline", answer: "Within 1–3 months" },
    { key: "budget", section: "The shape of it", question: "Budget set aside", answer: "$10,000–$25,000" },
  ];
  return {
    profiles: [
      { id: ADMIN_ID, email: "michael@sypher.solutions", full_name: "Michael Furth", company: "Sypher Solutions", role: "admin", created_at: iso(120) },
      { id: CLIENT_ID, email: "avery@junipervine.example", full_name: "Avery Morgan", company: "Juniper & Vine Provisions (sample)", role: "client", created_at: iso(40) },
    ],
    engagements: [{
      id: ENG_ID, client_id: CLIENT_ID, status: "active", created_at: iso(40),
      title: "Second-location feasibility study",
      summary: "Whether a second production kitchen pays for itself, what it takes to finance, and the conditions to meet before the lease is signed.",
      report_context: "Sample report context (demo). Base case assumes a $42 average case price, an 18-month ramp at the second kitchen, a $26 variable cost per case and a $480k raise. Verdict: feasible with conditions. Key sensitivities: case price, ingredient cost and the lease start date.",
      kickoff_date: day(-38),
      next_meeting_at: meeting.toISOString(),
      next_meeting_note: "Walk through your answers on customers and price, and agree the price assumption for the revised model.",
      meeting_link: "",
    }],
    milestones: [
      { id: "demo-ms-1", engagement_id: ENG_ID, position: 1, title: "Kickoff and interviews", due_label: "Week 1", status: "done", note: null, created_at: iso(38) },
      { id: "demo-ms-2", engagement_id: ENG_ID, position: 2, title: "Model and market review", due_label: "Week 3", status: "done", note: null, created_at: iso(38) },
      { id: "demo-ms-3", engagement_id: ENG_ID, position: 3, title: "Feasibility report delivered", due_label: "Week 5", status: "done", note: null, created_at: iso(38) },
      { id: "demo-ms-4", engagement_id: ENG_ID, position: 4, title: "Follow-up questions answered", due_label: "Week 7", status: "current", note: "Four questions marked high impact decide the revised model.", created_at: iso(38) },
      { id: "demo-ms-5", engagement_id: ENG_ID, position: 5, title: "Revised model and lease decision", due_label: "Week 9", status: "upcoming", note: null, created_at: iso(38) },
    ],
    decisions: [
      { id: "demo-dec-2", engagement_id: ENG_ID, decided_on: day(-9), decision: "Hold the lease signature until two wholesale accounts commit in writing.", rationale: "The base case depends on their volume; without it the second kitchen runs below break-even for over a year.", owner: "Avery Morgan", created_at: iso(9) },
      { id: "demo-dec-1", engagement_id: ENG_ID, decided_on: day(-24), decision: "Use the current co-packer for overflow during the ramp.", rationale: "Keeps early fixed cost down while volume is proven.", owner: "Avery Morgan", created_at: iso(24) },
    ],
    questionnaires: [{
      id: Q_ID, created_at: iso(14),
      title: "Follow-up questions for the owners",
      description: "Twelve questions that decide whether the model needs to be rerun.",
      intro: "These questions are ordered by how much each answer moves the model. Answer what you can; mark anything you don't know yet and add a note on when you'll have it.",
    }],
    questions,
    assignments: [{
      id: ASG_ID, engagement_id: ENG_ID, questionnaire_id: Q_ID, status: "open",
      due_date: new Date(now + 9 * 864e5).toISOString().slice(0, 10),
      message: "Thank you for your time on these. The four marked High impact matter most, so please start there. Michael",
      submitted_at: null, created_at: iso(14),
    }],
    answers: [
      { id: "demo-a-1", assignment_id: ASG_ID, question_id: "demo-qq-1", value: "Yes, monthly since January 2024 in the point-of-sale system, split by retail and wholesale. Export to follow.", state: "answered", note: null, updated_at: iso(3) },
      { id: "demo-a-2", assignment_id: ASG_ID, question_id: "demo-qq-2", value: "About $86,000 so far, mostly the build-out deposit and permits, all from the two owners.", state: "answered", note: null, updated_at: iso(3) },
      { id: "demo-a-5", assignment_id: ASG_ID, question_id: "demo-qq-5", value: "", state: "unknown", note: "Pulling invoices from our top ten accounts this week.", updated_at: iso(2) },
    ],
    files: [],
    report_drafts: [],
    publications: [{
      id: "demo-pub-1", engagement_id: ENG_ID, draft_id: null, published_at: iso(14),
      title: "Your feasibility report is ready",
      body: "The full report is attached to our engagement. The short version: a second kitchen works at the volumes your wholesale accounts suggest, provided two of them commit in writing before the lease is signed. The follow-up questions now in your portal will settle which path in the report is right for you.",
    }],
    activity: [
      { id: "demo-act-1", engagement_id: ENG_ID, actor: ADMIN_ID, kind: "assignment_created", detail: { assignment_id: ASG_ID }, created_at: iso(14) },
      { id: "demo-act-2", engagement_id: null, actor: null, kind: "inquiry_received", detail: { inquiry_id: INQ_ID }, created_at: iso(6) },
    ],
    inquiries: [{
      id: INQ_ID, created_at: iso(6), name: "Dana Whitfield", email: "dana@mesaline.example", company: "Mesa Line Mechanical (sample)", role: "Owner", phone: null,
      practices: ["Recover", "Grow"], answers: inquiryAnswers, status: "proposal",
      brief: null, brief_status: "pending", brief_model: null, brief_error: null, admin_notes: "Call went well. Wants to start before the busy season.",
    }],
    proposals: [
      {
        id: PROP_SENT, created_at: iso(3), updated_at: iso(2), token: "d3m0m3sa11ne7f8a9b0c1d2e3f4a5b6c7d8e9f0a1", slug: "mesa-line", status: "viewed",
        title: "Books you can trust, and margin by job", client_name: "Dana Whitfield", client_email: "dana@mesaline.example", company: "Mesa Line Mechanical (sample)",
        content: MESA_CONTENT, valid_until: day(21), inquiry_id: INQ_ID, engagement_id: null,
        sent_at: iso(2), first_viewed_at: iso(1), last_viewed_at: iso(1), view_count: 2,
        responded_at: null, accepted_option: null, signer_name: null, signer_title: null, signer_email: null, decline_reason: null,
      },
      {
        id: PROP_DONE, created_at: iso(46), updated_at: iso(41), token: "d3m0jun1p3rv1n3a1b2c3d4e5f6a7b8c9d0e1f2a3", slug: "juniper-vine", status: "accepted",
        title: "A second kitchen: feasibility and decision", client_name: "Avery Morgan", client_email: "avery@junipervine.example", company: "Juniper & Vine Provisions (sample)",
        content: {
          letter: "Avery,\n\nThank you for walking me through the first kitchen. The question you asked is the right one: not whether a second site could work, but what has to be true before you sign for it.",
          situation_quote: "We're turning away wholesale orders, but I don't want to sign a ten-year lease on a hunch.",
          situation: "The first kitchen runs near capacity for most of the year. Two wholesale accounts have asked for more volume, and a suitable site is available.",
          objectives: ["A verdict on the second kitchen, in plain words", "The conditions that must be met before the lease is signed", "A financing plan that covers the ramp"],
          phases: [
            { name: "Understand", duration: "Weeks 1–2", detail: "Interviews, two years of sales history and a site visit.", deliverables: ["Assumptions register"] },
            { name: "Model", duration: "Weeks 2–4", detail: "Monthly model with base and stress cases and sensitivity on price and ingredient cost.", deliverables: ["Financial model"] },
            { name: "Decide", duration: "Weeks 4–5", detail: "Report with the verdict, risks, capital plan and decision gates.", deliverables: ["Feasibility report", "Ranked open questions"] },
          ],
          options: [{ id: "build", name: "Feasibility study", model: "fixed", fee: "$12,000 fixed", fee_note: "", timeline: "5 weeks", includes: ["Model, report and decision gates", "Follow-up questions through the portal"], recommended: true }],
          timeline: [{ when: "Week 1", milestone: "Kickoff" }, { when: "Week 5", milestone: "Report delivered" }],
          terms: DEFAULT_TERMS,
          next_steps: "Sign below and I'll send the engagement letter.",
        },
        valid_until: day(-20), inquiry_id: null, engagement_id: ENG_ID,
        sent_at: iso(45), first_viewed_at: iso(44), last_viewed_at: iso(42), view_count: 4,
        responded_at: iso(41), accepted_option: "build", signer_name: "Avery Morgan", signer_title: "Co-owner", signer_email: "avery@junipervine.example", decline_reason: null,
      },
    ],
  };
}

/** A canned pre-call brief for demo mode, built from the visitor's answers. */
export function demoBrief(inquiry) {
  const longest = [...inquiry.answers].sort((a, b) => b.answer.length - a.answer.length)[0];
  const quote = (longest?.answer || "").split(/(?<=[.!?])\s/)[0];
  const practices = inquiry.practices.filter((p) => p !== "Not sure");
  return {
    summary: `Demo brief. ${inquiry.name}${inquiry.company ? ` of ${inquiry.company}` : ""} completed the diagnostic with ${inquiry.answers.length} answers. In production, Claude reads every answer and writes this summary for you before the call: who they are, what is wrong and what they want.`,
    in_their_words: quote,
    likely_practices: (practices.length ? practices : ["Run"]).slice(0, 3).map((p) => ({ practice: p, why: "Chosen by the prospect (sample reasoning)." })),
    questions_for_the_call: [
      "Who else signs off on a decision like this, and what would they need to see?",
      "What has it cost you so far, in money or time, to leave this as it is?",
      "What did the last attempt to fix it get right, and where did it stop?",
      "Is there a date that makes this urgent: a season, a lease, a filing, a board meeting?",
    ],
    fit_concerns: [],
    suggested_first_step: "A short paid diagnostic of the one area they named first, with a written finding in two weeks.",
    proposal_outline: {
      title: `${inquiry.company || inquiry.name}: a first engagement`,
      objectives: ["A clear picture of where things stand", "A short list of fixes, in priority order", "The first of those fixes, done"],
      phases: [
        { name: "Understand", duration: "Weeks 1–2", detail: "Interviews, documents and a working session." },
        { name: "Decide", duration: "Week 3", detail: "Findings and a written plan." },
        { name: "Deliver", duration: "Weeks 4–8", detail: "Carry out the first priorities." },
      ],
      engagement_model: "fixed",
    },
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

export const DEMO_IDS = { CLIENT_ID, ADMIN_ID, INQ_ID };
