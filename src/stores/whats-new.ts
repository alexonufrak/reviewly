import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface State {
  /** The app version whose "What's new" the user has already seen. `null` until
   * the first launch is recorded — a fresh install seeds it silently, so the
   * panel only auto-opens after a genuine update (an older seen → newer app). */
  lastSeenVersion: string | null;
  markSeen: (version: string) => void;
}

export const useWhatsNew = create<State>()(
  persist(
    (set) => ({
      lastSeenVersion: null,
      markSeen: (lastSeenVersion) => set({ lastSeenVersion }),
    }),
    { name: "reviewly.whats-new", storage: sqlStorage<State>() },
  ),
);
