import { FindingCard } from "@/components/auto-review/finding-card";
import { ReviewState } from "@/components/auto-review/review-state";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AutoReviewFinding, AutoReviewRun } from "@/lib/auto-review/types";
import { relativeTime, shortSha } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileSearch,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react";

export function RunHistory({
  runs,
  selectedRunId,
  onSelect,
  onRetry,
  onDelete,
}: {
  runs: AutoReviewRun[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onRetry: (run: AutoReviewRun) => void;
  onDelete: (run: AutoReviewRun) => void;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-background/45">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-hairline px-3">
        <p className="text-xs font-medium text-foreground">Run history</p>
        <span className="text-[11px] tabular-nums text-muted-foreground">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <EmptyState
          icon={Clock3}
          title="No runs yet"
          description="A run starts automatically when this repository is enabled."
          className="h-full px-4"
        />
      ) : (
        <ScrollArea className="flex-1">
          <div className="divide-y divide-hairline">
            {runs.map((run) => (
              <div
                key={run.id}
                className={cn(
                  "group relative transition-colors",
                  selectedRunId === run.id
                    ? "bg-foreground/[0.055]"
                    : "hover:bg-foreground/[0.025]",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(run.id)}
                  className="w-full px-3 py-3 pr-14 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={run.status} />
                    <span className="font-mono text-[11px] text-foreground/80">
                      {shortSha(run.headSha)}
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {relativeTime(run.completedAt ?? run.startedAt ?? run.queuedAt)}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <ReviewState status={run.status} contextMode={run.contextMode} />
                  </div>
                  {run.errorMessage && (
                    <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-destructive/85">
                      {run.errorMessage}
                    </p>
                  )}
                </button>
                <div className="absolute bottom-2.5 right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  {run.status === "failed" && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Retry review"
                      onClick={() => onRetry(run)}
                    >
                      <RotateCcw />
                    </Button>
                  )}
                  {run.status !== "running" && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Delete review run"
                      onClick={() => onDelete(run)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: AutoReviewRun["status"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "running" && "animate-pulse bg-info",
        status === "queued" && "bg-muted-foreground/50",
        status === "completed" && "bg-success",
        status === "failed" && "bg-destructive",
        status === "superseded" && "bg-muted-foreground/30",
      )}
    />
  );
}

export function RunDetail({
  run,
  findings,
  loading,
  onRetry,
  onOpenExactLine,
}: {
  run: AutoReviewRun | null;
  findings: AutoReviewFinding[];
  loading: boolean;
  onRetry: (run: AutoReviewRun) => void;
  onOpenExactLine: (finding: AutoReviewFinding) => void;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-3.5 animate-spin" /> Loading review…
      </div>
    );
  }
  if (!run) {
    return (
      <EmptyState
        icon={FileSearch}
        title="Select a run"
        description="Review findings and exact placement appear here."
        className="h-full"
      />
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-hairline px-4 py-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-foreground/80">
            {shortSha(run.headSha)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {run.completedAt ? relativeTime(run.completedAt) : "In progress"}
          </p>
        </div>
        <div className="ml-auto">
          <ReviewState status={run.status} contextMode={run.contextMode} />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-3xl space-y-4 p-5">
          {run.contextMode === "diff_only" && (
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/20 bg-warning/[0.055] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              Limited context. This review used the GitHub patch only and did not inspect code
              elsewhere in the repository.
            </div>
          )}

          {run.status === "queued" && (
            <ReviewMessage icon={Clock3} title="Waiting to start">
              Reviews run one at a time. This one will start when the current review finishes.
            </ReviewMessage>
          )}
          {run.status === "running" && (
            <ReviewMessage icon={Loader2} title="Reviewing now" spin>
              Codex is preparing a private review. Nothing will be posted to GitHub.
            </ReviewMessage>
          )}
          {run.status === "failed" && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/[0.045] p-4">
              <div className="flex items-start gap-3">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Review needs attention</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {run.errorMessage ?? "The review did not finish."}
                  </p>
                  <Button className="mt-3" size="xs" variant="outline" onClick={() => onRetry(run)}>
                    <RotateCcw /> Retry
                  </Button>
                </div>
              </div>
            </div>
          )}
          {run.status === "superseded" && (
            <ReviewMessage icon={Clock3} title="A newer version is available">
              This result belongs to an older pull request head and cannot be attached to the
              current code.
            </ReviewMessage>
          )}

          {run.status === "completed" && run.overallComment && (
            <section className="rounded-xl border border-hairline bg-foreground/[0.025] p-4">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/65">
                Overall note
              </p>
              <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                {run.overallComment}
              </p>
            </section>
          )}

          {run.status === "completed" && findings.length === 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-success/20 bg-success/[0.045] p-4">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
              <div>
                <p className="text-sm font-medium text-foreground">No concerns surfaced</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Review the diff yourself before deciding whether to approve.
                </p>
              </div>
            </div>
          )}

          {findings.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-base font-medium text-foreground">Findings</h2>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {findings.length} comment{findings.length === 1 ? "" : "s"}
                </span>
              </div>
              {findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} onOpenExactLine={onOpenExactLine} />
              ))}
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ReviewMessage({
  icon: Icon,
  title,
  spin = false,
  children,
}: {
  icon: typeof Clock3;
  title: string;
  spin?: boolean;
  children: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-hairline bg-foreground/[0.025] p-4">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", spin && "animate-spin")}
      />
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
