import { describe, expect, test } from "bun:test";
import type { PullFile } from "@/lib/tauri";
import type { RawAutoReviewFinding, RawAutoReviewResult } from "./result";
import { validateAutoReviewResult } from "./validate";

const files: PullFile[] = [
  {
    sha: "file-sha",
    filename: "src/queue.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: [
      "@@ -10,4 +10,5 @@",
      " context ten",
      "-removed eleven",
      "+added eleven",
      " context twelve",
      "+added thirteen",
      " context fourteen",
    ].join("\n"),
    previous_filename: null,
  },
];

function finding(overrides: Partial<RawAutoReviewFinding> = {}): RawAutoReviewFinding {
  return {
    category: "correctness",
    confidence: "medium",
    path: "src/queue.ts",
    line: 11,
    endLine: 11,
    side: "RIGHT",
    comment: "Could both workers claim this row before either update becomes visible?",
    evidence: "The claim is read before the status update.",
    ...overrides,
  };
}

function result(findings: RawAutoReviewFinding[]): RawAutoReviewResult {
  return {
    conclusion: findings.length ? "findings" : "no_concerns",
    overallComment: null,
    findings,
  };
}

function validate(
  value: RawAutoReviewResult,
  overrides: { currentHeadSha?: string; contextMode?: "worktree" | "diff_only" } = {},
) {
  return validateAutoReviewResult({
    value,
    files,
    repo: "acme/api",
    number: 12,
    baseSha: "base-12",
    headSha: "head-12",
    currentHeadSha: overrides.currentHeadSha ?? "head-12",
    contextMode: overrides.contextMode ?? "diff_only",
  });
}

describe("automatic review exact-line validation", () => {
  test("keeps right-side additions and context plus left-side deletions", () => {
    const outcome = validate(
      result([
        finding({ confidence: "low", line: 10, endLine: 10, side: "RIGHT" }),
        finding({ confidence: "high", line: 11, side: "LEFT" }),
        finding({ confidence: "medium", line: 13, endLine: 13, side: "RIGHT" }),
      ]),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.discardedCount).toBe(0);
    expect(outcome.value.findings.map((item) => [item.confidence, item.side, item.line])).toEqual([
      ["high", "LEFT", 11],
      ["medium", "RIGHT", 13],
      ["low", "RIGHT", 10],
    ]);
    expect(outcome.value.findings[0].githubUrl).toContain("/blob/base-12/src/queue.ts#L11");
    expect(outcome.value.findings[1].githubUrl).toContain("/blob/head-12/src/queue.ts#L13");
  });

  test("discards missing files, non-commentable lines, reversed ranges, and wide ranges", () => {
    const outcome = validate(
      result([
        finding({ path: "src/missing.ts" }),
        finding({ line: 99 }),
        finding({ line: 13, endLine: 12 }),
        finding({ line: 1, endLine: 11 }),
      ]),
    );

    expect(outcome).toMatchObject({
      ok: true,
      discardedCount: 4,
      value: { conclusion: "no_concerns", findings: [] },
    });
  });

  test("rejects the whole result when the reviewed head is stale", () => {
    expect(validate(result([finding()]), { currentHeadSha: "head-13" })).toEqual({
      ok: false,
      code: "stale_head",
      message: "The pull request head changed during review.",
    });
  });

  test("discards invalid content, forbidden markup, em dashes, and diff-only overclaims", () => {
    const outcome = validate(
      result([
        finding({ comment: "" }),
        finding({ comment: "x".repeat(801) }),
        finding({ evidence: "x".repeat(501) }),
        finding({ comment: "Could `claimNext` race here?" }),
        finding({ comment: "This can race — should this update be atomic?" }),
        finding({ comment: "I checked every call site in the repository and none await this." }),
        finding({ comment: "Could this race?\n```ts\nclaim()\n```" }),
      ]),
    );

    expect(outcome).toMatchObject({ ok: true, discardedCount: 7, value: { findings: [] } });
  });

  test("allows a repository-inspection claim only in worktree mode", () => {
    const value = result([
      finding({ comment: "I checked every call site in the repository and none await this." }),
    ]);

    expect(validate(value, { contextMode: "diff_only" })).toMatchObject({ discardedCount: 1 });
    expect(validate(value, { contextMode: "worktree" })).toMatchObject({ discardedCount: 0 });
  });
});
