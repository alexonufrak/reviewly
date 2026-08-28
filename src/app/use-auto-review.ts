import type { AiDone } from "@/lib/ai/tasks";
import { toReviewCandidate } from "@/lib/auto-review/candidates";
import type { CodexReasoningEffort } from "@/lib/auto-review/config";
import {
  AUTO_REVIEW_WAKE_EVENT,
  type AutoReviewServices,
  type PreparedContext,
  type StartAutoReviewInput,
  createAutoReviewCoordinator,
} from "@/lib/auto-review/coordinator";
import { autoReviewDb } from "@/lib/auto-review/db";
import type { AutoReviewTrigger, ReviewCandidate } from "@/lib/auto-review/types";
import type { Dashboard, PullFile } from "@/lib/tauri";
import { invoke, subscribe } from "@/lib/tauri";
import { codexInvokeArgs } from "@/stores/ai";
import { useAuth } from "@/stores/auth";
import { useReviewPrefs } from "@/stores/review-prefs";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

const SAFETY_INTERVAL_MS = 5 * 60 * 1_000;
const GLOBAL_DASHBOARD_KEY = ["dashboard", ""] as const;
const REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function reasoningOverride(value: string | null): CodexReasoningEffort | null {
  return REASONING_EFFORTS.has(value as CodexReasoningEffort)
    ? (value as CodexReasoningEffort)
    : null;
}

function repoParts(candidate: ReviewCandidate): { owner: string; repo: string } {
  const [owner, repo] = candidate.repo.split("/", 2);
  if (!owner || !repo) throw new Error("The pull request repository is invalid.");
  return { owner, repo };
}

function startBackgroundReview(input: StartAutoReviewInput): Promise<void> {
  return invoke("ai_review_bg", {
    key: input.key,
    provider: input.provider,
    prompt: input.prompt,
    headSha: input.headSha,
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.timeoutSecs ? { timeoutSecs: input.timeoutSecs } : {}),
  });
}

export function useAutoReview() {
  const queryClient = useQueryClient();
  const loading = useAuth((state) => state.loading);
  const signedIn = useAuth((state) => state.signedIn);

  useEffect(() => {
    if (loading || !signedIn) return;
    let disposed = false;
    let unsubscribeAi: (() => void) | null = null;

    const loadCandidates = async (): Promise<ReviewCandidate[]> => {
      const dashboard = await queryClient.fetchQuery({
        queryKey: GLOBAL_DASHBOARD_KEY,
        queryFn: () => invoke<Dashboard>("gh_dashboard", { repoQualifier: "" }),
        staleTime: 0,
      });
      return dashboard.incoming.map(toReviewCandidate);
    };
    const services: AutoReviewServices = {
      now: Date.now,
      makeFindingId: () => crypto.randomUUID(),
      loadCandidates,
      loadCurrentCandidate: async (repo, number) =>
        (await loadCandidates()).find(
          (candidate) =>
            candidate.repo.toLowerCase() === repo.toLowerCase() && candidate.number === number,
        ) ?? null,
      loadFiles: async (candidate) => {
        const { owner, repo } = repoParts(candidate);
        return invoke<PullFile[]>("gh_list_pull_files", { owner, repo, number: candidate.number });
      },
      startAi: startBackgroundReview,
      cancelAi: (key) => invoke("ai_cancel", { key }),
      inflightKeys: () => invoke<string[]>("ai_inflight"),
      prepareContext: async (run): Promise<PreparedContext> => ({
        runId: run.id,
        contextMode: "diff_only",
        cwd: null,
        generatedToneProfile: "",
        recentExamples: [],
        toneSampleHash: null,
      }),
      cleanupContext: async () => {},
      aiInstructions: () => useReviewPrefs.getState().aiInstructions,
      codexConfig: (setting) =>
        codexInvokeArgs({
          model: setting.modelOverride,
          reasoning: reasoningOverride(setting.reasoningOverride),
        }),
    };
    const coordinator = createAutoReviewCoordinator({ db: autoReviewDb, services });
    const refreshRuns = () => queryClient.invalidateQueries({ queryKey: ["auto-review"] });
    const wake = (trigger: AutoReviewTrigger) => {
      if (!disposed) {
        void coordinator
          .reconcile(trigger)
          .catch(() => {})
          .finally(refreshRuns);
      }
    };
    const onCoordinatorWake = (event: Event) => {
      const trigger = (event as CustomEvent<AutoReviewTrigger>).detail;
      wake(trigger ?? "reconnect");
    };
    const onReconnect = () => wake("reconnect");

    window.addEventListener(AUTO_REVIEW_WAKE_EVENT, onCoordinatorWake);
    window.addEventListener("online", onReconnect);
    window.addEventListener("focus", onReconnect);
    const interval = window.setInterval(onReconnect, SAFETY_INTERVAL_MS);

    void (async () => {
      try {
        const unsubscribe = await subscribe<AiDone>("ai:done", (event) => {
          if (!disposed) {
            void coordinator
              .handleAiDone(event.payload)
              .catch(() => {})
              .finally(refreshRuns);
          }
        });
        if (disposed) {
          unsubscribe();
          return;
        }
        unsubscribeAi = unsubscribe;
        await coordinator.start().finally(refreshRuns);
      } catch {
        // Authentication and GitHub connectivity wakes will try reconciliation again.
      }
    })();

    return () => {
      disposed = true;
      unsubscribeAi?.();
      window.clearInterval(interval);
      window.removeEventListener(AUTO_REVIEW_WAKE_EVENT, onCoordinatorWake);
      window.removeEventListener("online", onReconnect);
      window.removeEventListener("focus", onReconnect);
    };
  }, [loading, queryClient, signedIn]);
}
