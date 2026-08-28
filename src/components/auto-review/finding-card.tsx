import { Button } from "@/components/ui/button";
import type { AutoReviewFinding } from "@/lib/auto-review/types";
import { cn } from "@/lib/utils";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const CATEGORY_LABEL: Record<AutoReviewFinding["category"], string> = {
  correctness: "Correctness",
  security: "Security",
  data: "Data",
  concurrency: "Concurrency",
  performance: "Performance",
  maintainability: "Maintainability",
  test_coverage: "Test coverage",
  question: "Question",
};

export function FindingCard({
  finding,
  onOpenExactLine,
}: {
  finding: AutoReviewFinding;
  onOpenExactLine: (finding: AutoReviewFinding) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyComment() {
    try {
      await navigator.clipboard.writeText(finding.comment);
      setCopied(true);
      toast.success("Comment copied");
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Could not copy the comment");
    }
  }

  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-xl border border-hairline bg-card shadow-sm/5",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        finding.confidence === "high"
          ? "before:bg-destructive/75"
          : finding.confidence === "medium"
            ? "before:bg-warning/80"
            : "before:bg-muted-foreground/45",
      )}
    >
      <div className="border-b border-hairline bg-foreground/[0.018] px-4 py-2.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">{CATEGORY_LABEL[finding.category]}</span>
          <span className="capitalize">{finding.confidence} confidence</span>
          <span className="ml-auto min-w-0 truncate font-mono text-[10px]">
            {finding.path}:{finding.line}
            {finding.endLine > finding.line ? `–${finding.endLine}` : ""} {finding.side}
          </span>
        </div>
      </div>
      <div className="space-y-3 px-4 py-3.5">
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {finding.comment}
        </p>
        {finding.evidence && (
          <div className="border-l border-hairline pl-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/65">
              Why this surfaced
            </p>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {finding.evidence}
            </p>
          </div>
        )}
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="xs" variant="outline" onClick={copyComment}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onOpenExactLine(finding)}>
            <ArrowUpRight />
            Open exact line
          </Button>
        </div>
      </div>
    </article>
  );
}
