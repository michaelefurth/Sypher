// The structured report-update draft Claude returns for Michael's review.
// Used both as the JSON Schema sent to the API (output_config.format) and as
// the TypeScript shape the portal reads back.

export interface ReportDraft {
  summary: string;
  client_summary: string;
  data_points: {
    question_number: string;
    label: string;
    value: string;
    unit: string;
    confidence: "stated" | "estimated" | "unclear";
    source_quote: string;
  }[];
  section_updates: {
    section: string;
    change_type: "revise" | "confirm" | "contradiction" | "new_risk";
    rationale: string;
    proposed_text: string;
    question_numbers: string[];
  }[];
  model_rerun: {
    required: boolean;
    reasons: string[];
    input_changes: { input: string; previous_value: string; new_value: string; question_number: string }[];
  };
  flags: { severity: "high" | "medium" | "low"; issue: string; question_numbers: string[] }[];
  follow_up_questions: { question: string; reason: string; related_question_number: string }[];
  open_questions: string[];
}

const str = { type: "string" } as const;
const strArr = { type: "array", items: { type: "string" } } as const;

function obj(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const REPORT_DRAFT_SCHEMA = obj({
  summary: { type: "string", description: "Three to five sentences for Michael: what the answers change, overall." },
  client_summary: {
    type: "string",
    description: "A short, plain-language update addressed to the client. Michael edits it before anything is sent.",
  },
  data_points: {
    type: "array",
    items: obj({
      question_number: str,
      label: { type: "string", description: "What the figure is, e.g. 'Delivered cement price'." },
      value: { type: "string", description: "The value exactly as the client gave it, or empty if not given." },
      unit: str,
      confidence: { type: "string", enum: ["stated", "estimated", "unclear"] },
      source_quote: { type: "string", description: "Short verbatim quote from the client's answer." },
    }),
  },
  section_updates: {
    type: "array",
    items: obj({
      section: { type: "string", description: "Report section or chapter the change affects." },
      change_type: { type: "string", enum: ["revise", "confirm", "contradiction", "new_risk"] },
      rationale: str,
      proposed_text: { type: "string", description: "Suggested replacement or added wording, in the report's voice." },
      question_numbers: strArr,
    }),
  },
  model_rerun: obj({
    required: { type: "boolean" },
    reasons: strArr,
    input_changes: {
      type: "array",
      items: obj({ input: str, previous_value: str, new_value: str, question_number: str }),
    },
  }),
  flags: {
    type: "array",
    items: obj({
      severity: { type: "string", enum: ["high", "medium", "low"] },
      issue: str,
      question_numbers: strArr,
    }),
  },
  follow_up_questions: {
    type: "array",
    items: obj({ question: str, reason: str, related_question_number: str }),
  },
  open_questions: { type: "array", items: { type: "string" }, description: "Numbers of questions still unanswered or marked unknown." },
});

/** Light runtime check so a malformed response is caught before it reaches the admin UI. */
export function isReportDraft(value: unknown): value is ReportDraft {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === "string" &&
    typeof v.client_summary === "string" &&
    Array.isArray(v.data_points) &&
    Array.isArray(v.section_updates) &&
    typeof v.model_rerun === "object" && v.model_rerun !== null &&
    Array.isArray(v.flags) &&
    Array.isArray(v.follow_up_questions) &&
    Array.isArray(v.open_questions)
  );
}
