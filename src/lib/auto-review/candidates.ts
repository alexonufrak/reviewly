import type { ReviewCandidate } from "@/lib/auto-review/types";
import type { DashboardPr } from "@/lib/tauri";

export type CandidateDisposition =
  | { kind: "eligible"; candidate: ReviewCandidate }
  | { kind: "disabled" }
  | { kind: "existing_draft" }
  | { kind: "invalid"; reason: string };

export type CandidateGateResult<T> =
  | Exclude<CandidateDisposition, { kind: "eligible" }>
  | { kind: "eligible"; candidate: ReviewCandidate; files: T };

export function toReviewCandidate(pr: DashboardPr): ReviewCandidate {
  return {
    id: pr.id,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    authorLogin: pr.author,
    authorAvatar: pr.avatar,
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    hasPendingReview: pr.hasPendingReview,
  };
}

export function classifyCandidate(pr: DashboardPr, enabled: boolean): CandidateDisposition {
  if (!enabled) return { kind: "disabled" };
  if (pr.hasPendingReview) return { kind: "existing_draft" };
  if (!pr.headSha || !pr.baseSha) {
    return { kind: "invalid", reason: "missing head or base SHA" };
  }
  if (pr.isDraft) return { kind: "invalid", reason: "pull request is still a draft" };
  if (!pr.id || !pr.number || !pr.repo.includes("/") || !pr.url) {
    return { kind: "invalid", reason: "missing pull request identity" };
  }
  return { kind: "eligible", candidate: toReviewCandidate(pr) };
}

/** Apply cheap candidate guards before invoking an expensive diff loader. */
export async function gateCandidate<T>(
  pr: DashboardPr,
  enabled: boolean,
  loadFiles: (candidate: ReviewCandidate) => Promise<T>,
): Promise<CandidateGateResult<T>> {
  const disposition = classifyCandidate(pr, enabled);
  if (disposition.kind !== "eligible") return disposition;
  return {
    ...disposition,
    files: await loadFiles(disposition.candidate),
  };
}
