import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type SqlClient, createAutoReviewDb } from "@/lib/auto-review/db";
import type { AutoReviewFinding, ReviewCandidate } from "@/lib/auto-review/types";

const SCHEMA = `
CREATE TABLE auto_review_repo_settings (
  repo TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  model_override TEXT,
  reasoning_override TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE auto_review_runs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  pr_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_title TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  author_login TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  context_mode TEXT,
  provider TEXT NOT NULL DEFAULT 'codex',
  model TEXT,
  reasoning TEXT,
  conclusion TEXT,
  overall_comment TEXT,
  tone_sample_hash TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  repair_count INTEGER NOT NULL DEFAULT 0,
  recovery_count INTEGER NOT NULL DEFAULT 0,
  superseded_by_head_sha TEXT,
  json_artifact_path TEXT,
  markdown_artifact_path TEXT,
  export_error TEXT,
  notification_kind TEXT,
  notification_due_at INTEGER,
  notified_at INTEGER,
  viewed_at INTEGER,
  UNIQUE(repo, pr_number, head_sha)
);
CREATE TABLE auto_review_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES auto_review_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  category TEXT NOT NULL,
  confidence TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  side TEXT NOT NULL,
  comment TEXT NOT NULL,
  evidence TEXT,
  github_url TEXT,
  UNIQUE(run_id, ordinal)
);`;

class BunSqlClient implements SqlClient {
  constructor(private readonly database: Database) {}

  async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
    const rows = this.database.query(query).all(...(bindValues as never[]));
    return rows as T;
  }

  async execute(
    query: string,
    bindValues: unknown[] = [],
  ): Promise<{ rowsAffected: number; lastInsertId?: number }> {
    const result = this.database.query(query).run(...(bindValues as never[]));
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }
}

const candidate = (headSha = "head-1"): ReviewCandidate => ({
  id: 17,
  repo: "acme/widgets",
  number: 42,
  title: "Make widgets safer",
  url: "https://github.com/acme/widgets/pull/42",
  authorLogin: "dev",
  authorAvatar: "https://example.com/dev.png",
  baseSha: "base-1",
  headSha,
  hasPendingReview: false,
});

const finding = (runId: string): AutoReviewFinding => ({
  id: `${runId}:0`,
  runId,
  ordinal: 0,
  category: "correctness",
  confidence: "high",
  path: "src/widget.ts",
  line: 12,
  endLine: 12,
  side: "RIGHT",
  comment: "Could this return before the write finishes?",
  evidence: "The promise is not awaited.",
  githubUrl: "https://github.com/acme/widgets/blob/head-1/src/widget.ts#L12",
});

let database: Database | null = null;

function setup() {
  database = new Database(":memory:");
  database.exec(SCHEMA);
  let now = 1_000;
  let id = 0;
  const repository = createAutoReviewDb(async () => new BunSqlClient(database as Database), {
    now: () => now,
    makeId: () => `run-${++id}`,
  });
  return {
    repository,
    setNow(value: number) {
      now = value;
    },
  };
}

afterEach(() => {
  database?.close();
  database = null;
});

describe("automated review persistence", () => {
  test("deduplicates the same repository, pull request, and head SHA", async () => {
    const { repository } = setup();

    const first = await repository.enqueueCandidate(candidate(), "assignment");
    const duplicate = await repository.enqueueCandidate(candidate(), "launch");

    expect(first?.id).toBe("run-1");
    expect(duplicate).toBeNull();
    expect(await repository.listRuns()).toHaveLength(1);
  });

  test("queues a separate run when the head SHA changes", async () => {
    const { repository, setNow } = setup();
    await repository.enqueueCandidate(candidate("head-1"), "assignment");
    setNow(2_000);

    const second = await repository.enqueueCandidate(candidate("head-2"), "head_changed");

    expect(second?.headSha).toBe("head-2");
    expect(await repository.listRuns()).toHaveLength(2);
  });

  test("claims only the oldest queued run", async () => {
    const { repository, setNow } = setup();
    await repository.enqueueCandidate(candidate("head-1"), "assignment");
    setNow(2_000);
    await repository.enqueueCandidate(candidate("head-2"), "head_changed");
    setNow(3_000);

    const claimed = await repository.claimNextQueuedRun();
    const runs = await repository.listRuns();

    expect(claimed?.headSha).toBe("head-1");
    expect(claimed?.startedAt).toBe(3_000);
    expect(runs.map((run) => run.status)).toEqual(["queued", "running"]);
  });

  test("records the execution context and resolved Codex settings", async () => {
    const { repository } = setup();
    const run = await repository.enqueueCandidate(candidate(), "assignment");
    expect(run).not.toBeNull();
    await repository.claimNextQueuedRun();

    await repository.setRunExecution(run?.id as string, {
      contextMode: "diff_only",
      model: "gpt-review",
      reasoning: "high",
    });

    expect((await repository.getRunDetail(run?.id as string))?.run).toMatchObject({
      contextMode: "diff_only",
      model: "gpt-review",
      reasoning: "high",
    });
  });

  test("allows exactly one repair attempt for a running review", async () => {
    const { repository } = setup();
    const run = await repository.enqueueCandidate(candidate(), "assignment");
    expect(run).not.toBeNull();
    await repository.claimNextQueuedRun();

    expect(await repository.consumeRepairAttempt(run?.id as string)).toBe(true);
    expect(await repository.consumeRepairAttempt(run?.id as string)).toBe(false);
    expect((await repository.getRunDetail(run?.id as string))?.run.repairCount).toBe(1);
  });

  test("retries a failed run without creating another row", async () => {
    const { repository, setNow } = setup();
    const run = await repository.enqueueCandidate(candidate(), "assignment");
    expect(run).not.toBeNull();
    await repository.failRun({
      id: run?.id as string,
      code: "codex_failed",
      message: "Codex exited",
      completedAt: 2_000,
    });
    setNow(3_000);

    await repository.retryRun(run?.id as string);

    const rows = await repository.listRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "queued",
      trigger: "retry",
      queuedAt: 3_000,
      errorCode: null,
      errorMessage: null,
    });
  });

  test("keeps validated findings when artifact export fails", async () => {
    const { repository } = setup();
    const run = await repository.enqueueCandidate(candidate(), "assignment");
    expect(run).not.toBeNull();

    await repository.completeRun({
      id: run?.id as string,
      contextMode: "diff_only",
      conclusion: "findings",
      overallComment: null,
      toneSampleHash: "tone-hash",
      completedAt: 2_000,
      findings: [finding(run?.id as string)],
      exportError: "disk full",
    });

    const detail = await repository.getRunDetail(run?.id as string);
    expect(detail?.run).toMatchObject({ status: "completed", exportError: "disk full" });
    expect(detail?.findings).toHaveLength(1);
  });

  test("deletes findings before deleting a run", async () => {
    const { repository } = setup();
    const run = await repository.enqueueCandidate(candidate(), "assignment");
    expect(run).not.toBeNull();
    await repository.completeRun({
      id: run?.id as string,
      contextMode: "diff_only",
      conclusion: "findings",
      overallComment: null,
      toneSampleHash: null,
      completedAt: 2_000,
      findings: [finding(run?.id as string)],
      exportError: null,
    });

    const artifacts = await repository.deleteRun(run?.id as string);

    expect(artifacts).toEqual({ jsonPath: null, markdownPath: null });
    expect(await repository.getRunDetail(run?.id as string)).toBeNull();
  });

  test("upserts repository settings without changing the creation time", async () => {
    const { repository, setNow } = setup();
    await repository.setRepoSetting({
      repo: "acme/widgets",
      enabled: false,
      modelOverride: null,
      reasoningOverride: null,
    });
    setNow(2_000);

    await repository.setRepoSetting({
      repo: "acme/widgets",
      enabled: true,
      modelOverride: "gpt-review",
      reasoningOverride: "high",
    });

    expect(await repository.listRepoSettings()).toEqual([
      {
        repo: "acme/widgets",
        enabled: true,
        modelOverride: "gpt-review",
        reasoningOverride: "high",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ]);
  });

  test("supersedes an unfinished run when a new head is observed", async () => {
    const { repository } = setup();
    const run = await repository.enqueueCandidate(candidate("head-1"), "assignment");
    expect(run).not.toBeNull();

    await repository.supersedeRun(run?.id as string, "head-2", 2_000);

    expect((await repository.getRunDetail(run?.id as string))?.run).toMatchObject({
      status: "superseded",
      supersededByHeadSha: "head-2",
      completedAt: 2_000,
    });
  });

  test("recovers an interrupted run once and then fails a repeated interruption", async () => {
    const { repository, setNow } = setup();
    const run = await repository.enqueueCandidate(candidate(), "assignment");
    expect(run).not.toBeNull();
    await repository.claimNextQueuedRun();
    setNow(2_000);

    await repository.recoverStaleRuns(new Set());
    expect((await repository.getRunDetail(run?.id as string))?.run).toMatchObject({
      status: "queued",
      recoveryCount: 1,
    });

    await repository.claimNextQueuedRun();
    setNow(3_000);
    await repository.recoverStaleRuns(new Set());

    expect((await repository.getRunDetail(run?.id as string))?.run).toMatchObject({
      status: "failed",
      recoveryCount: 2,
      errorCode: "interrupted_repeatedly",
      completedAt: 3_000,
    });
  });

  test("returns only due undelivered notifications and marks them delivered", async () => {
    const { repository } = setup();
    const run = await repository.enqueueCandidate(candidate(), "assignment");
    expect(run).not.toBeNull();
    database
      ?.query(
        "UPDATE auto_review_runs SET notification_kind = 'auto_review_findings', notification_due_at = 2000 WHERE id = $id",
      )
      .run({ $id: run?.id as string });

    expect(await repository.listDueNotifications(1_999)).toEqual([]);
    expect((await repository.listDueNotifications(2_000)).map((item) => item.id)).toEqual([
      run?.id as string,
    ]);

    await repository.markNotificationDelivered(run?.id as string, 2_100);

    expect(await repository.listDueNotifications(3_000)).toEqual([]);
  });

  test("marks a completed result viewed only once", async () => {
    const { repository } = setup();
    const run = await repository.enqueueCandidate(candidate(), "assignment");
    expect(run).not.toBeNull();
    await repository.completeRun({
      id: run?.id as string,
      contextMode: "diff_only",
      conclusion: "no_concerns",
      overallComment: null,
      toneSampleHash: null,
      completedAt: 2_000,
      findings: [],
      exportError: null,
    });

    expect((await repository.getRunDetail(run?.id as string))?.run.viewedAt).toBeNull();
    await repository.markRunViewed(run?.id as string, 3_000);
    await repository.markRunViewed(run?.id as string, 4_000);

    expect((await repository.getRunDetail(run?.id as string))?.run.viewedAt).toBe(3_000);
  });
});
