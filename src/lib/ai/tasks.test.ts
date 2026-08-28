import { describe, expect, test } from "bun:test";
import { autoReviewKey, classifyAiTaskKey, firstLineHint, guidedKey, layersKey } from "./tasks";

describe("background AI task routing", () => {
  test("constructs and parses every task class", () => {
    expect(classifyAiTaskKey(guidedKey("acme/api#12"))).toEqual({
      kind: "guided",
      storeKey: "acme/api#12",
    });
    expect(classifyAiTaskKey(layersKey("acme/api#12"))).toEqual({
      kind: "layers",
      storeKey: "acme/api#12",
    });
    expect(classifyAiTaskKey(autoReviewKey("run-123"))).toEqual({
      kind: "auto-review",
      runId: "run-123",
    });
  });

  test("each listener class accepts only its own task keys", () => {
    const keys = [guidedKey("acme/api#12"), layersKey("acme/api#12"), autoReviewKey("run-123")];
    const classified = keys.map(classifyAiTaskKey);

    expect(classified.filter((task) => task.kind === "guided")).toHaveLength(1);
    expect(classified.filter((task) => task.kind === "layers")).toHaveLength(1);
    expect(classified.filter((task) => task.kind === "auto-review")).toHaveLength(1);
  });

  test("rejects unclassified or empty task keys", () => {
    expect(classifyAiTaskKey("acme/api#12")).toEqual({ kind: "unknown" });
    expect(classifyAiTaskKey("guided:")).toEqual({ kind: "unknown" });
    expect(classifyAiTaskKey("layers:")).toEqual({ kind: "unknown" });
    expect(classifyAiTaskKey("auto-review:")).toEqual({ kind: "unknown" });
  });

  test("summarizes the first useful line without leaking a long payload", () => {
    expect(firstLineHint("\n\nshort reason\nmore detail")).toBe("short reason");
    expect(firstLineHint("x".repeat(200))).toBe(`${"x".repeat(157)}…`);
  });
});
