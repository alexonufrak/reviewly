import { describe, expect, test } from "bun:test";
import {
  AUTO_REVIEW_DEFAULTS,
  type CodexReasoningEffort,
  collectAutoReviewRepos,
  resolveAutomatedCodexConfig,
} from "./config";

describe("automated Codex configuration", () => {
  test("uses Codex settings even when manual review uses another provider", () => {
    expect(
      resolveAutomatedCodexConfig({
        model: "gpt-review",
        reasoning: "medium",
        timeoutSecs: 420,
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-review",
      reasoningEffort: "medium",
      timeoutSecs: 420,
    });
  });

  test("repository model and reasoning override app defaults", () => {
    expect(
      resolveAutomatedCodexConfig(
        { model: "app-model", reasoning: "low", timeoutSecs: null },
        { model: "repo-model", reasoning: "high" },
      ),
    ).toEqual({
      provider: "codex",
      model: "repo-model",
      reasoningEffort: "high",
    });
  });

  test("empty repository overrides inherit app defaults", () => {
    expect(
      resolveAutomatedCodexConfig(
        { model: "app-model", reasoning: "xhigh", timeoutSecs: null },
        { model: "  ", reasoning: "" },
      ),
    ).toEqual({
      provider: "codex",
      model: "app-model",
      reasoningEffort: "xhigh",
    });
  });

  test("omits blank model, default reasoning, and automatic timeout", () => {
    expect(resolveAutomatedCodexConfig({ model: "", reasoning: "", timeoutSecs: null })).toEqual({
      provider: "codex",
    });
  });

  test("preserves every supported Codex reasoning value", () => {
    const efforts: CodexReasoningEffort[] = ["", "minimal", "low", "medium", "high", "xhigh"];

    expect(efforts.map((reasoning) => resolveAutomatedCodexConfig({ reasoning }))).toEqual([
      { provider: "codex" },
      { provider: "codex", reasoningEffort: "minimal" },
      { provider: "codex", reasoningEffort: "low" },
      { provider: "codex", reasoningEffort: "medium" },
      { provider: "codex", reasoningEffort: "high" },
      { provider: "codex", reasoningEffort: "xhigh" },
    ]);
  });
});

describe("automatic review settings ownership", () => {
  test("owns only artifact and tone preferences", () => {
    expect(Object.keys(AUTO_REVIEW_DEFAULTS).sort()).toEqual([
      "artifactDirectoryName",
      "toneLookbackDays",
      "toneRefreshHours",
      "toneSampleLimit",
    ]);
  });
});

describe("automatic review repository discovery", () => {
  test("unions watched, local, and incoming repositories with local context status", () => {
    expect(
      collectAutoReviewRepos({
        watched: ["acme/api", "acme/web"],
        incoming: ["acme/mobile", "acme/api"],
        local: [
          {
            owner: "acme",
            repo: "api",
            path: "/repos/api",
            remoteUrl: "git@github.com:acme/api.git",
          },
          {
            owner: "acme",
            repo: "web",
            path: "/repos/web",
            remoteUrl: "https://github.com/other/web.git",
          },
        ],
      }),
    ).toEqual([
      { repo: "acme/api", context: "full", localPath: "/repos/api" },
      { repo: "acme/mobile", context: "limited", localPath: null },
      { repo: "acme/web", context: "invalid", localPath: "/repos/web" },
    ]);
  });
});
