import { describe, expect, test } from "bun:test";
import { type RawAutoReviewResult, buildRepairPrompt, parseAutoReviewResult } from "./result";

const valid: RawAutoReviewResult = {
  conclusion: "findings",
  overallComment: null,
  findings: [
    {
      category: "correctness",
      confidence: "high",
      path: "src/queue.ts",
      line: 11,
      endLine: 11,
      side: "RIGHT",
      comment: "Could this claim the same job twice when both workers wake together?",
      evidence: "The read and write happen as separate operations.",
    },
  ],
};

describe("automatic review result parser", () => {
  test("accepts a complete findings result", () => {
    expect(parseAutoReviewResult(JSON.stringify(valid))).toEqual({ ok: true, value: valid });
  });

  test("accepts a complete no-concerns result", () => {
    const clean: RawAutoReviewResult = {
      conclusion: "no_concerns",
      overallComment: "looks good from my side",
      findings: [],
    };
    expect(parseAutoReviewResult(JSON.stringify(clean))).toEqual({ ok: true, value: clean });
  });

  test("allows one surrounding JSON fence", () => {
    expect(parseAutoReviewResult(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``).ok).toBe(true);
  });

  test("rejects prose mixed with JSON and truncated JSON", () => {
    expect(parseAutoReviewResult(`Here is the result: ${JSON.stringify(valid)}`)).toMatchObject({
      ok: false,
      code: "malformed_json",
    });
    expect(parseAutoReviewResult(JSON.stringify(valid).slice(0, -8))).toMatchObject({
      ok: false,
      code: "malformed_json",
    });
  });

  test("rejects wrong enums, missing fields, and multiple objects", () => {
    expect(
      parseAutoReviewResult(JSON.stringify({ ...valid, conclusion: "approve" })),
    ).toMatchObject({ ok: false, code: "schema_mismatch" });
    const { findings: _findings, ...missing } = valid;
    expect(parseAutoReviewResult(JSON.stringify(missing))).toMatchObject({
      ok: false,
      code: "schema_mismatch",
    });
    expect(
      parseAutoReviewResult(`${JSON.stringify(valid)} ${JSON.stringify(valid)}`),
    ).toMatchObject({
      ok: false,
      code: "malformed_json",
    });
  });

  test("builds one bounded repair instruction with the strict schema", () => {
    const prompt = buildRepairPrompt("not json");
    expect(prompt).toContain('"enum":["findings","no_concerns"]');
    expect(prompt).toContain("not json");
    expect(prompt).toContain("Return only the corrected JSON object");
  });
});
