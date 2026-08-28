import { describe, expect, test } from "bun:test";
import { parseLocalTime } from "./quiet-hours";

describe("parseLocalTime", () => {
  test("converts local HH:mm values to minutes after midnight", () => {
    expect(parseLocalTime("00:00")).toBe(0);
    expect(parseLocalTime("08:15")).toBe(495);
    expect(parseLocalTime("23:59")).toBe(1439);
  });

  test("rejects invalid or non-canonical values", () => {
    expect(parseLocalTime("24:00")).toBeNull();
    expect(parseLocalTime("9:00")).toBeNull();
    expect(parseLocalTime("09:60")).toBeNull();
    expect(parseLocalTime("noon")).toBeNull();
  });
});
