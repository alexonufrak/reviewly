/**
 * Defensive JSON extraction for model replies. Every AI surface in the app asks
 * for "a single JSON object and nothing else", and every model occasionally
 * disobeys — a wrapping ```json fence, a trailing comma, a banner line, a
 * truncated array. These helpers turn that near-miss output into something
 * parseable instead of discarding the whole result.
 *
 * Shared by the guided tour and the layered-review planner.
 */

/** Number, or numeric string ("42"), → rounded int; else null. */
export function toInt(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v.trim(), 10) : Number.NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Drop a wrapping ```json … ``` fence, leaving fences *inside* the JSON (in a
 * markdown string field) intact. */
export function stripFence(content: string): string {
  return content
    .trim()
    .replace(/^```[a-z]*\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
}

export function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Repair the single most common LLM JSON defect — a trailing comma before a
    // closing } or ] — and retry once. Benefits the fast path and per-object
    // salvage alike (both go through here).
    try {
      return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

/** Pull every top-level balanced `{…}` object out of `src`, parsing each on its
 * own. A trailing object that's truncated/garbled is simply skipped — so a reply
 * whose JSON got cut off mid-array still yields all the complete entries. */
export function extractObjects(src: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let startIdx = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && startIdx >= 0) {
        const parsed = tryJson(src.slice(startIdx, i + 1));
        if (parsed !== undefined) out.push(parsed);
        startIdx = -1;
      }
    }
  }
  return out;
}

/** First `"key": "…"` string value in `content`, unescaped. "" when absent. */
export function firstString(content: string, key: string): string {
  const m = content.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** Coerce a container value to an array — accepts an array OR an object/map (a
 * common shape when a weaker model "numbers" its entries: `{"0":{…},"1":{…}}`). */
export function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>);
  return [];
}

/** Non-empty strings out of a raw value — accepts an array of strings, or a
 * single string (models often collapse a one-item list). */
export function toStringArray(v: unknown): string[] {
  const raw = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}
