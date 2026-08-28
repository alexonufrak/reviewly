import { ReviewState } from "@/components/auto-review/review-state";
import { EmptyState } from "@/components/empty-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AutoReviewRepoOption } from "@/lib/auto-review/config";
import type { AutoReviewRun } from "@/lib/auto-review/types";
import type { InboxItem } from "@/lib/dashboard";
import { shortAge } from "@/lib/dashboard";
import { cn } from "@/lib/utils";
import { CircleAlert, Cloud, GitPullRequest, Inbox, Laptop, Radio } from "lucide-react";

export interface ReviewQueueEntry {
  key: string;
  repo: string;
  number: number;
  title: string;
  inbox: InboxItem | null;
  latestRun: AutoReviewRun | null;
  enabled: boolean;
  context: AutoReviewRepoOption["context"];
}

export function ReviewQueue({
  entries,
  selectedKey,
  onSelect,
}: {
  entries: ReviewQueueEntry[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-sidebar/15">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-hairline px-3">
        <p className="text-xs font-medium text-foreground">Review requests</p>
        <span className="text-[11px] tabular-nums text-muted-foreground">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No review requests"
          description="Enabled repositories appear here when GitHub asks for your review."
          className="h-full px-4"
        />
      ) : (
        <ScrollArea className="flex-1">
          <div className="divide-y divide-hairline">
            {entries.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => onSelect(entry.key)}
                aria-pressed={selectedKey === entry.key}
                className={cn(
                  "group relative w-full px-3 py-3 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary",
                  selectedKey === entry.key ? "bg-primary/[0.09]" : "hover:bg-foreground/[0.035]",
                )}
              >
                <span
                  className={cn(
                    "absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary transition-opacity",
                    selectedKey === entry.key ? "opacity-100" : "opacity-0",
                  )}
                />
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <GitPullRequest className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{entry.repo}</span>
                  <span className="shrink-0 tabular-nums">#{entry.number}</span>
                  {entry.inbox?.updatedAt && (
                    <span className="ml-auto shrink-0 tabular-nums">
                      {shortAge(entry.inbox.updatedAt).label}
                    </span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-xs font-medium leading-relaxed text-foreground">
                  {entry.title}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <ReviewState
                    status={entry.latestRun?.status}
                    contextMode={entry.latestRun?.contextMode}
                    hasPendingReview={entry.inbox?.hasPendingReview}
                  />
                  {!entry.enabled && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Radio className="size-2.5" /> Off
                    </span>
                  )}
                  {!entry.latestRun?.contextMode && <ContextLabel context={entry.context} />}
                </div>
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function ContextLabel({ context }: { context: AutoReviewRepoOption["context"] }) {
  if (context === "full") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-success">
        <Laptop className="size-2.5" /> Local clone
      </span>
    );
  }
  if (context === "invalid") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-warning">
        <CircleAlert className="size-2.5" /> Clone needs attention
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <Cloud className="size-2.5" /> Patch only
    </span>
  );
}
