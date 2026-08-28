import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Notification reasons the desktop poller can alert on (mirror the GitHub
 * Notifications API `reason` field). */
export type NotifReason =
  | "review_requested"
  | "mention"
  | "comment"
  | "ci_activity"
  | "auto_review_findings"
  | "auto_review_clean"
  | "auto_review_limited"
  | "auto_review_failed";

export const NOTIF_REASONS: { id: NotifReason; label: string; description: string }[] = [
  { id: "review_requested", label: "Review requested", description: "A PR asks for your review." },
  { id: "mention", label: "Mentions", description: "You're @-mentioned on a PR or issue." },
  { id: "comment", label: "Comments", description: "New comments on threads you follow." },
  { id: "ci_activity", label: "CI activity", description: "Checks finish on your PRs." },
  {
    id: "auto_review_findings",
    label: "Prepared reviews with findings",
    description: "An automatic review has comments ready to inspect.",
  },
  {
    id: "auto_review_clean",
    label: "Prepared reviews with no concerns",
    description: "An automatic review completed without finding a concern.",
  },
  {
    id: "auto_review_limited",
    label: "Limited-context reviews",
    description: "An automatic review completed without a mapped local clone.",
  },
  {
    id: "auto_review_failed",
    label: "Automatic review failures",
    description: "An automatic review needs attention or a retry.",
  },
];

const DEFAULT_REASONS: Record<NotifReason, boolean> = {
  review_requested: true,
  mention: true,
  comment: true,
  ci_activity: true,
  auto_review_findings: true,
  auto_review_clean: true,
  auto_review_limited: true,
  auto_review_failed: true,
};

/** Desktop (OS) notification settings — distinct from `notif-prefs`, which is
 * the in-app Notifications page filter. Synced to the Rust poller via
 * the existing notification setter commands. */
interface State {
  /** Master gate — show OS notifications at all. */
  desktopEnabled: boolean;
  setDesktopEnabled: (v: boolean) => void;
  /** Which reasons may raise an alert (when desktop notifications are on). */
  reasons: Record<NotifReason, boolean>;
  setReason: (r: NotifReason, on: boolean) => void;
  /** How often the poller checks GitHub, in seconds. */
  pollSecs: number;
  setPollSecs: (s: number) => void;
  /** Suppress OS alerts during a local-time window. */
  quietHoursEnabled: boolean;
  setQuietHoursEnabled: (v: boolean) => void;
  quietHoursStart: string;
  setQuietHoursStart: (v: string) => void;
  quietHoursEnd: string;
  setQuietHoursEnd: (v: string) => void;
}

export const useNotifSettings = create<State>()(
  persist(
    (set) => ({
      desktopEnabled: true,
      setDesktopEnabled: (desktopEnabled) => set({ desktopEnabled }),
      reasons: DEFAULT_REASONS,
      setReason: (r, on) => set((s) => ({ reasons: { ...s.reasons, [r]: on } })),
      pollSecs: 60,
      setPollSecs: (pollSecs) => set({ pollSecs }),
      quietHoursEnabled: false,
      setQuietHoursEnabled: (quietHoursEnabled) => set({ quietHoursEnabled }),
      quietHoursStart: "18:00",
      setQuietHoursStart: (quietHoursStart) => set({ quietHoursStart }),
      quietHoursEnd: "08:00",
      setQuietHoursEnd: (quietHoursEnd) => set({ quietHoursEnd }),
    }),
    {
      name: "reviewly.notif-settings",
      storage: sqlStorage<State>(),
      merge: (persisted, current) => {
        const saved = persisted as Partial<State> | undefined;
        return {
          ...current,
          ...saved,
          reasons: { ...DEFAULT_REASONS, ...saved?.reasons },
        };
      },
    },
  ),
);
