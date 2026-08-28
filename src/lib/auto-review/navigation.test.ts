import { describe, expect, test } from "bun:test";
import { reviewStateLabels } from "@/components/auto-review/review-state";
import { findingSearch, resolvePrFocus, validatePrFocusSearch } from "@/lib/auto-review/navigation";
import type { AutoReviewFinding } from "@/lib/auto-review/types";

function finding(side: "LEFT" | "RIGHT" = "RIGHT"): AutoReviewFinding {
  return {
    id: "finding-1",
    runId: "run-1",
    ordinal: 0,
    category: "correctness",
    confidence: "high",
    path: "src/queue.ts",
    line: 17,
    endLine: 17,
    side,
    comment: "Could this claim the same row twice?",
    evidence: "The read and write are separate operations.",
    githubUrl: "https://github.com/acme/widgets/blob/head/src/queue.ts#L17",
  };
}

describe("automated review exact-line navigation", () => {
  test("builds the pull-request search anchor from a finding", () => {
    expect(findingSearch(finding("LEFT"))).toEqual({
      file: "src/queue.ts",
      line: 17,
      side: "LEFT",
    });
  });

  test("rejects incomplete and invalid search anchors", () => {
    expect(validatePrFocusSearch({ file: "", line: 17, side: "RIGHT" })).toEqual({});
    expect(validatePrFocusSearch({ file: "src/queue.ts", line: 0, side: "RIGHT" })).toEqual({});
    expect(validatePrFocusSearch({ file: "src/queue.ts", line: 17, side: "MIDDLE" })).toEqual({});
    expect(validatePrFocusSearch({ file: "src/queue.ts", line: "17", side: "RIGHT" })).toEqual({
      file: "src/queue.ts",
      line: 17,
      side: "RIGHT",
    });
  });

  test("forces the files tab and unified diff for either rendered side", () => {
    const files = ["src/queue.ts", "src/worker.ts"];

    expect(resolvePrFocus(findingSearch(finding("LEFT")), files)).toEqual({
      tab: "files",
      activeFile: "src/queue.ts",
      view: "unified",
      focusLine: 17,
      focusSide: "LEFT",
    });
    expect(resolvePrFocus(findingSearch(finding("RIGHT")), files)?.focusSide).toBe("RIGHT");
    expect(resolvePrFocus({ file: "missing.ts", line: 17, side: "RIGHT" }, files)).toBeNull();
  });
});

describe("automated review queue labels", () => {
  test("labels durable states and context limits without ambiguity", () => {
    expect(reviewStateLabels({ status: "queued" })).toEqual(["Queued"]);
    expect(reviewStateLabels({ status: "running" })).toEqual(["Reviewing"]);
    expect(reviewStateLabels({ status: "completed" })).toEqual(["Ready"]);
    expect(reviewStateLabels({ status: "failed" })).toEqual(["Needs attention"]);
    expect(reviewStateLabels({ status: "superseded" })).toEqual(["Superseded"]);
    expect(reviewStateLabels({ contextMode: "diff_only" })).toEqual(["Limited context"]);
    expect(reviewStateLabels({ hasPendingReview: true })).toEqual(["Existing draft"]);
  });
});
