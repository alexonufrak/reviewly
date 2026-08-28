import type { DashboardPr } from "@/lib/tauri";

const DAY = 86_400_000;

export type Priority = "critical" | "high" | "normal" | "low";

export interface InboxItem extends DashboardPr {
  owner: string;
  repoName: string;
  priority: Priority;
  waitingDays: number;
  blocked: boolean;
}

export function fromPr(pr: DashboardPr, now = Date.now()): InboxItem {
  const [owner, repoName] = pr.repo.split("/");
  const waitingDays = ageDays(pr.updatedAt ?? pr.createdAt, now);
  const blocked = isBlocked(pr);
  return {
    ...pr,
    owner: owner ?? "",
    repoName: repoName ?? "",
    priority: priorityFor(pr, waitingDays, blocked),
    waitingDays,
    blocked,
  };
}

export function ageDays(iso?: string | null, now = Date.now()): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - +new Date(iso)) / DAY));
}

export function shortAge(iso?: string | null, now = Date.now()): { label: string; aging: boolean } {
  if (!iso) return { label: "", aging: false };
  const elapsed = now - +new Date(iso);
  const days = Math.floor(elapsed / DAY);
  if (days >= 1) return { label: `${days}d`, aging: days > 7 };
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours >= 1) return { label: `${hours}h`, aging: false };
  return { label: "now", aging: false };
}

export function isBlocked(pr: DashboardPr): boolean {
  return (
    pr.ci === "failure" ||
    pr.conflicting ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    pr.unresolvedThreadCount > 0
  );
}

export function priorityFor(
  pr: DashboardPr,
  waitingDays = ageDays(pr.updatedAt ?? pr.createdAt),
  blocked = isBlocked(pr),
): Priority {
  if (waitingDays > 7 || (blocked && waitingDays > 3)) return "critical";
  if (
    pr.ci === "failure" ||
    pr.conflicting ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    pr.unresolvedThreadCount > 0 ||
    (waitingDays >= 4 && waitingDays <= 7)
  ) {
    return "high";
  }
  if ((waitingDays >= 1 && waitingDays <= 3) || pr.ci === "pending") return "normal";
  return "low";
}

const PRIORITY_WEIGHT: Record<Priority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function byPriorityThenAge(a: InboxItem, b: InboxItem): number {
  return (
    PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] ||
    +new Date(a.updatedAt ?? a.createdAt ?? 0) - +new Date(b.updatedAt ?? b.createdAt ?? 0)
  );
}
