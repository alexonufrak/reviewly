import type { AutoReviewFinding, AutoReviewSide } from "@/lib/auto-review/types";

export interface PrFocusSearch {
  file?: string;
  line?: number;
  side?: AutoReviewSide;
}

export interface ResolvedPrFocus {
  tab: "files";
  activeFile: string;
  view: "unified";
  focusLine: number;
  focusSide: AutoReviewSide;
}

export function findingSearch(
  finding: Pick<AutoReviewFinding, "path" | "line" | "side">,
): Required<PrFocusSearch> {
  return { file: finding.path, line: finding.line, side: finding.side };
}

export function validatePrFocusSearch(value: Record<string, unknown>): PrFocusSearch {
  const file = typeof value.file === "string" ? value.file.trim() : "";
  const rawLine =
    typeof value.line === "number"
      ? value.line
      : typeof value.line === "string" && value.line.trim()
        ? Number(value.line)
        : Number.NaN;
  const line = Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null;
  const side = value.side === "LEFT" || value.side === "RIGHT" ? value.side : null;
  if (!file || line === null || side === null) return {};
  return { file, line, side };
}

export function resolvePrFocus(
  search: PrFocusSearch,
  availableFiles: string[],
): ResolvedPrFocus | null {
  if (!search.file || !search.line || !search.side || !availableFiles.includes(search.file)) {
    return null;
  }
  return {
    tab: "files",
    activeFile: search.file,
    view: "unified",
    focusLine: search.line,
    focusSide: search.side,
  };
}
