/** What a stop on the guided tour is about. */
export type StepKind = "orient" | "concern" | "question" | "praise";

/** One stop on the guided reading tour of a PR. */
export interface GuidedStep {
  path: string;
  /** New-file line the step anchors to. */
  line: number;
  /** Optional last line of the relevant range (for multi-line stops). */
  endLine?: number;
  kind: StepKind;
  title: string;
  /** Narration: what this code does / why we're here, in the flow (markdown). */
  detail: string;
  /** Optional ready-to-post review comment (only when the stop deserves one). */
  suggestion?: string;
}

/** The tour's overall recommendation, surfaced as a suggested review verdict. */
export type GuidedVerdict = "approve" | "request_changes" | "comment";

export interface GuidedPlan {
  /** One sentence: what this PR does. */
  summary: string;
  /** The reading strategy — where to start and why this order (markdown). */
  tour: string;
  /** Optional overall recommendation after the walkthrough. */
  verdict?: GuidedVerdict;
  /** One-sentence justification for the verdict (why approve / what blocks). */
  verdictReason?: string;
  steps: GuidedStep[];
}

/** Coerce a raw verdict string to a known value, or undefined. */
function toVerdict(v: unknown): GuidedVerdict | undefined {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "";
  return s === "approve" || s === "request_changes" || s === "comment" ? s : undefined;
}

const KINDS = new Set<StepKind>(["orient", "concern", "question", "praise"]);

/** Near-miss kind words → canonical. A genuinely-unknown *non-empty* kind
 * defaults to "concern" (below) so a flagged risk is never silently downgraded
 * to a neutral orientation stop with no warning color and no "Check with AI". */
const KIND_SYNONYMS: Record<string, StepKind> = {
  warning: "concern",
  issue: "concern",
  bug: "concern",
  risk: "concern",
  problem: "concern",
  caution: "concern",
  nit: "concern",
  ask: "question",
  clarify: "question",
  clarification: "question",
  good: "praise",
  nice: "praise",
  kudos: "praise",
  positive: "praise",
  overview: "orient",
  context: "orient",
  note: "orient",
  info: "orient",
  intro: "orient",
};

function toKind(raw: unknown): StepKind {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (KINDS.has(s as StepKind)) return s as StepKind;
  if (s && s in KIND_SYNONYMS) return KIND_SYNONYMS[s];
  // Empty/missing → neutral orient; unknown-but-present → concern (over-flag,
  // never hide).
  return s ? "concern" : "orient";
}

/** Number, or numeric string ("42"), → rounded int; else null. */
function toInt(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v.trim(), 10) : Number.NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Normalize one raw step object → GuidedStep, or null if it lacks a usable
 * path + line anchor. Tolerant of numeric-string lines and near-miss kinds. */
function toStep(p: unknown): GuidedStep | null {
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.path !== "string" || !o.path.trim()) return null;
  const parsedLine = toInt(o.line);
  if (parsedLine === null) return null;
  const line = Math.max(1, parsedLine);
  const parsedEnd = toInt(o.endLine);
  const endLine = parsedEnd !== null && parsedEnd >= line ? parsedEnd : undefined;
  const suggestion =
    typeof o.suggestion === "string" && o.suggestion.trim() ? o.suggestion : undefined;
  return {
    path: o.path,
    line,
    endLine,
    kind: toKind(o.kind),
    title: typeof o.title === "string" && o.title.trim() ? o.title : o.path,
    detail: typeof o.detail === "string" ? o.detail : "",
    suggestion,
  };
}

/** Coerce a steps value to an array — accepts an array OR an object/map (a
 * common shape when a weaker model "numbers" its steps: `{"0":{…},"1":{…}}`). */
function toStepArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>);
  return [];
}

function tryJson(s: string): unknown {
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
 * own. A trailing object that's truncated/garbled is simply skipped — so a tour
 * whose JSON got cut off mid-array still yields all the complete steps. */
function extractObjects(src: string): unknown[] {
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

function firstString(content: string, key: string): string {
  const m = content.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** Last-ditch recovery when the reply isn't valid JSON: scrape the steps array
 * and the top-level summary/tour by hand so a near-complete tour still renders.
 * summary/tour are scraped only from the HEADER (before the steps array) so a
 * nested step key named `summary`/`tour` can't masquerade as the plan header. */
function salvage(content: string): { summary: string; tour: string; steps: unknown[] } | null {
  const m = content.match(/"(?:steps|points)"\s*:\s*[[{]/);
  if (!m || m.index === undefined) return null;
  // The last char of the match is the opening `[` or `{` of the steps container.
  const bracketIdx = m.index + m[0].length - 1;
  const header = content.slice(0, m.index);
  const steps = extractObjects(content.slice(bracketIdx + 1));
  if (steps.length === 0) return null;
  return {
    summary: firstString(header, "summary"),
    tour: firstString(header, "tour"),
    steps,
  };
}

/** Pull the JSON guided-tour plan out of the model's reply. Defense-in-depth so
 * imperfect model output degrades gracefully instead of discarding the tour:
 * strips a wrapping ```json fence, prefers the LAST balanced {…} that carries
 * steps (robust to trailing prose / a second illustrative object), repairs
 * trailing commas, coerces a steps-map to an array and string lines to numbers,
 * normalizes near-miss kinds, salvages a truncated array, and de-dups. Accepts
 * both the `steps` and the older `points` shape. */
export function parseGuided(content: string): GuidedPlan | null {
  // De-fence a wrapping ```json … ``` while leaving internal markdown fences
  // (inside a step's `detail`) intact.
  const s = content
    .trim()
    .replace(/^```[a-z]*\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");

  let summary = "";
  let tour = "";
  let verdict: GuidedVerdict | undefined;
  let verdictReason = "";
  let rawSteps: unknown[] = [];

  // Prefer the LAST balanced top-level {…} that actually carries steps — robust
  // to trailing prose, a banner line, or a second illustrative JSON object
  // (gemini has no final-message isolation, so this is its dominant failure).
  const objs = extractObjects(s);
  const planObj = [...objs].reverse().find((o) => {
    if (!o || typeof o !== "object") return false;
    const r = o as Record<string, unknown>;
    return toStepArray(r.steps).length > 0 || toStepArray(r.points).length > 0;
  }) as Record<string, unknown> | undefined;

  const obj =
    planObj ??
    (() => {
      const start = s.indexOf("{");
      const end = s.lastIndexOf("}");
      return start >= 0 && end > start ? tryJson(s.slice(start, end + 1)) : undefined;
    })();

  if (obj && typeof obj === "object") {
    const r = obj as Record<string, unknown>;
    rawSteps = toStepArray(r.steps);
    if (rawSteps.length === 0) rawSteps = toStepArray(r.points);
    summary = typeof r.summary === "string" ? r.summary : "";
    tour = typeof r.tour === "string" ? r.tour : "";
    verdict = toVerdict(r.verdict);
    verdictReason = typeof r.verdictReason === "string" ? r.verdictReason : "";
  }

  // Salvage: the object was unparseable, or valid but carried no steps. A failed
  // salvage is NOT fatal on its own — a legitimate "nothing to walk through"
  // tour (summary + verdict, no stops) is accepted at the end.
  if (rawSteps.length === 0) {
    const recovered = salvage(s);
    if (recovered) {
      rawSteps = recovered.steps;
      if (!summary) summary = recovered.summary;
      if (!tour) tour = recovered.tour;
    }
  }
  // Scrape verdict / reason from the header if the structured parse missed them.
  if (!verdict || !verdictReason) {
    const arrIdx = s.search(/"(?:steps|points)"\s*:/);
    const header = arrIdx > 0 ? s.slice(0, arrIdx) : s;
    if (!verdict) verdict = toVerdict(firstString(header, "verdict"));
    if (!verdictReason) verdictReason = firstString(header, "verdictReason");
  }

  // Normalize + de-dup by path:line:title so redundant stops don't clutter the
  // timeline.
  const seen = new Set<string>();
  const steps: GuidedStep[] = [];
  for (const p of rawSteps) {
    const step = toStep(p);
    if (!step) continue;
    const sig = `${step.path}:${step.line}:${step.title}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    steps.push(step);
  }
  // A "clean bill of health" tour has no stops but still a real summary and an
  // explicit verdict — render it rather than failing. Require BOTH so a garbled
  // reply with only a stray "summary" isn't mistaken for a no-op tour.
  if (steps.length === 0) {
    if (summary.trim() && verdict) return { summary, tour, verdict, verdictReason, steps: [] };
    return null;
  }
  return { summary, tour, verdict, verdictReason, steps };
}
