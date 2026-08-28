import { describe, expect, test } from "bun:test";
import { ageDays, byPriorityThenAge, fromPr, isBlocked, priorityFor } from "./dashboard";
import type { DashboardPr } from "./tauri";

function pull(overrides: Partial<DashboardPr> = {}): DashboardPr {
  return {
    id: 1,
    number: 42,
    title: "Tighten review flow",
    url: "https://github.com/acme/api/pull/42",
    repo: "acme/api",
    author: "dev",
    avatar: "https://example.com/dev.png",
    isDraft: false,
    reviewDecision: null,
    ci: "success",
    conflicting: false,
    createdAt: "2026-08-20T12:00:00Z",
    updatedAt: "2026-08-27T12:00:00Z",
    issueCommentCount: 0,
    reviewThreadCount: 0,
    unresolvedThreadCount: 0,
    headSha: "head-1",
    baseSha: "base-1",
    hasPendingReview: false,
    ...overrides,
  };
}

describe("dashboard presentation model", () => {
  test("derives repository parts, waiting age, blocked state, and priority", () => {
    const now = Date.parse("2026-08-28T12:00:00Z");
    const item = fromPr(pull({ ci: "failure" }), now);

    expect(item).toMatchObject({
      owner: "acme",
      repoName: "api",
      waitingDays: 1,
      blocked: true,
      priority: "high",
    });
    expect(ageDays("2026-08-27T12:00:00Z", now)).toBe(1);
    expect(isBlocked(pull({ unresolvedThreadCount: 1 }))).toBe(true);
    expect(priorityFor(pull(), 8, false)).toBe("critical");
  });

  test("sorts higher-priority work first and older work within a priority", () => {
    const now = Date.parse("2026-08-28T12:00:00Z");
    const normal = fromPr(pull({ id: 1, updatedAt: "2026-08-27T12:00:00Z" }), now);
    const blockedNew = fromPr(
      pull({ id: 2, ci: "failure", updatedAt: "2026-08-28T10:00:00Z" }),
      now,
    );
    const blockedOld = fromPr(
      pull({ id: 3, ci: "failure", updatedAt: "2026-08-26T10:00:00Z" }),
      now,
    );

    expect([normal, blockedNew, blockedOld].sort(byPriorityThenAge).map((item) => item.id)).toEqual(
      [3, 2, 1],
    );
  });
});
