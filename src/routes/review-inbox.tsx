import { ReviewQueue, type ReviewQueueEntry } from "@/components/auto-review/review-queue";
import { RunDetail, RunHistory } from "@/components/auto-review/run-detail";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { collectAutoReviewRepos } from "@/lib/auto-review/config";
import { AUTO_REVIEW_WAKE_EVENT } from "@/lib/auto-review/coordinator";
import { autoReviewDb } from "@/lib/auto-review/db";
import { findingSearch } from "@/lib/auto-review/navigation";
import type { AutoReviewFinding, AutoReviewRun, AutoReviewTrigger } from "@/lib/auto-review/types";
import { byPriorityThenAge, fromPr } from "@/lib/dashboard";
import type { Dashboard } from "@/lib/tauri";
import { invoke } from "@/lib/tauri";
import { useLocalRepos } from "@/stores/local-repos";
import { useUi } from "@/stores/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Inbox, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const RUNS_QUERY_KEY = ["auto-review", "runs"] as const;
const SETTINGS_QUERY_KEY = ["auto-review-repo-settings"] as const;

function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

function wakeCoordinator(trigger: AutoReviewTrigger) {
  window.dispatchEvent(new CustomEvent(AUTO_REVIEW_WAKE_EVENT, { detail: trigger }));
}

export function ReviewInboxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const localRepos = useLocalRepos((state) => state.repos);
  const setSettingsOpen = useUi((state) => state.setSettingsOpen);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AutoReviewRun | null>(null);

  const dashboard = useQuery({
    queryKey: ["dashboard", ""],
    queryFn: () => invoke<Dashboard>("gh_dashboard", { repoQualifier: "" }),
    staleTime: 60_000,
  });
  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => autoReviewDb.listRepoSettings(),
  });
  const runs = useQuery({
    queryKey: RUNS_QUERY_KEY,
    queryFn: () => autoReviewDb.listRuns(),
    refetchOnWindowFocus: true,
  });

  const entries = useMemo<ReviewQueueEntry[]>(() => {
    const incoming = (dashboard.data?.incoming ?? []).map(fromPr).sort(byPriorityThenAge);
    const allRuns = runs.data ?? [];
    const keys = new Set(incoming.map((item) => prKey(item.repo, item.number)));
    for (const run of allRuns) keys.add(prKey(run.repo, run.prNumber));
    const settingsByRepo = new Map(
      (settings.data ?? []).map((setting) => [setting.repo.toLowerCase(), setting]),
    );
    const contextByRepo = new Map(
      collectAutoReviewRepos({
        watched: [],
        incoming: [
          ...new Set([...incoming.map((item) => item.repo), ...allRuns.map((run) => run.repo)]),
        ],
        local: localRepos,
      }).map((option) => [option.repo.toLowerCase(), option.context]),
    );
    const incomingByKey = new Map(incoming.map((item) => [prKey(item.repo, item.number), item]));
    const result = [...keys].map((key) => {
      const inbox = incomingByKey.get(key) ?? null;
      const history = allRuns
        .filter((run) => prKey(run.repo, run.prNumber) === key)
        .sort((left, right) => right.queuedAt - left.queuedAt);
      const latestRun = history.find((run) => run.status !== "superseded") ?? history[0] ?? null;
      return {
        key,
        repo: inbox?.repo ?? latestRun?.repo ?? "",
        number: inbox?.number ?? latestRun?.prNumber ?? 0,
        title: inbox?.title ?? latestRun?.prTitle ?? "Untitled pull request",
        inbox,
        latestRun,
        enabled:
          settingsByRepo.get((inbox?.repo ?? latestRun?.repo ?? "").toLowerCase())?.enabled ??
          false,
        context:
          contextByRepo.get((inbox?.repo ?? latestRun?.repo ?? "").toLowerCase()) ?? "limited",
      } satisfies ReviewQueueEntry;
    });
    const statusWeight: Record<AutoReviewRun["status"], number> = {
      running: 0,
      queued: 1,
      failed: 2,
      completed: 3,
      superseded: 4,
    };
    return result.sort((left, right) => {
      if (left.inbox && right.inbox) return byPriorityThenAge(left.inbox, right.inbox);
      if (left.inbox) return -1;
      if (right.inbox) return 1;
      return (
        statusWeight[left.latestRun?.status ?? "superseded"] -
          statusWeight[right.latestRun?.status ?? "superseded"] ||
        (right.latestRun?.queuedAt ?? 0) - (left.latestRun?.queuedAt ?? 0)
      );
    });
  }, [dashboard.data?.incoming, localRepos, runs.data, settings.data]);

  useEffect(() => {
    if (entries.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !entries.some((entry) => entry.key === selectedKey)) {
      setSelectedKey(entries[0].key);
    }
  }, [entries, selectedKey]);

  const selectedRuns = useMemo(
    () =>
      (runs.data ?? [])
        .filter((run) => prKey(run.repo, run.prNumber) === selectedKey)
        .sort(
          (left, right) =>
            Number(left.status === "superseded") - Number(right.status === "superseded") ||
            right.queuedAt - left.queuedAt,
        ),
    [runs.data, selectedKey],
  );

  useEffect(() => {
    if (selectedRuns.length === 0) {
      setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !selectedRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(selectedRuns[0].id);
    }
  }, [selectedRunId, selectedRuns]);

  const detail = useQuery({
    queryKey: ["auto-review", "detail", selectedRunId],
    queryFn: () => autoReviewDb.getRunDetail(selectedRunId as string),
    enabled: Boolean(selectedRunId),
  });

  useEffect(() => {
    const run = detail.data?.run;
    if (!run || run.status !== "completed" || run.viewedAt !== null) return;
    void autoReviewDb
      .markRunViewed(run.id, Date.now())
      .then(() => queryClient.invalidateQueries({ queryKey: ["auto-review"] }));
  }, [detail.data?.run, queryClient]);

  const retry = useMutation({
    mutationFn: (run: AutoReviewRun) => autoReviewDb.retryRun(run.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["auto-review"] });
      wakeCoordinator("retry");
      toast.success("Review queued again");
    },
    onError: () => toast.error("Could not retry the review"),
  });
  const remove = useMutation({
    mutationFn: (run: AutoReviewRun) => autoReviewDb.deleteRun(run.id),
    onSuccess: async () => {
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["auto-review"] });
      toast.success("Review run deleted");
    },
    onError: () => toast.error("Could not delete the review run"),
  });

  function openExactLine(finding: AutoReviewFinding) {
    const run = detail.data?.run;
    if (!run) return;
    const [owner, repo] = run.repo.split("/", 2);
    if (!owner || !repo) return;
    void navigate({
      to: "/prs/$owner/$repo/$number",
      params: { owner, repo, number: String(run.prNumber) },
      search: findingSearch(finding),
    });
  }

  const loading = dashboard.isLoading || settings.isLoading || runs.isLoading;
  const failed = dashboard.isError && runs.isError;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <PageHeader
        title="Review inbox"
        subtitle="Prepared locally. Nothing is posted to GitHub."
        actions={
          <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2 /> Configure
          </Button>
        }
      />
      <div className="min-h-0 flex-1 border-t border-hairline">
        {failed ? (
          <EmptyState
            icon={Inbox}
            title="Review inbox is unavailable"
            description="GitHub and the local review history could not be loaded."
            className="h-full"
          />
        ) : loading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading review inbox…
          </div>
        ) : (
          <ResizablePanelGroup direction="horizontal" className="min-h-0">
            <ResizablePanel defaultSize={24} minSize={19}>
              <ReviewQueue entries={entries} selectedKey={selectedKey} onSelect={setSelectedKey} />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={24} minSize={19}>
              <RunHistory
                runs={selectedRuns}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
                onRetry={(run) => retry.mutate(run)}
                onDelete={setPendingDelete}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel minSize={36}>
              <RunDetail
                run={detail.data?.run ?? null}
                findings={detail.data?.findings ?? []}
                loading={detail.isLoading}
                onRetry={(run) => retry.mutate(run)}
                onOpenExactLine={openExactLine}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this review run?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the local result and its findings. It does not change anything on GitHub.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button size="sm" variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant="destructive"
              loading={remove.isPending}
              onClick={() => pendingDelete && remove.mutate(pendingDelete)}
            >
              Delete run
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
