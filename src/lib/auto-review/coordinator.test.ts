import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { autoReviewKey } from "@/lib/ai/tasks";
import {
  type AutoReviewServices,
  type StartAutoReviewInput,
  createAutoReviewCoordinator,
} from "@/lib/auto-review/coordinator";
import type { AutoReviewDb } from "@/lib/auto-review/db";
import type {
  AutoReviewFinding,
  AutoReviewRepoSetting,
  AutoReviewRun,
  AutoReviewTrigger,
  ReviewCandidate,
} from "@/lib/auto-review/types";
import type { PullFile } from "@/lib/tauri";

const NOW = Date.parse("2026-08-28T14:00:00Z");

function candidate(number = 42, headSha = `head-${number}`): ReviewCandidate {
  return {
    id: number,
    repo: "acme/widgets",
    number,
    title: `Protect widget ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    authorLogin: "sam",
    authorAvatar: "https://example.com/sam.png",
    baseSha: `base-${number}`,
    headSha,
    hasPendingReview: false,
  };
}

function pullFile(): PullFile {
  return {
    sha: "file-sha",
    filename: "src/widget.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -11,2 +11,2 @@\n-old value\n+new value\n context",
    previous_filename: null,
  };
}

function queuedRun(
  candidate: ReviewCandidate,
  id: string,
  trigger: AutoReviewTrigger,
): AutoReviewRun {
  return {
    id,
    repo: candidate.repo,
    prId: candidate.id,
    prNumber: candidate.number,
    prTitle: candidate.title,
    prUrl: candidate.url,
    authorLogin: candidate.authorLogin,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    status: "queued",
    trigger,
    contextMode: null,
    provider: "codex",
    model: null,
    reasoning: null,
    conclusion: null,
    overallComment: null,
    toneSampleHash: null,
    queuedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    repairCount: 0,
    recoveryCount: 0,
    supersededByHeadSha: null,
    jsonArtifactPath: null,
    markdownArtifactPath: null,
    exportError: null,
    notificationKind: null,
    notificationDueAt: null,
    notifiedAt: null,
  };
}

class MemoryAutoReviewDb implements AutoReviewDb {
  readonly runs: AutoReviewRun[] = [];
  readonly findings = new Map<string, AutoReviewFinding[]>();
  settings: AutoReviewRepoSetting[] = [
    {
      repo: "acme/widgets",
      enabled: true,
      modelOverride: "gpt-review",
      reasoningOverride: "high",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  private sequence = 0;

  async listRepoSettings() {
    return this.settings.map((setting) => ({ ...setting }));
  }

  async setRepoSetting(
    setting: Pick<
      AutoReviewRepoSetting,
      "repo" | "enabled" | "modelOverride" | "reasoningOverride"
    >,
  ) {
    const existing = this.settings.find((item) => item.repo === setting.repo);
    if (existing) Object.assign(existing, setting, { updatedAt: Date.now() });
  }

  async enqueueCandidate(value: ReviewCandidate, trigger: AutoReviewTrigger) {
    if (
      this.runs.some(
        (run) =>
          run.repo === value.repo && run.prNumber === value.number && run.headSha === value.headSha,
      )
    ) {
      return null;
    }
    const run = queuedRun(value, `run-${++this.sequence}`, trigger);
    this.runs.push(run);
    return { ...run };
  }

  async listRuns() {
    return this.runs.map((run) => ({ ...run }));
  }

  async claimNextQueuedRun() {
    if (this.runs.some((run) => run.status === "running")) return null;
    const run = this.runs.find((item) => item.status === "queued");
    if (!run) return null;
    Object.assign(run, { status: "running", startedAt: Date.now() });
    return { ...run };
  }

  async setRunExecution(
    id: string,
    execution: {
      contextMode: "worktree" | "diff_only";
      model: string | null;
      reasoning: string | null;
    },
  ) {
    const run = this.runs.find((item) => item.id === id && item.status === "running");
    if (run) Object.assign(run, execution);
  }

  async consumeRepairAttempt(id: string) {
    const run = this.runs.find((item) => item.id === id && item.status === "running");
    if (!run || run.repairCount > 0) return false;
    run.repairCount += 1;
    return true;
  }

  async retryRun(id: string) {
    const run = this.runs.find((item) => item.id === id && item.status === "failed");
    if (run) Object.assign(run, { status: "queued", trigger: "retry" });
  }

  async completeRun(input: Parameters<AutoReviewDb["completeRun"]>[0]) {
    const run = this.runs.find((item) => item.id === input.id && item.status === "running");
    if (!run) return;
    Object.assign(run, {
      status: "completed",
      contextMode: input.contextMode,
      conclusion: input.conclusion,
      overallComment: input.overallComment,
      toneSampleHash: input.toneSampleHash,
      completedAt: input.completedAt,
      exportError: input.exportError,
    });
    this.findings.set(
      input.id,
      input.findings.map((finding) => ({ ...finding })),
    );
  }

  async failRun(input: Parameters<AutoReviewDb["failRun"]>[0]) {
    const run = this.runs.find(
      (item) => item.id === input.id && (item.status === "queued" || item.status === "running"),
    );
    if (run) {
      Object.assign(run, {
        status: "failed",
        errorCode: input.code,
        errorMessage: input.message,
        completedAt: input.completedAt,
      });
    }
  }

  async supersedeRun(id: string, nextHeadSha: string, completedAt: number) {
    const run = this.runs.find(
      (item) => item.id === id && (item.status === "queued" || item.status === "running"),
    );
    if (run) {
      Object.assign(run, {
        status: "superseded",
        supersededByHeadSha: nextHeadSha,
        completedAt,
      });
    }
  }

  async recoverStaleRuns(activeKeys: Set<string>) {
    for (const run of this.runs.filter((item) => item.status === "running")) {
      if (activeKeys.has(run.id) || activeKeys.has(autoReviewKey(run.id))) continue;
      if (run.recoveryCount === 0) {
        Object.assign(run, {
          status: "queued",
          startedAt: null,
          queuedAt: Date.now(),
          recoveryCount: 1,
        });
      } else {
        Object.assign(run, {
          status: "failed",
          completedAt: Date.now(),
          recoveryCount: 2,
          errorCode: "interrupted_repeatedly",
          errorMessage: "The review process was interrupted more than once.",
        });
      }
    }
  }

  async listDueNotifications() {
    return [];
  }

  async markNotificationDelivered() {}

  async getRunDetail(id: string) {
    const run = this.runs.find((item) => item.id === id);
    return run
      ? {
          run: { ...run },
          findings: this.findings.get(id)?.map((finding) => ({ ...finding })) ?? [],
        }
      : null;
  }

  async deleteRun(id: string) {
    const index = this.runs.findIndex((item) => item.id === id);
    if (index >= 0) this.runs.splice(index, 1);
    this.findings.delete(id);
    return { jsonPath: null, markdownPath: null };
  }
}

function setup(initial = [candidate()]) {
  const db = new MemoryAutoReviewDb();
  let candidates = initial;
  let files: PullFile[] = [pullFile()];
  let startError: Error | null = null;
  let currentError: Error | null = null;
  const starts: StartAutoReviewInput[] = [];
  const canceled: string[] = [];
  const prepared: string[] = [];
  const cleaned: string[] = [];
  let loadFilesCount = 0;
  const inflight: string[] = [];
  const services: AutoReviewServices = {
    now: Date.now,
    makeFindingId: (runId, ordinal) => `${runId}:${ordinal}`,
    loadCandidates: async () => candidates.map((item) => ({ ...item })),
    loadFiles: async () => {
      loadFilesCount += 1;
      return files.map((file) => ({ ...file }));
    },
    loadCurrentCandidate: async (repo, number) => {
      if (currentError) throw currentError;
      return candidates.find((item) => item.repo === repo && item.number === number) ?? null;
    },
    startAi: async (input) => {
      if (startError) throw startError;
      starts.push(input);
    },
    cancelAi: async (key) => {
      canceled.push(key);
    },
    inflightKeys: async () => [...inflight],
    prepareContext: async (run) => {
      prepared.push(run.id);
      return {
        runId: run.id,
        contextMode: "diff_only",
        cwd: null,
        generatedToneProfile: "Short direct questions.",
        recentExamples: ["Could this race with the retry path?"],
        toneSampleHash: "tone-hash",
      };
    },
    cleanupContext: async (context) => {
      cleaned.push(context.runId);
    },
    aiInstructions: () => "Ask before assuming intent.",
    codexConfig: () => ({
      provider: "codex",
      model: "gpt-review",
      reasoningEffort: "high",
    }),
  };
  const coordinator = createAutoReviewCoordinator({ db, services });
  return {
    db,
    services,
    coordinator,
    starts,
    canceled,
    prepared,
    cleaned,
    setCandidates(value: ReviewCandidate[]) {
      candidates = value;
    },
    setFiles(value: PullFile[]) {
      files = value;
    },
    setStartError(value: Error | null) {
      startError = value;
    },
    setCurrentError(value: Error | null) {
      currentError = value;
    },
    loadFilesCount: () => loadFilesCount,
  };
}

const noConcerns = JSON.stringify({
  conclusion: "no_concerns",
  overallComment: "looks good from my side",
  findings: [],
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("automated review coordinator", () => {
  test("does not create a run for a disabled repository", async () => {
    const fixture = setup();
    fixture.db.settings[0].enabled = false;

    await fixture.coordinator.reconcile("launch");

    expect(fixture.db.runs).toHaveLength(0);
    expect(fixture.loadFilesCount()).toBe(0);
    expect(fixture.starts).toHaveLength(0);
  });

  test("does not load files, enqueue, or start when a pending review exists", async () => {
    const pending = candidate();
    pending.hasPendingReview = true;
    const fixture = setup([pending]);

    await fixture.coordinator.reconcile("assignment");

    expect(fixture.loadFilesCount()).toBe(0);
    expect(fixture.db.runs).toHaveLength(0);
    expect(fixture.starts).toHaveLength(0);
  });

  test("does not enqueue a pull request that is still a draft", async () => {
    const draft = { ...candidate(), isDraft: true };
    const fixture = setup([draft]);

    await fixture.coordinator.reconcile("assignment");

    expect(fixture.db.runs).toHaveLength(0);
    expect(fixture.loadFilesCount()).toBe(0);
  });

  test("deduplicates the same head across launch, assignment, and timer wakes", async () => {
    const fixture = setup();

    await Promise.all([
      fixture.coordinator.reconcile("launch"),
      fixture.coordinator.reconcile("assignment"),
      fixture.coordinator.reconcile("reconnect"),
    ]);

    expect(fixture.db.runs).toHaveLength(1);
    expect(fixture.starts).toHaveLength(1);
  });

  test("supersedes an active old head and starts one review for the new head", async () => {
    const fixture = setup([candidate(42, "head-old")]);
    await fixture.coordinator.reconcile("assignment");
    fixture.setCandidates([candidate(42, "head-new")]);

    await fixture.coordinator.reconcile("head_changed");

    expect(fixture.db.runs.map((run) => [run.headSha, run.status])).toEqual([
      ["head-old", "superseded"],
      ["head-new", "running"],
    ]);
    expect(fixture.canceled).toEqual([autoReviewKey("run-1")]);
    expect(fixture.cleaned).toEqual(["run-1"]);
    expect(fixture.starts.map((input) => input.headSha)).toEqual(["head-old", "head-new"]);
  });

  test("does not start a queued review after its assignment is removed", async () => {
    const fixture = setup([candidate(42), candidate(43)]);
    await fixture.coordinator.reconcile("assignment");
    fixture.setCandidates([candidate(42)]);

    await fixture.coordinator.reconcile("reconnect");
    await fixture.coordinator.handleAiDone({
      key: autoReviewKey("run-1"),
      ok: true,
      output: noConcerns,
      headSha: "head-42",
    });

    expect(fixture.starts.map((input) => input.run.id)).toEqual(["run-1"]);
    expect(fixture.db.runs.find((run) => run.prNumber === 43)).toMatchObject({
      status: "failed",
      errorCode: "assignment_removed",
    });
  });

  test("claims one review at a time and leaves the next one queued", async () => {
    const fixture = setup([candidate(42), candidate(43)]);

    await fixture.coordinator.reconcile("assignment");

    expect(fixture.starts.map((input) => input.run.id)).toEqual(["run-1"]);
    expect(fixture.db.runs.map((run) => run.status)).toEqual(["running", "queued"]);
  });

  test("completes a valid no-concerns result and cleans its context", async () => {
    const fixture = setup();
    await fixture.coordinator.reconcile("assignment");

    await fixture.coordinator.handleAiDone({
      key: autoReviewKey("run-1"),
      ok: true,
      output: noConcerns,
      headSha: "head-42",
    });

    expect(fixture.db.runs[0]).toMatchObject({
      status: "completed",
      conclusion: "no_concerns",
      toneSampleHash: "tone-hash",
    });
    expect(fixture.cleaned).toEqual(["run-1"]);
  });

  test("repairs malformed output exactly once with the same run key", async () => {
    const fixture = setup();
    await fixture.coordinator.reconcile("assignment");

    await fixture.coordinator.handleAiDone({
      key: autoReviewKey("run-1"),
      ok: true,
      output: "not json",
      headSha: "head-42",
    });

    expect(fixture.starts).toHaveLength(2);
    expect(fixture.starts[1].key).toBe(autoReviewKey("run-1"));
    expect(fixture.starts[1].prompt).toContain("previous response did not match");
    expect(fixture.db.runs[0].repairCount).toBe(1);

    await fixture.coordinator.handleAiDone({
      key: autoReviewKey("run-1"),
      ok: true,
      output: "still not json",
      headSha: "head-42",
    });

    expect(fixture.starts).toHaveLength(2);
    expect(fixture.db.runs[0]).toMatchObject({
      status: "failed",
      errorCode: "malformed_json",
    });
    expect(fixture.cleaned).toEqual(["run-1"]);
  });

  test("does not attach a result after the head changes", async () => {
    const fixture = setup([candidate(42, "head-old")]);
    await fixture.coordinator.reconcile("assignment");
    fixture.setCandidates([candidate(42, "head-new")]);

    await fixture.coordinator.handleAiDone({
      key: autoReviewKey("run-1"),
      ok: true,
      output: noConcerns,
      headSha: "head-old",
    });

    expect(fixture.db.runs[0]).toMatchObject({
      status: "superseded",
      supersededByHeadSha: "head-new",
      conclusion: null,
    });
    expect(fixture.db.runs[1]).toMatchObject({ headSha: "head-new", status: "running" });
  });

  test("recovers an interrupted review once and fails a repeated interruption", async () => {
    const fixture = setup();
    const run = await fixture.db.enqueueCandidate(candidate(), "assignment");
    await fixture.db.claimNextQueuedRun();

    await fixture.coordinator.start();

    expect(fixture.db.runs[0]).toMatchObject({ status: "running", recoveryCount: 1 });
    expect(fixture.starts).toHaveLength(1);

    const restarted = createAutoReviewCoordinator({ db: fixture.db, services: fixture.services });
    await restarted.start();

    expect(fixture.db.runs[0]).toMatchObject({
      id: run?.id,
      status: "failed",
      recoveryCount: 2,
      errorCode: "interrupted_repeatedly",
    });
    expect(fixture.starts).toHaveLength(1);
  });

  test("fails before Codex when no reviewable patch is available", async () => {
    const fixture = setup();
    fixture.setFiles([{ ...pullFile(), patch: null }]);

    await fixture.coordinator.reconcile("assignment");

    expect(fixture.starts).toHaveLength(0);
    expect(fixture.db.runs[0]).toMatchObject({
      status: "failed",
      errorCode: "diff_unavailable",
    });
    expect(fixture.cleaned).toEqual(["run-1"]);
  });

  test("fails visibly when the live candidate cannot be rechecked after completion", async () => {
    const fixture = setup();
    await fixture.coordinator.reconcile("assignment");
    fixture.setCurrentError(new Error("GitHub unavailable"));

    await fixture.coordinator.handleAiDone({
      key: autoReviewKey("run-1"),
      ok: true,
      output: noConcerns,
      headSha: "head-42",
    });

    expect(fixture.db.runs[0]).toMatchObject({
      status: "failed",
      errorCode: "candidate_refresh_failed",
    });
    expect(fixture.cleaned).toEqual(["run-1"]);
  });

  test("cleans context after start failure and cancellation", async () => {
    const failed = setup();
    failed.setStartError(new Error("Codex unavailable"));
    await failed.coordinator.reconcile("assignment");

    expect(failed.db.runs[0]).toMatchObject({ status: "failed", errorCode: "codex_start_failed" });
    expect(failed.cleaned).toEqual(["run-1"]);

    const canceled = setup();
    await canceled.coordinator.reconcile("assignment");
    canceled.setCurrentError(new Error("GitHub unavailable"));
    await canceled.coordinator.handleAiDone({
      key: autoReviewKey("run-1"),
      ok: false,
      error: "Canceled",
      canceled: true,
    });

    expect(canceled.db.runs[0]).toMatchObject({ status: "failed", errorCode: "canceled" });
    expect(canceled.cleaned).toEqual(["run-1"]);
  });
});
