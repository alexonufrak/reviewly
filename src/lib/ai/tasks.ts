const GUIDED_PREFIX = "guided:";
const LAYERS_PREFIX = "layers:";
const AUTO_REVIEW_PREFIX = "auto-review:";

export interface AiDone {
  key: string;
  ok: boolean;
  output?: string;
  error?: string;
  provider?: string;
  headSha?: string;
  canceled?: boolean;
}

export type AiTaskKey =
  | { kind: "guided"; storeKey: string }
  | { kind: "layers"; storeKey: string }
  | { kind: "auto-review"; runId: string }
  | { kind: "unknown" };

export function guidedKey(storeKey: string): string {
  return `${GUIDED_PREFIX}${storeKey}`;
}

export function layersKey(storeKey: string): string {
  return `${LAYERS_PREFIX}${storeKey}`;
}

export function autoReviewKey(runId: string): string {
  return `${AUTO_REVIEW_PREFIX}${runId}`;
}

function validStoreKey(value: string): boolean {
  return /^[^/]+\/[^#]+#\d+$/.test(value);
}

export function classifyAiTaskKey(key: string): AiTaskKey {
  if (key.startsWith(GUIDED_PREFIX)) {
    const storeKey = key.slice(GUIDED_PREFIX.length);
    return validStoreKey(storeKey) ? { kind: "guided", storeKey } : { kind: "unknown" };
  }
  if (key.startsWith(LAYERS_PREFIX)) {
    const storeKey = key.slice(LAYERS_PREFIX.length);
    return validStoreKey(storeKey) ? { kind: "layers", storeKey } : { kind: "unknown" };
  }
  if (key.startsWith(AUTO_REVIEW_PREFIX)) {
    const runId = key.slice(AUTO_REVIEW_PREFIX.length);
    return runId ? { kind: "auto-review", runId } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

export function firstLineHint(raw: string): string {
  const first =
    raw
      .trim()
      .split("\n")
      .find((line) => line.trim()) ?? "";
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}
