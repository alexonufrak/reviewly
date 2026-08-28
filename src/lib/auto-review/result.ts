import { stripFence, toInt, tryJson } from "@/lib/ai/json";
import type {
  AutoReviewCategory,
  AutoReviewConclusion,
  AutoReviewConfidence,
  AutoReviewSide,
} from "@/lib/auto-review/types";

const CATEGORIES = new Set<AutoReviewCategory>([
  "correctness",
  "security",
  "data",
  "concurrency",
  "performance",
  "maintainability",
  "test_coverage",
  "question",
]);
const CONFIDENCES = new Set<AutoReviewConfidence>(["high", "medium", "low"]);
const SIDES = new Set<AutoReviewSide>(["LEFT", "RIGHT"]);
const CONCLUSIONS = new Set<AutoReviewConclusion>(["findings", "no_concerns"]);

const ROOT_KEYS = ["conclusion", "findings", "overallComment"];
const FINDING_KEYS = [
  "category",
  "comment",
  "confidence",
  "endLine",
  "evidence",
  "line",
  "path",
  "side",
];

export const AUTO_REVIEW_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["conclusion", "overallComment", "findings"],
  properties: {
    conclusion: { enum: ["findings", "no_concerns"] },
    overallComment: { type: ["string", "null"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: FINDING_KEYS,
        properties: {
          category: { enum: [...CATEGORIES] },
          confidence: { enum: [...CONFIDENCES] },
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          side: { enum: [...SIDES] },
          comment: { type: "string" },
          evidence: { type: ["string", "null"] },
        },
      },
    },
  },
});

export interface RawAutoReviewFinding {
  category: AutoReviewCategory;
  confidence: AutoReviewConfidence;
  path: string;
  line: number;
  endLine: number;
  side: AutoReviewSide;
  comment: string;
  evidence: string | null;
}

export interface RawAutoReviewResult {
  conclusion: AutoReviewConclusion;
  overallComment: string | null;
  findings: RawAutoReviewFinding[];
}

export type ParseResult =
  | { ok: true; value: RawAutoReviewResult }
  | { ok: false; code: "malformed_json" | "schema_mismatch"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function parseFinding(value: unknown): RawAutoReviewFinding | null {
  if (!isRecord(value) || !hasExactKeys(value, FINDING_KEYS)) return null;
  const category = stringValue(value.category);
  const confidence = stringValue(value.confidence);
  const path = stringValue(value.path);
  const line = toInt(value.line);
  const endLine = toInt(value.endLine);
  const side = stringValue(value.side);
  const comment = stringValue(value.comment);
  const evidence = value.evidence === null ? null : stringValue(value.evidence);
  if (
    !category ||
    !CATEGORIES.has(category as AutoReviewCategory) ||
    !confidence ||
    !CONFIDENCES.has(confidence as AutoReviewConfidence) ||
    !path ||
    line === null ||
    endLine === null ||
    !side ||
    !SIDES.has(side as AutoReviewSide) ||
    comment === null ||
    (value.evidence !== null && evidence === null)
  ) {
    return null;
  }
  return {
    category: category as AutoReviewCategory,
    confidence: confidence as AutoReviewConfidence,
    path,
    line,
    endLine,
    side: side as AutoReviewSide,
    comment,
    evidence,
  };
}

export function parseAutoReviewResult(content: string): ParseResult {
  const trimmed = content.trim();
  const startsFence = /^```[a-z]*\s*(?:\n|\r\n?)/i.test(trimmed);
  const endsFence = /(?:\n|\r\n?)```\s*$/.test(trimmed);
  if (startsFence !== endsFence) {
    return { ok: false, code: "malformed_json", message: "The JSON fence is incomplete." };
  }
  const parsed = tryJson(startsFence ? stripFence(trimmed) : trimmed);
  if (parsed === undefined) {
    return {
      ok: false,
      code: "malformed_json",
      message: "The model output is not one JSON object.",
    };
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ROOT_KEYS)) {
    return {
      ok: false,
      code: "schema_mismatch",
      message: "The result does not match the review schema.",
    };
  }
  const conclusion = stringValue(parsed.conclusion);
  const overallComment = parsed.overallComment === null ? null : stringValue(parsed.overallComment);
  if (
    !conclusion ||
    !CONCLUSIONS.has(conclusion as AutoReviewConclusion) ||
    (parsed.overallComment !== null && overallComment === null) ||
    !Array.isArray(parsed.findings)
  ) {
    return {
      ok: false,
      code: "schema_mismatch",
      message: "The result does not match the review schema.",
    };
  }
  const findings = parsed.findings.map(parseFinding);
  if (findings.some((finding) => finding === null)) {
    return {
      ok: false,
      code: "schema_mismatch",
      message: "At least one finding is incomplete or invalid.",
    };
  }
  return {
    ok: true,
    value: {
      conclusion: conclusion as AutoReviewConclusion,
      overallComment,
      findings: findings as RawAutoReviewFinding[],
    },
  };
}

export function buildRepairPrompt(originalOutput: string): string {
  return `The previous response did not match the required schema. Return only the corrected JSON object. Do not add prose or a Markdown fence. Preserve only complete findings and do not invent missing values.\n\nRequired schema:\n${AUTO_REVIEW_OUTPUT_SCHEMA}\n\nPrevious response:\n${originalOutput}`;
}
