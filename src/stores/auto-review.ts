import { AUTO_REVIEW_DEFAULTS } from "@/lib/auto-review/config";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface State {
  artifactDirectoryName: string;
  setArtifactDirectoryName: (value: string) => void;
  toneLookbackDays: number;
  setToneLookbackDays: (value: number) => void;
  toneSampleLimit: number;
  setToneSampleLimit: (value: number) => void;
  toneRefreshHours: number;
  setToneRefreshHours: (value: number) => void;
}

export const useAutoReviewSettings = create<State>()(
  persist(
    (set) => ({
      ...AUTO_REVIEW_DEFAULTS,
      setArtifactDirectoryName: (artifactDirectoryName) => set({ artifactDirectoryName }),
      setToneLookbackDays: (toneLookbackDays) => set({ toneLookbackDays }),
      setToneSampleLimit: (toneSampleLimit) => set({ toneSampleLimit }),
      setToneRefreshHours: (toneRefreshHours) => set({ toneRefreshHours }),
    }),
    { name: "reviewly.auto-review", storage: sqlStorage<State>() },
  ),
);
