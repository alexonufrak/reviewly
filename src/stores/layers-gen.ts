import { create } from "zustand";

/**
 * Tracks layer-plan generations running in the Rust background task, keyed by
 * PR. In-memory only — the source of truth is the backend (`ai_inflight`), which
 * survives navigation/refresh; this just mirrors it for instant UI feedback and
 * holds the last error per PR. The finished plan lands in `useLayers`.
 */
interface State {
  inFlight: Record<string, boolean>;
  error: Record<string, string | undefined>;
  start: (key: string) => void;
  done: (key: string) => void;
  fail: (key: string, message: string) => void;
  /** Forget a previous failure — e.g. the reviewer fell back to the offline split. */
  clear: (key: string) => void;
}

export const useLayersGen = create<State>((set) => ({
  inFlight: {},
  error: {},
  start: (key) =>
    set((s) => ({
      inFlight: { ...s.inFlight, [key]: true },
      error: { ...s.error, [key]: undefined },
    })),
  done: (key) => set((s) => ({ inFlight: { ...s.inFlight, [key]: false } })),
  fail: (key, message) =>
    set((s) => ({
      inFlight: { ...s.inFlight, [key]: false },
      error: { ...s.error, [key]: message },
    })),
  clear: (key) =>
    set((s) => ({
      inFlight: { ...s.inFlight, [key]: false },
      error: { ...s.error, [key]: undefined },
    })),
}));
