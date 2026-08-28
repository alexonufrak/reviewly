import { Badge } from "@/components/ui/badge";
import type { AutoReviewContextMode, AutoReviewStatus } from "@/lib/auto-review/types";

interface ReviewStateInput {
  status?: AutoReviewStatus | null;
  contextMode?: AutoReviewContextMode | null;
  hasPendingReview?: boolean;
}

const STATUS_LABEL: Record<AutoReviewStatus, string> = {
  queued: "Queued",
  running: "Reviewing",
  completed: "Ready",
  failed: "Needs attention",
  superseded: "Superseded",
};

export function reviewStateLabels(input: ReviewStateInput): string[] {
  const labels: string[] = [];
  if (input.status) labels.push(STATUS_LABEL[input.status]);
  if (input.contextMode === "diff_only") labels.push("Limited context");
  if (input.hasPendingReview) labels.push("Existing draft");
  return labels;
}

function variant(
  label: string,
): "secondary" | "info" | "success" | "error" | "outline" | "warning" {
  switch (label) {
    case "Reviewing":
      return "info";
    case "Ready":
      return "success";
    case "Needs attention":
      return "error";
    case "Superseded":
      return "outline";
    case "Limited context":
      return "warning";
    default:
      return "secondary";
  }
}

export function ReviewState(input: ReviewStateInput) {
  const labels = reviewStateLabels(input);
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <Badge key={label} variant={variant(label)} size="sm">
          {label}
        </Badge>
      ))}
    </div>
  );
}
