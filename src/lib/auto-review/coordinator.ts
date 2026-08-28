import { type AiDone, autoReviewKey, classifyAiTaskKey, firstLineHint } from "@/lib/ai/tasks";
import type { AutomatedCodexConfig } from "@/lib/auto-review/config";
import type { AutoReviewDb } from "@/lib/auto-review/db";
import { buildAutoReviewPrompt } from "@/lib/auto-review/prompt";
import { buildRepairPrompt, parseAutoReviewResult } from "@/lib/auto-review/result";
import type {
  AutoReviewContextMode,
  AutoReviewRepoSetting,
  AutoReviewRun,
  AutoReviewTrigger,
  ReviewCandidate,
} from "@/lib/auto-review/types";
import { validateAutoReviewResult } from "@/lib/auto-review/validate";
import { parsePatch } from "@/lib/diff";
import type { PullFile } from "@/lib/tauri";

export const AUTO_REVIEW_WAKE_EVENT = "reviewly:auto-review-wake";

export interface PreparedContext {
  runId: string;
  contextMode: AutoReviewContextMode;
  cwd: string | null;
  generatedToneProfile: string;
  recentExamples: string[];
  toneSampleHash: string | null;
}

export interface StartAutoReviewInput {
  run: AutoReviewRun;
  key: string;
  provider: "codex";
  prompt: string;
  headSha: string;
  cwd: string | null;
  model?: string;
  reasoningEffort?: string;
  timeoutSecs?: number;
}

export interface AutoReviewServices {
  now(): number;
  makeFindingId(runId: string, ordinal: number): string;
  loadCandidates(): Promise<ReviewCandidate[]>;
  loadFiles(candidate: ReviewCandidate): Promise<PullFile[]>;
  loadCurrentCandidate(repo: string, number: number): Promise<ReviewCandidate | null>;
  startAi(input: StartAutoReviewInput): Promise<void>;
  cancelAi(key: string): Promise<void>;
  inflightKeys(): Promise<string[]>;
  prepareContext(run: AutoReviewRun): Promise<PreparedContext>;
  cleanupContext(context: PreparedContext): Promise<void>;
  aiInstructions(): string;
  codexConfig(setting: AutoReviewRepoSetting): AutomatedCodexConfig;
}

export interface AutoReviewCoordinator {
  start(): Promise<void>;
  reconcile(trigger: AutoReviewTrigger): Promise<void>;
  handleAiDone(event: AiDone): Promise<void>;
}

interface CoordinatorOptions {
  db: AutoReviewDb;
  services: AutoReviewServices;
}

function candidateKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

function validCandidate(candidate: ReviewCandidate): boolean {
  return Boolean(
    candidate.id &&
      candidate.number &&
      candidate.repo.includes("/") &&
      candidate.url &&
      candidate.baseSha &&
      candidate.headSha &&
      !candidate.isDraft,
  );
}

function reviewableDiff(files: PullFile[]): boolean {
  return files.some((file) => parsePatch(file.patch).some((hunk) => hunk.lines.length > 0));
}

function errorMessage(error: unknown, fallback: string): string {
  const hint = firstLineHint(error instanceof Error ? error.message : String(error ?? ""));
  return hint || fallback;
}

export function createAutoReviewCoordinator({
  db,
  services,
}: CoordinatorOptions): AutoReviewCoordinator {
  const contexts = new Map<string, PreparedContext>();
  let tail: Promise<void> = Promise.resolve();

  function serialize(work: () => Promise<void>): Promise<void> {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  }

  async function cleanupRun(runId: string): Promise<void> {
    const context = contexts.get(runId);
    if (!context) return;
    contexts.delete(runId);
    try {
      await services.cleanupContext(context);
    } catch {
      // A cleanup failure must not replace the review's durable terminal state.
    }
  }

  async function failRun(run: AutoReviewRun, code: string, message: string): Promise<void> {
    await db.failRun({ id: run.id, code, message, completedAt: services.now() });
    await cleanupRun(run.id);
  }

  async function cancelRunning(run: AutoReviewRun): Promise<void> {
    if (run.status !== "running") return;
    try {
      await services.cancelAi(autoReviewKey(run.id));
    } catch {
      // Durable state still moves forward if the already-finished task cannot be canceled.
    }
  }

  async function supersedeRun(run: AutoReviewRun, nextHeadSha: string): Promise<void> {
    await cancelRunning(run);
    await db.supersedeRun(run.id, nextHeadSha, services.now());
    await cleanupRun(run.id);
  }

  async function rejectUnstartableRun(
    run: AutoReviewRun,
    current: ReviewCandidate | null,
    setting: AutoReviewRepoSetting | undefined,
  ): Promise<boolean> {
    if (!current) {
      await cancelRunning(run);
      await failRun(run, "assignment_removed", "The review request is no longer assigned to you.");
      return true;
    }
    if (!setting?.enabled) {
      await cancelRunning(run);
      await failRun(
        run,
        "repository_disabled",
        "Automatic review is disabled for this repository.",
      );
      return true;
    }
    if (current.hasPendingReview) {
      await cancelRunning(run);
      await failRun(
        run,
        "existing_draft",
        "A pending GitHub review already exists for this pull request.",
      );
      return true;
    }
    if (!validCandidate(current)) {
      await cancelRunning(run);
      await failRun(
        run,
        "invalid_candidate",
        "The pull request is missing required review metadata.",
      );
      return true;
    }
    return false;
  }

  async function drain(): Promise<void> {
    while (true) {
      const runs = await db.listRuns();
      if (runs.some((run) => run.status === "running")) return;
      const run = await db.claimNextQueuedRun();
      if (!run) return;

      let current: ReviewCandidate | null;
      let settings: AutoReviewRepoSetting[];
      try {
        [current, settings] = await Promise.all([
          services.loadCurrentCandidate(run.repo, run.prNumber),
          db.listRepoSettings(),
        ]);
      } catch (error) {
        await failRun(
          run,
          "candidate_refresh_failed",
          errorMessage(error, "The live pull request state could not be loaded."),
        );
        return;
      }
      const setting = settings.find((item) => item.repo.toLowerCase() === run.repo.toLowerCase());
      if (await rejectUnstartableRun(run, current, setting)) continue;
      if (!current) continue;
      if (current.headSha !== run.headSha) {
        await supersedeRun(run, current.headSha);
        await db.enqueueCandidate(current, "head_changed");
        continue;
      }

      let context: PreparedContext;
      try {
        context = await services.prepareContext(run);
        contexts.set(run.id, context);
      } catch (error) {
        await failRun(
          run,
          "context_unavailable",
          errorMessage(error, "Review context is unavailable."),
        );
        continue;
      }

      let files: PullFile[];
      try {
        files = await services.loadFiles(current);
      } catch (error) {
        await failRun(
          run,
          "diff_load_failed",
          errorMessage(error, "The pull request diff could not be loaded."),
        );
        continue;
      }
      if (!reviewableDiff(files)) {
        await failRun(
          run,
          "diff_unavailable",
          "GitHub did not provide enough patch content for a responsible diff-only review.",
        );
        continue;
      }

      const config = services.codexConfig(setting as AutoReviewRepoSetting);
      await db.setRunExecution(run.id, {
        contextMode: context.contextMode,
        model: config.model ?? null,
        reasoning: config.reasoningEffort ?? null,
      });
      const input: StartAutoReviewInput = {
        run,
        key: autoReviewKey(run.id),
        provider: "codex",
        prompt: buildAutoReviewPrompt({
          aiInstructions: services.aiInstructions(),
          generatedToneProfile: context.generatedToneProfile,
          recentExamples: context.recentExamples,
          contextMode: context.contextMode,
          candidate: current,
          files,
        }),
        headSha: current.headSha,
        cwd: context.cwd,
        ...(config.model ? { model: config.model } : {}),
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(config.timeoutSecs ? { timeoutSecs: config.timeoutSecs } : {}),
      };
      try {
        await services.startAi(input);
        return;
      } catch (error) {
        await failRun(
          run,
          "codex_start_failed",
          errorMessage(error, "Codex could not be started."),
        );
      }
    }
  }

  async function reconcile(trigger: AutoReviewTrigger): Promise<void> {
    const [candidates, settings, runs] = await Promise.all([
      services.loadCandidates(),
      db.listRepoSettings(),
      db.listRuns(),
    ]);
    const candidateByPr = new Map(
      candidates.map((candidate) => [candidateKey(candidate.repo, candidate.number), candidate]),
    );
    const settingByRepo = new Map(settings.map((setting) => [setting.repo.toLowerCase(), setting]));

    for (const run of runs.filter(
      (item) => item.status === "queued" || item.status === "running",
    )) {
      const current = candidateByPr.get(candidateKey(run.repo, run.prNumber)) ?? null;
      const setting = settingByRepo.get(run.repo.toLowerCase());
      if (current && current.headSha !== run.headSha) {
        await supersedeRun(run, current.headSha);
        continue;
      }
      await rejectUnstartableRun(run, current, setting);
    }

    const refreshedRuns = await db.listRuns();
    for (const current of candidates) {
      const setting = settingByRepo.get(current.repo.toLowerCase());
      if (!setting?.enabled || current.hasPendingReview || !validCandidate(current)) continue;
      const priorHead = refreshedRuns.some(
        (run) =>
          run.repo.toLowerCase() === current.repo.toLowerCase() &&
          run.prNumber === current.number &&
          run.headSha !== current.headSha,
      );
      await db.enqueueCandidate(current, priorHead ? "head_changed" : trigger);
    }
    await drain();
  }

  async function handleAiDone(event: AiDone): Promise<void> {
    const task = classifyAiTaskKey(event.key);
    if (task.kind !== "auto-review") return;
    const detail = await db.getRunDetail(task.runId);
    if (!detail || detail.run.status !== "running") return;
    const run = detail.run;
    if (event.canceled) {
      await failRun(run, "canceled", "The automatic review was canceled.");
      await drain();
      return;
    }
    if (!event.ok) {
      await failRun(
        run,
        "codex_failed",
        errorMessage(event.error, "Codex did not complete the review."),
      );
      await drain();
      return;
    }
    let current: ReviewCandidate | null;
    let settings: AutoReviewRepoSetting[];
    try {
      [current, settings] = await Promise.all([
        services.loadCurrentCandidate(run.repo, run.prNumber),
        db.listRepoSettings(),
      ]);
    } catch (error) {
      await failRun(
        run,
        "candidate_refresh_failed",
        errorMessage(error, "The live pull request state could not be loaded."),
      );
      return;
    }
    const setting = settings.find((item) => item.repo.toLowerCase() === run.repo.toLowerCase());
    if (await rejectUnstartableRun(run, current, setting)) {
      await drain();
      return;
    }
    if (!current) return;
    if (current.headSha !== run.headSha || (event.headSha && event.headSha !== run.headSha)) {
      await supersedeRun(run, current.headSha);
      await reconcile("head_changed");
      return;
    }
    const parsed = parseAutoReviewResult(event.output ?? "");
    if (!parsed.ok) {
      if (await db.consumeRepairAttempt(run.id)) {
        try {
          await services.startAi({
            run,
            key: autoReviewKey(run.id),
            provider: "codex",
            prompt: buildRepairPrompt(event.output ?? ""),
            headSha: run.headSha,
            cwd: contexts.get(run.id)?.cwd ?? null,
            ...(run.model ? { model: run.model } : {}),
            ...(run.reasoning ? { reasoningEffort: run.reasoning } : {}),
          });
          return;
        } catch (error) {
          await failRun(
            run,
            "repair_start_failed",
            errorMessage(error, "Codex could not start the repair attempt."),
          );
          await drain();
          return;
        }
      }
      await failRun(run, parsed.code, parsed.message);
      await drain();
      return;
    }

    let files: PullFile[];
    try {
      files = await services.loadFiles(current);
    } catch (error) {
      await failRun(
        run,
        "diff_load_failed",
        errorMessage(error, "The pull request diff could not be reloaded."),
      );
      await drain();
      return;
    }
    if (!reviewableDiff(files)) {
      await failRun(
        run,
        "diff_unavailable",
        "GitHub did not provide enough patch content to validate the review result.",
      );
      await drain();
      return;
    }
    const context = contexts.get(run.id);
    const validated = validateAutoReviewResult({
      value: parsed.value,
      files,
      repo: run.repo,
      number: run.prNumber,
      baseSha: run.baseSha,
      headSha: run.headSha,
      currentHeadSha: current.headSha,
      contextMode: context?.contextMode ?? run.contextMode ?? "diff_only",
    });
    if (!validated.ok) {
      await supersedeRun(run, current.headSha);
      await reconcile("head_changed");
      return;
    }
    await db.completeRun({
      id: run.id,
      contextMode: context?.contextMode ?? run.contextMode ?? "diff_only",
      conclusion: validated.value.conclusion,
      overallComment: validated.value.overallComment,
      toneSampleHash: context?.toneSampleHash ?? null,
      completedAt: services.now(),
      findings: validated.value.findings.map((finding, ordinal) => ({
        ...finding,
        id: services.makeFindingId(run.id, ordinal),
        runId: run.id,
        ordinal,
      })),
      exportError: null,
    });
    await cleanupRun(run.id);
    await drain();
  }

  return {
    start: () =>
      serialize(async () => {
        const inflight = await services.inflightKeys();
        await db.recoverStaleRuns(new Set(inflight));
        await reconcile("launch");
      }),
    reconcile: (trigger) => serialize(() => reconcile(trigger)),
    handleAiDone: (event) => serialize(() => handleAiDone(event)),
  };
}
