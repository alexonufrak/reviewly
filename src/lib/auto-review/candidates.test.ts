import { describe, expect, test } from "bun:test";
import type { DashboardPr } from "@/lib/tauri";
import { gateCandidate, toReviewCandidate } from "./candidates";

function pull(overrides: Partial<DashboardPr> = {}): DashboardPr {
  return {
    id: 99,
    number: 12,
    title: "Protect queue claims",
    url: "https://github.com/acme/api/pull/12",
    repo: "acme/api",
    author: "sam",
    avatar: "https://example.com/sam.png",
    isDraft: false,
    reviewDecision: null,
    ci: "pending",
    conflicting: false,
    createdAt: "2026-08-20T12:00:00Z",
    updatedAt: "2026-08-28T12:00:00Z",
    issueCommentCount: 2,
    reviewThreadCount: 1,
    unresolvedThreadCount: 1,
    headSha: "head-12",
    baseSha: "base-12",
    hasPendingReview: false,
    ...overrides,
  };
}

describe("automatic review candidates", () => {
  test("preserves every identity field from the shared dashboard projection", () => {
    expect(toReviewCandidate(pull({ hasPendingReview: true }))).toEqual({
      id: 99,
      repo: "acme/api",
      number: 12,
      title: "Protect queue claims",
      url: "https://github.com/acme/api/pull/12",
      authorLogin: "sam",
      authorAvatar: "https://example.com/sam.png",
      baseSha: "base-12",
      headSha: "head-12",
      hasPendingReview: true,
      isDraft: false,
    });
  });

  test("returns existing draft before loading any diff", async () => {
    let calls = 0;
    const result = await gateCandidate(pull({ hasPendingReview: true }), true, async () => {
      calls += 1;
      return ["should not load"];
    });

    expect(result).toEqual({ kind: "existing_draft" });
    expect(calls).toBe(0);
  });

  test("rejects missing SHAs before loading any diff", async () => {
    let calls = 0;
    const result = await gateCandidate(pull({ headSha: "" }), true, async () => {
      calls += 1;
      return [];
    });

    expect(result).toEqual({ kind: "invalid", reason: "missing head or base SHA" });
    expect(calls).toBe(0);
  });
});
