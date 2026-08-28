import { describe, expect, test } from "bun:test";
import type { PullFile } from "@/lib/tauri";
import { AUTO_REVIEW_FIXED_RULES, buildAutoReviewPrompt } from "./prompt";

const files: PullFile[] = [
  {
    sha: "file-sha",
    filename: "src/queue.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -10,2 +10,2 @@\n-old value\n+new value\n context",
    previous_filename: null,
  },
];

describe("automatic review prompt", () => {
  test("keeps user guidance, learned tone, fixed rules, limits, context, and schema in order", () => {
    const prompt = buildAutoReviewPrompt({
      aiInstructions: "Ask before assuming intent.",
      generatedToneProfile: "Short questions, ordinary punctuation.",
      recentExamples: ["Could this race with the retry path?"],
      contextMode: "diff_only",
      candidate: {
        id: 10,
        repo: "acme/api",
        number: 12,
        title: "Protect queue claims",
        url: "https://github.com/acme/api/pull/12",
        authorLogin: "sam",
        authorAvatar: "https://example.com/sam.png",
        baseSha: "base-12",
        headSha: "head-12",
        hasPendingReview: false,
      },
      files,
    });
    const sections = [
      "# Reviewer instructions",
      "# Learned review tone",
      "# Fixed review rules",
      "# Context limits",
      "# Pull request",
      "# Output contract",
    ];

    expect(sections.every((section) => prompt.indexOf(section) >= 0)).toBe(true);
    for (let index = 1; index < sections.length; index += 1) {
      expect(prompt.indexOf(sections[index - 1])).toBeLessThan(prompt.indexOf(sections[index]));
    }
    expect(prompt).toContain("Ask before assuming intent.");
    expect(prompt).toContain("Could this race with the retry path?");
    expect(prompt).toContain("head-12");
    expect(prompt).toContain(JSON.stringify(files[0].patch));
    expect(prompt).toMatchSnapshot();
  });

  test("fixed rules reject praise inventories and implementation restatements", () => {
    expect(AUTO_REVIEW_FIXED_RULES).toContain("Do not inventory praise");
    expect(AUTO_REVIEW_FIXED_RULES).toContain("Do not restate the implementation");
    expect(AUTO_REVIEW_FIXED_RULES).toContain("Do not use em dashes");
    expect(AUTO_REVIEW_FIXED_RULES).toContain("Do not use inline code markup");
  });
});
