import type {
  AutoReviewConclusion,
  AutoReviewContextMode,
  AutoReviewFinding,
  AutoReviewRepoSetting,
  AutoReviewRun,
  AutoReviewStatus,
  AutoReviewTrigger,
  CompleteRunInput,
  FailRunInput,
  ReviewCandidate,
} from "@/lib/auto-review/types";
import Database from "@tauri-apps/plugin-sql";

export interface SqlClient {
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  execute(
    query: string,
    bindValues?: unknown[],
  ): Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

export interface AutoReviewDbDependencies {
  now: () => number;
  makeId: () => string;
}

export interface AutoReviewDb {
  listRepoSettings(): Promise<AutoReviewRepoSetting[]>;
  setRepoSetting(
    setting: Pick<
      AutoReviewRepoSetting,
      "repo" | "enabled" | "modelOverride" | "reasoningOverride"
    >,
  ): Promise<void>;
  enqueueCandidate(
    candidate: ReviewCandidate,
    trigger: AutoReviewTrigger,
  ): Promise<AutoReviewRun | null>;
  listRuns(): Promise<AutoReviewRun[]>;
  claimNextQueuedRun(): Promise<AutoReviewRun | null>;
  setRunExecution(
    id: string,
    execution: {
      contextMode: AutoReviewContextMode;
      model: string | null;
      reasoning: string | null;
    },
  ): Promise<void>;
  consumeRepairAttempt(id: string): Promise<boolean>;
  retryRun(id: string): Promise<void>;
  completeRun(input: CompleteRunInput): Promise<void>;
  failRun(input: FailRunInput): Promise<void>;
  supersedeRun(id: string, nextHeadSha: string, completedAt: number): Promise<void>;
  recoverStaleRuns(activeKeys: Set<string>): Promise<void>;
  listDueNotifications(now: number): Promise<AutoReviewRun[]>;
  markNotificationDelivered(id: string, deliveredAt: number): Promise<void>;
  markRunViewed(id: string, viewedAt: number): Promise<void>;
  getRunDetail(id: string): Promise<{ run: AutoReviewRun; findings: AutoReviewFinding[] } | null>;
  deleteRun(id: string): Promise<{ jsonPath: string | null; markdownPath: string | null }>;
}

interface RunRow {
  id: string;
  repo: string;
  pr_id: number;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  author_login: string;
  base_sha: string;
  head_sha: string;
  status: string;
  trigger: string;
  context_mode: string | null;
  provider: string;
  model: string | null;
  reasoning: string | null;
  conclusion: string | null;
  overall_comment: string | null;
  tone_sample_hash: string | null;
  queued_at: number;
  started_at: number | null;
  completed_at: number | null;
  error_code: string | null;
  error_message: string | null;
  repair_count: number;
  recovery_count: number;
  superseded_by_head_sha: string | null;
  json_artifact_path: string | null;
  markdown_artifact_path: string | null;
  export_error: string | null;
  notification_kind: string | null;
  notification_due_at: number | null;
  notified_at: number | null;
  viewed_at: number | null;
}

interface FindingRow {
  id: string;
  run_id: string;
  ordinal: number;
  category: AutoReviewFinding["category"];
  confidence: AutoReviewFinding["confidence"];
  path: string;
  line: number;
  end_line: number;
  side: AutoReviewFinding["side"];
  comment: string;
  evidence: string | null;
  github_url: string | null;
}

interface RepoSettingRow {
  repo: string;
  enabled: number;
  model_override: string | null;
  reasoning_override: string | null;
  created_at: number;
  updated_at: number;
}

function toRun(row: RunRow): AutoReviewRun {
  return {
    id: row.id,
    repo: row.repo,
    prId: row.pr_id,
    prNumber: row.pr_number,
    prTitle: row.pr_title,
    prUrl: row.pr_url,
    authorLogin: row.author_login,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    status: row.status as AutoReviewStatus,
    trigger: row.trigger as AutoReviewTrigger,
    contextMode: row.context_mode as AutoReviewContextMode | null,
    provider: "codex",
    model: row.model,
    reasoning: row.reasoning,
    conclusion: row.conclusion as AutoReviewConclusion | null,
    overallComment: row.overall_comment,
    toneSampleHash: row.tone_sample_hash,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    repairCount: row.repair_count,
    recoveryCount: row.recovery_count,
    supersededByHeadSha: row.superseded_by_head_sha,
    jsonArtifactPath: row.json_artifact_path,
    markdownArtifactPath: row.markdown_artifact_path,
    exportError: row.export_error,
    notificationKind: row.notification_kind,
    notificationDueAt: row.notification_due_at,
    notifiedAt: row.notified_at,
    viewedAt: row.viewed_at,
  };
}

function toFinding(row: FindingRow): AutoReviewFinding {
  return {
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    category: row.category,
    confidence: row.confidence,
    path: row.path,
    line: row.line,
    endLine: row.end_line,
    side: row.side,
    comment: row.comment,
    evidence: row.evidence,
    githubUrl: row.github_url,
  };
}

function toRepoSetting(row: RepoSettingRow): AutoReviewRepoSetting {
  return {
    repo: row.repo,
    enabled: row.enabled === 1,
    modelOverride: row.model_override,
    reasoningOverride: row.reasoning_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAutoReviewDb(
  loadClient: () => Promise<SqlClient>,
  dependencies: AutoReviewDbDependencies,
): AutoReviewDb {
  return {
    async listRepoSettings() {
      const client = await loadClient();
      const rows = await client.select<RepoSettingRow[]>(
        "SELECT * FROM auto_review_repo_settings ORDER BY repo ASC",
      );
      return rows.map(toRepoSetting);
    },
    async setRepoSetting(setting) {
      const client = await loadClient();
      const now = dependencies.now();
      await client.execute(
        `INSERT INTO auto_review_repo_settings (
          repo, enabled, model_override, reasoning_override, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$5)
        ON CONFLICT(repo) DO UPDATE SET
          enabled = excluded.enabled,
          model_override = excluded.model_override,
          reasoning_override = excluded.reasoning_override,
          updated_at = excluded.updated_at`,
        [
          setting.repo,
          setting.enabled ? 1 : 0,
          setting.modelOverride,
          setting.reasoningOverride,
          now,
        ],
      );
    },
    async enqueueCandidate(candidate, trigger) {
      const client = await loadClient();
      const rows = await client.select<RunRow[]>(
        `INSERT INTO auto_review_runs (
          id, repo, pr_id, pr_number, pr_title, pr_url, author_login,
          base_sha, head_sha, status, trigger, queued_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11)
        ON CONFLICT(repo, pr_number, head_sha) DO NOTHING
        RETURNING *`,
        [
          dependencies.makeId(),
          candidate.repo,
          candidate.id,
          candidate.number,
          candidate.title,
          candidate.url,
          candidate.authorLogin,
          candidate.baseSha,
          candidate.headSha,
          trigger,
          dependencies.now(),
        ],
      );
      return rows[0] ? toRun(rows[0]) : null;
    },
    async listRuns() {
      const client = await loadClient();
      const rows = await client.select<RunRow[]>(
        "SELECT * FROM auto_review_runs ORDER BY queued_at DESC, id DESC",
      );
      return rows.map(toRun);
    },
    async claimNextQueuedRun() {
      const client = await loadClient();
      const rows = await client.select<RunRow[]>(
        `UPDATE auto_review_runs
         SET status = 'running', started_at = $1, completed_at = NULL,
             error_code = NULL, error_message = NULL
         WHERE id = (
           SELECT id FROM auto_review_runs
           WHERE status = 'queued'
           ORDER BY queued_at ASC, id ASC
           LIMIT 1
         ) AND status = 'queued'
         RETURNING *`,
        [dependencies.now()],
      );
      return rows[0] ? toRun(rows[0]) : null;
    },
    async setRunExecution(id, execution) {
      const client = await loadClient();
      await client.execute(
        `UPDATE auto_review_runs
         SET context_mode = $1, model = $2, reasoning = $3
         WHERE id = $4 AND status = 'running'`,
        [execution.contextMode, execution.model, execution.reasoning, id],
      );
    },
    async consumeRepairAttempt(id) {
      const client = await loadClient();
      const rows = await client.select<Array<{ id: string }>>(
        `UPDATE auto_review_runs
         SET repair_count = repair_count + 1
         WHERE id = $1 AND status = 'running' AND repair_count = 0
         RETURNING id`,
        [id],
      );
      return rows.length === 1;
    },
    async retryRun(id) {
      const client = await loadClient();
      await client.execute(
        `UPDATE auto_review_runs
         SET status = 'queued', trigger = 'retry', queued_at = $1,
             started_at = NULL, completed_at = NULL,
             error_code = NULL, error_message = NULL,
             superseded_by_head_sha = NULL
         WHERE id = $2 AND status = 'failed'`,
        [dependencies.now(), id],
      );
    },
    async completeRun(input) {
      const client = await loadClient();
      for (const item of input.findings) {
        await client.execute(
          `INSERT INTO auto_review_findings (
            id, run_id, ordinal, category, confidence, path, line, end_line,
            side, comment, evidence, github_url
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT(run_id, ordinal) DO UPDATE SET
            id = excluded.id,
            category = excluded.category,
            confidence = excluded.confidence,
            path = excluded.path,
            line = excluded.line,
            end_line = excluded.end_line,
            side = excluded.side,
            comment = excluded.comment,
            evidence = excluded.evidence,
            github_url = excluded.github_url`,
          [
            item.id,
            input.id,
            item.ordinal,
            item.category,
            item.confidence,
            item.path,
            item.line,
            item.endLine,
            item.side,
            item.comment,
            item.evidence,
            item.githubUrl,
          ],
        );
      }
      await client.execute(
        `UPDATE auto_review_runs
         SET status = 'completed', context_mode = $1, conclusion = $2,
             overall_comment = $3, tone_sample_hash = $4, completed_at = $5,
             error_code = NULL, error_message = NULL, export_error = $6
         WHERE id = $7 AND status IN ('queued', 'running')`,
        [
          input.contextMode,
          input.conclusion,
          input.overallComment,
          input.toneSampleHash,
          input.completedAt,
          input.exportError,
          input.id,
        ],
      );
    },
    async failRun(input) {
      const client = await loadClient();
      await client.execute(
        `UPDATE auto_review_runs
         SET status = 'failed', completed_at = $1,
             error_code = $2, error_message = $3
         WHERE id = $4 AND status IN ('queued', 'running')`,
        [input.completedAt, input.code, input.message, input.id],
      );
    },
    async supersedeRun(id, nextHeadSha, completedAt) {
      const client = await loadClient();
      await client.execute(
        `UPDATE auto_review_runs
         SET status = 'superseded', completed_at = $1,
             superseded_by_head_sha = $2
         WHERE id = $3 AND status IN ('queued', 'running')`,
        [completedAt, nextHeadSha, id],
      );
    },
    async recoverStaleRuns(activeKeys) {
      const client = await loadClient();
      const rows = await client.select<RunRow[]>(
        "SELECT * FROM auto_review_runs WHERE status = 'running' ORDER BY started_at ASC",
      );
      for (const row of rows) {
        const active = activeKeys.has(row.id) || activeKeys.has(`auto-review:${row.id}`);
        if (active) continue;
        const now = dependencies.now();
        if (row.recovery_count === 0) {
          await client.execute(
            `UPDATE auto_review_runs
             SET status = 'queued', queued_at = $1, started_at = NULL,
                 recovery_count = recovery_count + 1
             WHERE id = $2 AND status = 'running'`,
            [now, row.id],
          );
        } else {
          await client.execute(
            `UPDATE auto_review_runs
             SET status = 'failed', completed_at = $1,
                 recovery_count = recovery_count + 1,
                 error_code = 'interrupted_repeatedly',
                 error_message = 'The review process was interrupted more than once.'
             WHERE id = $2 AND status = 'running'`,
            [now, row.id],
          );
        }
      }
    },
    async listDueNotifications(now) {
      const client = await loadClient();
      const rows = await client.select<RunRow[]>(
        `SELECT * FROM auto_review_runs
         WHERE notification_kind IS NOT NULL
           AND notification_due_at IS NOT NULL
           AND notification_due_at <= $1
           AND notified_at IS NULL
         ORDER BY notification_due_at ASC, id ASC`,
        [now],
      );
      return rows.map(toRun);
    },
    async markNotificationDelivered(id, deliveredAt) {
      const client = await loadClient();
      await client.execute(
        "UPDATE auto_review_runs SET notified_at = $1 WHERE id = $2 AND notified_at IS NULL",
        [deliveredAt, id],
      );
    },
    async markRunViewed(id, viewedAt) {
      const client = await loadClient();
      await client.execute(
        `UPDATE auto_review_runs
         SET viewed_at = $1
         WHERE id = $2 AND status = 'completed' AND viewed_at IS NULL`,
        [viewedAt, id],
      );
    },
    async getRunDetail(id) {
      const client = await loadClient();
      const rows = await client.select<RunRow[]>("SELECT * FROM auto_review_runs WHERE id = $1", [
        id,
      ]);
      if (!rows[0]) return null;
      const findings = await client.select<FindingRow[]>(
        "SELECT * FROM auto_review_findings WHERE run_id = $1 ORDER BY ordinal ASC",
        [id],
      );
      return { run: toRun(rows[0]), findings: findings.map(toFinding) };
    },
    async deleteRun(id) {
      const client = await loadClient();
      const rows = await client.select<
        Array<{ json_artifact_path: string | null; markdown_artifact_path: string | null }>
      >("SELECT json_artifact_path, markdown_artifact_path FROM auto_review_runs WHERE id = $1", [
        id,
      ]);
      await client.execute("DELETE FROM auto_review_findings WHERE run_id = $1", [id]);
      await client.execute("DELETE FROM auto_review_runs WHERE id = $1", [id]);
      return {
        jsonPath: rows[0]?.json_artifact_path ?? null,
        markdownPath: rows[0]?.markdown_artifact_path ?? null,
      };
    },
  };
}

let databasePromise: Promise<Database> | null = null;

function loadDatabase(): Promise<Database> {
  if (!databasePromise) databasePromise = Database.load("sqlite:reviewly.db");
  return databasePromise;
}

export const autoReviewDb = createAutoReviewDb(loadDatabase, {
  now: Date.now,
  makeId: () => crypto.randomUUID(),
});
