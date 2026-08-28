import type { RawAutoReviewFinding, RawAutoReviewResult } from "@/lib/auto-review/result";
import type { AutoReviewConclusion, AutoReviewContextMode } from "@/lib/auto-review/types";
import { parsePatch } from "@/lib/diff";
import type { PullFile } from "@/lib/tauri";

export interface ValidatedAutoReviewFinding extends RawAutoReviewFinding {
  ordinal: number;
  githubUrl: string;
}

export interface ValidatedAutoReviewResult {
  conclusion: AutoReviewConclusion;
  overallComment: string | null;
  findings: ValidatedAutoReviewFinding[];
}

export type ValidationResult =
  | { ok: true; value: ValidatedAutoReviewResult; discardedCount: number }
  | { ok: false; code: "stale_head"; message: string };

interface ValidationInput {
  value: RawAutoReviewResult;
  files: PullFile[];
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
  currentHeadSha: string;
  contextMode: AutoReviewContextMode;
}

const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 } as const;
const DIFF_ONLY_OVERCLAIMS = [
  /\b(?:checked|inspected|searched|reviewed|verified|confirmed|traced)\b[^.\n]{0,100}\b(?:callers?|call sites?|runtime (?:configuration|config)|generated (?:source|code|files?)|(?:entire|whole) (?:repository|repo|codebase))\b/i,
  /\b(?:all|every|no)\s+(?:callers?|call sites?)\b/i,
  /\b(?:across|throughout)\s+the\s+(?:repository|repo|codebase)\b/i,
];

function forbiddenComment(comment: string, contextMode: AutoReviewContextMode): boolean {
  return (
    !comment ||
    comment.length > 800 ||
    comment.includes("—") ||
    comment.includes("```") ||
    comment.includes("`") ||
    (contextMode === "diff_only" && DIFF_ONLY_OVERCLAIMS.some((pattern) => pattern.test(comment)))
  );
}

function stableLineUrl(
  repo: string,
  sha: string,
  path: string,
  line: number,
  endLine: number,
): string {
  const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const anchor = endLine > line ? `#L${line}-L${endLine}` : `#L${line}`;
  return `https://github.com/${encodedRepo}/blob/${encodeURIComponent(sha)}/${encodedPath}${anchor}`;
}

function validOverallComment(
  comment: string | null,
  conclusion: AutoReviewConclusion,
  contextMode: AutoReviewContextMode,
): string | null {
  if (comment === null) return null;
  const trimmed = comment.trim();
  if (forbiddenComment(trimmed, contextMode)) return null;
  if (conclusion === "no_concerns" && trimmed.length > 80) return null;
  return trimmed;
}

export function validateAutoReviewResult(input: ValidationInput): ValidationResult {
  if (input.currentHeadSha !== input.headSha) {
    return {
      ok: false,
      code: "stale_head",
      message: "The pull request head changed during review.",
    };
  }

  const indexed = new Map(
    input.files.map((file) => {
      const right = new Set<number>();
      const left = new Set<number>();
      for (const hunk of parsePatch(file.patch)) {
        for (const line of hunk.lines) {
          if ((line.kind === "add" || line.kind === "context") && line.newLine !== null) {
            right.add(line.newLine);
          }
          if (line.kind === "del" && line.oldLine !== null) left.add(line.oldLine);
        }
      }
      return [file.filename, { file, right, left }] as const;
    }),
  );

  const valid: ValidatedAutoReviewFinding[] = [];
  input.value.findings.forEach((finding, ordinal) => {
    const entry = indexed.get(finding.path);
    const comment = finding.comment.trim();
    const evidence = finding.evidence?.trim() || null;
    const rangeLength = finding.endLine - finding.line + 1;
    if (
      !entry ||
      finding.line <= 0 ||
      finding.endLine <= 0 ||
      rangeLength <= 0 ||
      rangeLength > 10 ||
      forbiddenComment(comment, input.contextMode) ||
      (evidence !== null && evidence.length > 500)
    ) {
      return;
    }
    const lines = finding.side === "RIGHT" ? entry.right : entry.left;
    for (let line = finding.line; line <= finding.endLine; line += 1) {
      if (!lines.has(line)) return;
    }
    const sha = finding.side === "RIGHT" ? input.headSha : input.baseSha;
    const linkPath =
      finding.side === "LEFT" && entry.file.previous_filename
        ? entry.file.previous_filename
        : entry.file.filename;
    valid.push({
      ...finding,
      comment,
      evidence,
      ordinal,
      githubUrl: stableLineUrl(input.repo, sha, linkPath, finding.line, finding.endLine),
    });
  });

  valid.sort(
    (left, right) =>
      CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence] ||
      left.ordinal - right.ordinal,
  );
  const conclusion: AutoReviewConclusion = valid.length > 0 ? "findings" : "no_concerns";
  return {
    ok: true,
    discardedCount: input.value.findings.length - valid.length,
    value: {
      conclusion,
      overallComment: validOverallComment(
        input.value.overallComment,
        conclusion,
        input.contextMode,
      ),
      findings: valid,
    },
  };
}
