export interface WhatsNewItem {
  title: string;
  detail?: string;
}

export interface WhatsNewEntry {
  version: string;
  /** ISO date the version shipped, e.g. "2026-07-05". */
  date?: string;
  items: WhatsNewItem[];
}

/**
 * Release highlights, NEWEST FIRST. Shown in-app after an update (and from
 * About → What's new). Keep in sync with the GitHub release notes; add a new
 * entry at the top for each release. English only (matches the release notes).
 */
export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: "0.1.7",
    date: "2026-07-08",
    items: [
      {
        title: "Detachable AI chat",
        detail: "Pop “Ask about this PR” out into its own resizable window.",
      },
      {
        title: "Configurable AI timeout",
        detail: "Set how long a review or chat may run before it's stopped (Settings → AI review).",
      },
      {
        title: "Redesigned account activity",
        detail: "The contribution heatmap is now full-width and fits without scrolling.",
      },
      {
        title: "This panel",
        detail: "“What's new” now greets you after an update — reopen it any time from About.",
      },
    ],
  },
  {
    version: "0.1.6",
    date: "2026-07-05",
    items: [
      {
        title: "Guided tour always ends with a verdict",
        detail: "Approve, request changes, or comment — each with a one-line reason.",
      },
      {
        title: "Fewer false alarms",
        detail: "Hardened prompting plus a per-concern “Check with AI” against your local clone.",
      },
      {
        title: "AI model selector",
        detail: "Pick a specific model per provider (Claude / Codex / Gemini).",
      },
      {
        title: "Cleaner notifications",
        detail: "No more stale “Review requested” for PRs you’ve already reviewed.",
      },
      {
        title: "Better on large PRs",
        detail: "Prompts stream over stdin with a larger diff budget.",
      },
    ],
  },
];

/** Compare dotted versions: >0 if a>b, <0 if a<b, 0 if equal. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
