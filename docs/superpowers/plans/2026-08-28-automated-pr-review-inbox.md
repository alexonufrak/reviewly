# Automated PR Review Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Reviewly so an opted-in repository automatically receives one private, local, exact-line preliminary review for every newly assigned pull request head SHA, with a durable cockpit, recent-review tone context, native notifications, and deterministic Markdown and JSON exports.

**Architecture:** Keep Reviewly's existing GitHub polling loop as the trigger and mount one app-wide coordinator in the persistent WebView. The coordinator reconciles the enriched dashboard projection into a SQLite-backed run queue, starts one Codex job through the existing Rust background AI registry, validates the strict result against the authoritative GitHub patch, and persists findings before exporting or notifying. Local clones use detached temporary worktrees created through the existing Git process boundary; repositories without a mapped clone use a visibly limited diff-only path. The automated path has no dependency on GitHub mutation commands, while Reviewly's existing explicit manual submission flow stays unchanged.

**Tech Stack:** Tauri 2, Rust 2021, React 18, TypeScript 5.6, TanStack Router and Query, Zustand with SQLite persistence, `tauri-plugin-sql`, Bun 1.3 test runner, Codex CLI, GitHub GraphQL and REST APIs, native Tauri notifications.

**Spec:** [`docs/superpowers/specs/2026-08-28-automated-pr-review-inbox-design.md`](../specs/2026-08-28-automated-pr-review-inbox-design.md)

## Global Constraints

- Automatic review remains opt-in per repository and defaults off.
- Reconciliation uses Reviewly's existing poll events, launch path, focus refresh, and safety timer. Do not introduce webhooks, cron, a daemon, or Codex Scheduled.
- A viewer-authored GitHub review in `PENDING` state is a hard skip before diff loading, run creation, or Codex execution.
- Every run is unique by `(repo, pr_number, head_sha)`. A new head gets a new run; retries reuse the same run.
- Only one automatic Codex review runs at a time.
- Codex always receives `-s read-only`. Do not add approval bypass, write sandboxing, or a GitHub mutation command to the automated path.
- Keep Reviewly's existing settings owners. `src/stores/auto-review.ts` may own only automation-specific preferences.
- Use the existing `reviewly.db`; use idempotent single-statement updates because `tauri-plugin-sql` pools connections and frontend `BEGIN` / `COMMIT` calls are unsafe.
- Do not retain full diffs, repository contents, raw prompts, raw Codex output, or tokens.
- User-facing generated comments must be supportive and direct, avoid em dashes, code fences, inline-code markup, AI attribution, praise inventories, and explanations that restate the author's implementation.
- Diff-only runs must state `limited context` anywhere the result is shown or exported.
- All new pure TypeScript modules receive Bun tests. Rust filesystem and command construction receive unit or integration tests using temporary repositories.
- Each task below ends with a focused commit boundary. Do not batch unrelated tasks into one commit.

---

## Task 1: Establish the test harness and versioned database foundation

**Files:**

- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/migrations.rs`
- Create: `src/lib/auto-review/types.ts`
- Create: `src/lib/auto-review/db.ts`
- Create: `src/lib/auto-review/db.test.ts`

### 1.1 Add the failing domain and migration tests

- [ ] Add a `test` script that runs Bun's built-in test runner:

```json
"test": "bun test"
```

- [ ] Add `bun run test` before typecheck in `.github/workflows/ci.yml`, and add `cargo test --locked` after `cargo check --locked`.
- [ ] Add direct test-only dependencies matching the versions already present in `Cargo.lock`:

```toml
[dev-dependencies]
sqlx = { version = "0.8.6", default-features = false, features = ["runtime-tokio", "sqlite"] }
tempfile = "3.27.0"
```

- [ ] Move migrations 1 through 6 unchanged from `src-tauri/src/lib.rs` into `migrations()` in `src-tauri/src/migrations.rs`.
- [ ] Add a Rust test that applies migrations 1 through 6 to an in-memory SQLite database, then applies migration 7 and asserts the five new tables, foreign key cascade, and unique indexes exist.
- [ ] Define a narrow `SqlClient` interface matching the plugin's `select` and `execute` methods, and expose `createAutoReviewDb(loadClient)` for tests plus one production instance backed by `Database.load("sqlite:reviewly.db")`.
- [ ] Add `src/lib/auto-review/db.test.ts` with an in-memory fake `SqlClient` and failing repository-behavior tests for:
  - inserting the same candidate twice creates one run;
  - a different head SHA creates a second run;
  - claiming changes only the oldest `queued` row to `running`;
  - retry changes a `failed` row back to `queued` without creating another row;
  - deleting a run cascades to its findings;
  - a completed run can retain an export error without losing findings.

Run:

```bash
bun test src/lib/auto-review/db.test.ts
cargo test --manifest-path src-tauri/Cargo.toml migrations --locked
```

Expected: fail because the schema, types, and database API do not exist yet.

### 1.2 Define the shared domain contract

- [ ] Add these central types to `src/lib/auto-review/types.ts` and import them everywhere else rather than recreating local variants:

```ts
export type AutoReviewStatus = "queued" | "running" | "completed" | "failed" | "superseded";
export type AutoReviewContextMode = "worktree" | "diff_only";
export type AutoReviewConclusion = "findings" | "no_concerns";
export type AutoReviewSide = "LEFT" | "RIGHT";
export type AutoReviewConfidence = "high" | "medium" | "low";
export type AutoReviewTrigger = "launch" | "assignment" | "head_changed" | "reconnect" | "retry";

export interface ReviewCandidate {
  id: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  authorAvatar: string;
  baseSha: string;
  headSha: string;
  hasPendingReview: boolean;
}

export interface AutoReviewFinding {
  id: string;
  runId: string;
  ordinal: number;
  category: "correctness" | "security" | "data" | "concurrency" | "performance" | "maintainability" | "test_coverage" | "question";
  confidence: AutoReviewConfidence;
  path: string;
  line: number;
  endLine: number;
  side: AutoReviewSide;
  comment: string;
  evidence: string | null;
  githubUrl: string | null;
}

export interface AutoReviewRun {
  id: string;
  repo: string;
  prId: number;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  authorLogin: string;
  baseSha: string;
  headSha: string;
  status: AutoReviewStatus;
  trigger: AutoReviewTrigger;
  contextMode: AutoReviewContextMode | null;
  provider: "codex";
  model: string | null;
  reasoning: string | null;
  conclusion: AutoReviewConclusion | null;
  overallComment: string | null;
  toneSampleHash: string | null;
  queuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  repairCount: number;
  recoveryCount: number;
  supersededByHeadSha: string | null;
  jsonArtifactPath: string | null;
  markdownArtifactPath: string | null;
  exportError: string | null;
  notificationKind: string | null;
  notificationDueAt: number | null;
  notifiedAt: number | null;
}
```

### 1.3 Add migration 7

- [ ] Add migration 7 using the exact `auto_review_repo_settings`, `auto_review_runs`, `auto_review_findings`, `review_tone_samples`, and `review_style_profile` columns from the spec.
- [ ] Add `recovery_count`, `notification_kind`, `notification_due_at`, and `notified_at` to `auto_review_runs`; these implement the spec's one-recovery limit and durable quiet-hours delivery.
- [ ] Enforce the run-state and side values with SQLite `CHECK` constraints.
- [ ] Add the unique indexes from the spec and enable `ON DELETE CASCADE` for findings.
- [ ] Keep `src-tauri/src/lib.rs` responsible for passing `migrations::migrations()` into `tauri-plugin-sql`.
- [ ] Keep the foreign key in the schema, but explicitly delete findings before the run in `deleteRun()` so correctness does not depend on a pooled SQLite connection retaining a connection-local `PRAGMA foreign_keys` value.

### 1.4 Implement the idempotent database API

- [ ] Add a shared lazy `Database.load("sqlite:reviewly.db")` accessor in `src/lib/auto-review/db.ts` and pass it through `createAutoReviewDb()`.
- [ ] Implement typed row mappers and these operations:

```ts
export async function listRepoSettings(): Promise<AutoReviewRepoSetting[]>;
export async function setRepoSetting(setting: AutoReviewRepoSetting): Promise<void>;
export async function enqueueCandidate(candidate: ReviewCandidate, trigger: AutoReviewTrigger): Promise<AutoReviewRun | null>;
export async function listRuns(): Promise<AutoReviewRun[]>;
export async function getRunDetail(id: string): Promise<{ run: AutoReviewRun; findings: AutoReviewFinding[] } | null>;
export async function claimNextQueuedRun(now: number): Promise<AutoReviewRun | null>;
export async function retryRun(id: string, now: number): Promise<void>;
export async function completeRun(input: CompleteRunInput): Promise<void>;
export async function failRun(input: FailRunInput): Promise<void>;
export async function supersedeRun(id: string, nextHeadSha: string, now: number): Promise<void>;
export async function recoverStaleRuns(activeKeys: Set<string>, now: number): Promise<void>;
export async function markNotificationDelivered(id: string, now: number): Promise<void>;
export async function listDueNotifications(now: number): Promise<AutoReviewRun[]>;
export async function deleteRun(id: string): Promise<{ jsonPath: string | null; markdownPath: string | null }>;
```

- [ ] Implement `enqueueCandidate` with `INSERT ... ON CONFLICT(repo, pr_number, head_sha) DO NOTHING`, then return `null` when `rowsAffected === 0`.
- [ ] Implement claim with one guarded `UPDATE` selecting the oldest queued row. Do not use a frontend transaction.
- [ ] Store findings only after validation has produced the complete final array. Insert the completed run last so the UI never observes a completed row without its findings.

### 1.5 Verify and commit

Run:

```bash
bun test src/lib/auto-review/db.test.ts
cargo test --manifest-path src-tauri/Cargo.toml migrations --locked
bun run typecheck
```

Expected: all pass.

Commit:

```bash
git add package.json bun.lock .github/workflows/ci.yml src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/migrations.rs src/lib/auto-review/types.ts src/lib/auto-review/db.ts src/lib/auto-review/db.test.ts
git commit -m "feat: add automated review persistence foundation"
```

---

## Task 2: Extend existing settings owners and add repository opt-in

**Files:**

- Modify: `src/stores/ai.ts`
- Modify: `src/stores/notif-settings.ts`
- Modify: `src/stores/app-behavior.ts`
- Modify: `src/routes/settings.tsx`
- Modify: `src/app/use-notif-sync.ts`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/commands/notifications.rs`
- Create: `src/stores/auto-review.ts`
- Create: `src/lib/auto-review/config.ts`
- Create: `src/lib/auto-review/config.test.ts`
- Create: `src/components/auto-review/repo-settings.tsx`

### 2.1 Write failing ownership and resolution tests

- [ ] Test that automated reviews always resolve the Codex provider even when manual AI is set to Claude, Gemini, or OpenAI-compatible.
- [ ] Test that a repository model or reasoning override wins over the app-level Codex value.
- [ ] Test that empty overrides fall back to app-level values and an empty app-level value omits the CLI option.
- [ ] Test the current Codex reasoning values: empty/default, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- [ ] Test that `useAutoReviewSettings` contains only artifact/tone preferences and does not own model, timeout, notifications, launch behavior, review instructions, or clone paths.

Run:

```bash
bun test src/lib/auto-review/config.test.ts
```

Expected: fail because the automated Codex resolver and settings do not exist.

### 2.2 Extend settings at their existing owners

- [ ] Add `CodexReasoningEffort = "" | "minimal" | "low" | "medium" | "high" | "xhigh"` and `codexReasoningEffort` to `useAiProvider`. Keep the existing free-text Codex model and timeout fields.
- [ ] Add a provider-specific resolver without changing `aiInvokeArgs()` for manual features:

```ts
export function codexInvokeArgs(overrides?: {
  model?: string | null;
  reasoning?: CodexReasoningEffort | null;
}): {
  provider: "codex";
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  timeoutSecs?: number;
};
```

- [ ] Extend `NotifReason` with `auto_review_findings`, `auto_review_clean`, `auto_review_limited`, and `auto_review_failed`.
- [ ] Add `quietHoursEnabled`, `quietHoursStart`, and `quietHoursEnd` to `useNotifSettings`; store local `HH:mm` values and support overnight windows.
- [ ] Extend `LandingPage` and `LANDING_OPTIONS` with `/review-inbox`.
- [ ] Create `useAutoReviewSettings` with only:

```ts
interface State {
  artifactDirectoryName: string; // default: "artifacts"
  toneLookbackDays: number;      // default: 90
  toneSampleLimit: number;       // default: 40
  toneRefreshHours: number;      // default: 24
}
```

- [ ] Do not move `aiInstructions`, local-repo mappings, launch-at-login, start-in-tray, or notification enablement into this store.

### 2.3 Add repository opt-in controls

- [ ] Add an `Automatic reviews` settings section using Reviewly's existing `CollapsibleSection`, `Switch`, `Select`, `Input`, and muted status styles.
- [ ] Build the repository list from the union of watched repositories, mapped local repositories, and repositories currently visible in the shared incoming dashboard query.
- [ ] Persist `enabled`, `model_override`, and `reasoning_override` in `auto_review_repo_settings`.
- [ ] Default every newly discovered repository to disabled. Never create enabled rows implicitly.
- [ ] Show whether a mapped local clone exists, because the user flow differs:
  - mapped and valid: `full local context`;
  - absent: `limited diff context`;
  - invalid remote: `clone mapping needs attention`.
- [ ] Keep custom engineering guidance in the existing review-instructions field and label it clearly as applying before fixed automated-review rules.

### 2.4 Sync quiet hours through the existing bridge

- [ ] Extend `useNotifSync()` to invoke `set_notification_quiet_hours` beside the existing enablement, reasons, and poll interval calls.
- [ ] Add quiet-hour fields to `AppState`, initialized to disabled.
- [ ] Add the new setter to `commands/notifications.rs` and register it in `src-tauri/src/lib.rs`.
- [ ] Do not add another notification settings command family.

### 2.5 Verify and commit

Run:

```bash
bun test src/lib/auto-review/config.test.ts
bun run typecheck
bun run lint
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Commit:

```bash
git add src/stores/ai.ts src/stores/notif-settings.ts src/stores/app-behavior.ts src/stores/auto-review.ts src/lib/auto-review/config.ts src/lib/auto-review/config.test.ts src/components/auto-review/repo-settings.tsx src/routes/settings.tsx src/app/use-notif-sync.ts src-tauri/src/state.rs src-tauri/src/commands/notifications.rs src-tauri/src/lib.rs
git commit -m "feat: add automated review configuration"
```

---

## Task 3: Enrich and share the existing incoming-review projection

**Files:**

- Modify: `src-tauri/src/commands/search.rs`
- Modify: `src/lib/tauri.ts`
- Modify: `src/routes/dashboard.tsx`
- Create: `src/lib/dashboard.ts`
- Create: `src/lib/dashboard.test.ts`
- Create: `src/lib/auto-review/candidates.ts`
- Create: `src/lib/auto-review/candidates.test.ts`

### 3.1 Add failing projection tests

- [ ] Add a Rust fixture test for `StatsNode` and `dashboard_pr_from_node` covering `headRefOid`, `baseRefOid`, and a viewer-authored pending review.
- [ ] Add a Rust assertion that the one shared PR field selection includes both SHAs and the pending-review connection.
- [ ] Add TypeScript tests showing `toReviewCandidate()` returns all identity fields and that `hasPendingReview` is preserved.
- [ ] Add a test showing the pending guard returns `existing_draft` before any injected `loadFiles` function is called.

Run:

```bash
bun test src/lib/dashboard.test.ts src/lib/auto-review/candidates.test.ts
cargo test --manifest-path src-tauri/Cargo.toml dashboard --locked
```

Expected: fail because the projection lacks the required fields.

### 3.2 Extend `gh_dashboard` instead of adding candidate detail calls

- [ ] Extract the repeated GraphQL selection to `const DASHBOARD_PR_FIELDS` and add:

```graphql
headRefOid
baseRefOid
reviews(states: [PENDING], first: 10) {
  nodes { viewerDidAuthor }
}
```

- [ ] Extend `StatsNode`, `DashboardPr`, and the TypeScript mirror with `headSha`, `baseSha`, and `hasPendingReview`.
- [ ] Set `hasPendingReview` when any returned review has `viewerDidAuthor: true`.
- [ ] Keep `gh_dashboard` as one GraphQL request for incoming and authored PRs. Do not call `gh_get_pull` per incoming PR.

### 3.3 Extract dashboard presentation primitives

- [ ] Move `InboxItem`, `fromPr`, age calculation, blocked state, priority calculation, and sort order from `src/routes/dashboard.tsx` to `src/lib/dashboard.ts`.
- [ ] Keep the dashboard's rendering and current behavior unchanged.
- [ ] Reuse that view model for incoming rows in the automated-review cockpit rather than creating another PR-row type.

### 3.4 Implement the pending-review gate

- [ ] Add a pure candidate classification:

```ts
export type CandidateDisposition =
  | { kind: "eligible"; candidate: ReviewCandidate }
  | { kind: "disabled" }
  | { kind: "existing_draft" }
  | { kind: "invalid"; reason: string };
```

- [ ] Evaluate disabled, pending, and missing-SHA states before any diff fetch or database enqueue.
- [ ] Surface `existing draft` from live GitHub state in the cockpit, but create no local run for it.

### 3.5 Verify and commit

Run:

```bash
bun test src/lib/dashboard.test.ts src/lib/auto-review/candidates.test.ts
cargo test --manifest-path src-tauri/Cargo.toml dashboard --locked
bun run typecheck
```

Commit:

```bash
git add src-tauri/src/commands/search.rs src/lib/tauri.ts src/lib/dashboard.ts src/lib/dashboard.test.ts src/lib/auto-review/candidates.ts src/lib/auto-review/candidates.test.ts src/routes/dashboard.tsx
git commit -m "feat: enrich incoming review candidates"
```

---

## Task 4: Make background AI task routing explicit and add Codex reasoning

**Files:**

- Modify: `src-tauri/src/commands/ai.rs`
- Modify: `src/app/use-guided-events.ts`
- Modify: `src/app/use-layers-events.ts`
- Modify: `src/components/guided-review.tsx`
- Modify: callers of `ai_review_bg` found by `rg -n 'ai_review_bg' src`
- Create: `src/lib/ai/tasks.ts`
- Create: `src/lib/ai/tasks.test.ts`

### 4.1 Write failing key-routing and Rust argument tests

- [ ] Test the three task classes and their parsers:

```ts
guided:owner/repo#12
layers:owner/repo#12
auto-review:<run-id>
```

- [ ] Test that guided listeners ignore layers and automated keys, layers listeners ignore guided and automated keys, and the automated listener ignores guided and layers keys.
- [ ] Add Rust tests for a pure `build_codex_args()` helper. Assert that every result contains `exec`, `--skip-git-repo-check`, `-s`, `read-only`, and `--output-last-message`.
- [ ] Assert that reasoning emits two arguments, `-c` and `model_reasoning_effort="high"`, before the stdin `-` marker.
- [ ] Assert empty reasoning emits no config override.

Run:

```bash
bun test src/lib/ai/tasks.test.ts
cargo test --manifest-path src-tauri/Cargo.toml codex_args --locked
```

Expected: fail because guided keys are currently unprefixed and reasoning is not accepted.

### 4.2 Centralize task key construction and completion typing

- [ ] Add `guidedKey`, `layersKey`, `autoReviewKey`, `classifyAiTaskKey`, and one exported `AiDone` event type to `src/lib/ai/tasks.ts`.
- [ ] Preserve store keys as `owner/repo#number`; prefix only the Rust task key.
- [ ] Move the duplicated first-line error summarizer from the guided and layers hooks into this module.
- [ ] Update inflight recovery, cancel, start, and completion paths to convert between prefixed task keys and existing store keys.

### 4.3 Thread reasoning through the existing background command

- [ ] Add optional `reasoning_effort` to `ai_review`, `ai_review_bg`, `run_provider`, and `run_codex`. Other providers ignore it.
- [ ] Build Codex arguments in a pure helper used by production and tests.
- [ ] Pass the configuration as separate process arguments. Never compose a shell string.
- [ ] Continue using the existing stdin, output-last-message, timeout, error classification, inflight set, task handle map, and `ai:done` event.
- [ ] Do not add a second Codex process runner for automation.

### 4.4 Verify current manual AI behavior remains intact

- [ ] Start and cancel a guided run; verify its store and toast respond only to the guided event.
- [ ] Start a layered run; verify the guided listener does not report a phantom failure.
- [ ] Confirm all `ai_review_bg` calls provide a classified key.

Run:

```bash
bun test src/lib/ai/tasks.test.ts
bun run typecheck
cargo test --manifest-path src-tauri/Cargo.toml codex_args --locked
```

Commit:

```bash
git add src/lib/ai/tasks.ts src/lib/ai/tasks.test.ts src/app/use-guided-events.ts src/app/use-layers-events.ts src/components/guided-review.tsx src/components/layered-review.tsx src/stores/ai.ts src-tauri/src/commands/ai.rs
git commit -m "refactor: isolate background AI task routing"
```

---

## Task 5: Build strict prompt, parser, and exact-line validation

**Files:**

- Create: `src/lib/auto-review/prompt.ts`
- Create: `src/lib/auto-review/prompt.test.ts`
- Create: `src/lib/auto-review/result.ts`
- Create: `src/lib/auto-review/result.test.ts`
- Create: `src/lib/auto-review/validate.ts`
- Create: `src/lib/auto-review/validate.test.ts`
- Reuse: `src/lib/ai/json.ts`
- Reuse: `src/lib/diff.ts`

### 5.1 Write failing contract tests

- [ ] Add parser fixtures for valid findings, valid no-concerns, fenced JSON, prose plus JSON, truncated JSON, wrong enums, and missing fields.
- [ ] Require exactly one JSON object. Allow stripping a surrounding Markdown fence through `stripFence`, but reject mixed prose and partial salvage.
- [ ] Add validation fixtures for right-side additions/context, left-side deletions, a missing file, a non-commentable line, reversed ranges, a stale head, unsupported markup, an em dash, and diff-only overclaims.
- [ ] Add prompt snapshots proving the order is:
  1. existing `aiInstructions`;
  2. generated tone profile and recent examples;
  3. fixed automated-review rules;
  4. context-mode limits;
  5. PR metadata and authoritative patches;
  6. strict output schema.
- [ ] Assert the fixed rules explicitly reject praise inventories and implementation restatements.

Run:

```bash
bun test src/lib/auto-review/prompt.test.ts src/lib/auto-review/result.test.ts src/lib/auto-review/validate.test.ts
```

Expected: fail because the modules do not exist.

### 5.2 Implement the strict result parser

- [ ] Define `RawAutoReviewResult` matching the spec's JSON shape.
- [ ] Reuse `stripFence`, `tryJson`, `toInt`, and safe string helpers from `src/lib/ai/json.ts`.
- [ ] Return a discriminated parse result:

```ts
export type ParseResult =
  | { ok: true; value: RawAutoReviewResult }
  | { ok: false; code: "malformed_json" | "schema_mismatch"; message: string };
```

- [ ] Do not extract objects from arbitrary prose and do not accept a partial findings array.
- [ ] Add `buildRepairPrompt(originalOutput)` containing the schema and original output, with an instruction to return only the corrected JSON object.

### 5.3 Validate every finding against `parsePatch`

- [ ] Index each `PullFile.patch` with the existing `parsePatch()` result.
- [ ] Treat `RIGHT` as commentable only when the requested new line exists as context or addition; treat `LEFT` as commentable only when the requested old line exists as deletion.
- [ ] Require every line in a range to be commentable on the same side and cap ranges to 10 lines.
- [ ] Reject empty comments, comments over 800 characters, evidence over 500 characters, em dashes, triple backticks, and inline backtick spans.
- [ ] Reject diff-only wording that claims repository-wide inspection, call-site inspection, runtime configuration inspection, or generated-source inspection.
- [ ] Sort valid findings by confidence and original ordinal. Return discarded-count metadata without retaining raw output.
- [ ] Construct stable GitHub URLs with the base SHA for left-side findings and the head SHA for right-side findings.

### 5.4 Build the style-safe prompt

- [ ] Keep fixed rules in a constant that user settings cannot remove.
- [ ] Instruct Codex to lead with the concern or a concise verifying question, mention method names without full signatures, and omit an overall comment unless useful.
- [ ] For zero findings, allow only a brief `looks good from my side` style conclusion.
- [ ] Include a clear diff-only clause so the generated result cannot imply unseen context.
- [ ] Never ask Codex to post, submit, create a GitHub review, change files, or invoke a mutation.

### 5.5 Verify and commit

Run:

```bash
bun test src/lib/auto-review/prompt.test.ts src/lib/auto-review/result.test.ts src/lib/auto-review/validate.test.ts
bun run typecheck
bun run lint
```

Commit:

```bash
git add src/lib/auto-review/prompt.ts src/lib/auto-review/prompt.test.ts src/lib/auto-review/result.ts src/lib/auto-review/result.test.ts src/lib/auto-review/validate.ts src/lib/auto-review/validate.test.ts
git commit -m "feat: validate structured automated reviews"
```

---

## Task 6: Implement the durable diff-only coordinator end to end

**Files:**

- Create: `src/lib/auto-review/coordinator.ts`
- Create: `src/lib/auto-review/coordinator.test.ts`
- Create: `src/app/use-auto-review.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/use-realtime-events.ts`

### 6.1 Write the failing coordinator tests with injected services

- [ ] Define dependencies so tests never call Tauri, GitHub, SQLite, timers, or Codex directly:

```ts
export interface AutoReviewServices {
  now(): number;
  loadCandidates(): Promise<ReviewCandidate[]>;
  loadFiles(candidate: ReviewCandidate): Promise<PullFile[]>;
  loadCurrentCandidate(repo: string, number: number): Promise<ReviewCandidate | null>;
  startAi(input: StartAutoReviewInput): Promise<void>;
  inflightKeys(): Promise<string[]>;
  prepareContext(run: AutoReviewRun): Promise<PreparedContext>;
  cleanupContext(context: PreparedContext): Promise<void>;
}
```

- [ ] Cover these user flows:
  - disabled repository produces no run;
  - pending GitHub draft does not call `loadFiles`, enqueue, or `startAi`;
  - the same candidate observed by launch, `pr:new`, and timer produces one run;
  - a new head produces one new run and supersedes an older queued/running result;
  - removed assignments do not start;
  - only one claimed run starts while another remains queued;
  - a valid no-concerns result completes normally;
  - malformed output gets exactly one repair invocation;
  - a second malformed output fails visibly;
  - the head changing during execution prevents result attachment;
  - stale running rows with no Rust inflight task requeue once, then fail on a repeated recovery;
  - cleanup executes on success, failure, cancel, and supersession.

Use `jest.useFakeTimers()` and `jest.setSystemTime()` from `bun:test` for timer and recovery assertions.

Run:

```bash
bun test src/lib/auto-review/coordinator.test.ts
```

Expected: fail because the coordinator does not exist.

### 6.2 Implement reconciliation and one-at-a-time claiming

- [ ] Reconcile enabled settings against the single `gh_dashboard` incoming list.
- [ ] Classify pending reviews before diff loading and disabled repositories before enqueue.
- [ ] Supersede queued or running rows for the same PR when a different current head is observed.
- [ ] Claim one row, re-read live candidate state, then load files.
- [ ] Fail with `diff_unavailable` when the GitHub patch is incomplete enough that no responsible diff-only review can run.
- [ ] Start the existing `ai_review_bg` with `key: autoReviewKey(run.id)`, Codex-only settings, the current head SHA, and no `cwd` for this task's diff-only slice.

### 6.3 Handle completion and one repair pass

- [ ] Subscribe once to `ai:done` in `useAutoReview()` and ignore non-automated keys.
- [ ] On success, parse, validate, re-check the live head, persist, and start the next queued row.
- [ ] On malformed output with `repair_count === 0`, increment the count and start one repair with the same run ID.
- [ ] On failure or a second malformed output, persist an actionable `error_code` and short `error_message`.
- [ ] Do not store the event's raw output after parsing or repair construction.

### 6.4 Wire existing wake sources

- [ ] Mount `useAutoReview()` once in `AppLayout`, alongside the existing app-wide hooks.
- [ ] Reconcile on authentication readiness, mount, `pr:new`, `pr:changed`, browser online, window focus, and a five-minute safety timer.
- [ ] Let `useRealtimeEvents()` continue owning the poll-event subscription. Add a narrow app event or query invalidation that the coordinator observes instead of duplicating all GitHub poll listeners.
- [ ] On mount, call `ai_inflight`, recover stale rows, and resume the queue.
- [ ] Ensure cleanup functions remove listeners and timers when the main WebView unloads.

### 6.5 Verify and commit

Run:

```bash
bun test src/lib/auto-review/coordinator.test.ts
bun test
bun run typecheck
bun run lint
```

Commit:

```bash
git add src/lib/auto-review/coordinator.ts src/lib/auto-review/coordinator.test.ts src/app/use-auto-review.ts src/app/layout.tsx src/app/use-realtime-events.ts
git commit -m "feat: run durable diff-only automated reviews"
```

---

## Task 7: Add the review cockpit and exact-line handoff to the existing diff

**Files:**

- Create: `src/routes/review-inbox.tsx`
- Create: `src/components/auto-review/review-queue.tsx`
- Create: `src/components/auto-review/run-detail.tsx`
- Create: `src/components/auto-review/finding-card.tsx`
- Create: `src/components/auto-review/review-state.tsx`
- Create: `src/lib/auto-review/navigation.ts`
- Create: `src/lib/auto-review/navigation.test.ts`
- Modify: `src/lib/router.tsx`
- Modify: `src/app/sidebar.tsx`
- Modify: `src/routes/pr-detail.tsx`
- Modify: `src/components/diff-viewer.tsx`

### 7.1 Write failing navigation and view-model tests

- [ ] Test that a finding builds `/prs/$owner/$repo/$number` search values `{ file, line, side }`.
- [ ] Test search validation rejects empty paths, non-positive lines, and invalid sides.
- [ ] Test both `LEFT` and `RIGHT` focus anchors select the requested file, force the files tab, and focus the correct rendered side.
- [ ] Test queue labels for `queued`, `running`, `completed`, `failed`, `superseded`, `limited context`, and `existing draft`.

Run:

```bash
bun test src/lib/auto-review/navigation.test.ts
```

Expected: fail because the route and search contract do not exist.

### 7.2 Register the cockpit in existing navigation

- [ ] Add a lazy `/review-inbox` route to `src/lib/router.tsx`.
- [ ] Add one sidebar rail item using the existing `RailItem`; badge it with queued, running, completed-unread, and failed work rather than issuing a separate GitHub count query.
- [ ] Keep the dashboard and pull-request routes unchanged.
- [ ] Allow `/review-inbox` as the existing default landing preference.

### 7.3 Build the three-pane experience from existing primitives

- [ ] Use Reviewly's `ResizablePanelGroup`, `ScrollArea`, `PageHeader`, buttons, badges, alerts, empty states, and dashboard incoming view model.
- [ ] Left pane: current incoming PRs, enabled/disabled state, pending-draft state, and clone-context label.
- [ ] Middle pane: durable run history for the selected PR, newest head first, with retry and delete actions.
- [ ] Right pane: conclusion, short overall comment when present, and ordered finding cards.
- [ ] Put the paste-ready comment first. Put evidence below it in muted text.
- [ ] Give every finding `Copy` and `Open exact line` actions.
- [ ] Keep deletion behind the existing themed confirmation dialog; after database deletion, artifact cleanup occurs through Task 10's command.
- [ ] Do not add a posting button or invoke the existing review-draft store in v1.

### 7.4 Extend the existing diff focus behavior for side-aware anchors

- [ ] Add route `validateSearch` for optional `file`, `line`, and `side`.
- [ ] On a valid search anchor, `PRDetailPage` sets the files tab, active file, unified view, and focus anchor after the file list is available.
- [ ] Extend `DiffViewer` with `focusSide?: "LEFT" | "RIGHT"` and render side-aware data attributes. Keep current guided-tour right-side calls working when `focusSide` is omitted.
- [ ] Scroll and flash the exact side/line, then replace the URL search to remove the consumed anchor so refresh does not repeatedly jump.
- [ ] Do not create a second diff renderer or fetch a second copy of the patch.

### 7.5 Verify visually and commit

Run:

```bash
bun test src/lib/auto-review/navigation.test.ts
bun run typecheck
bun run lint
bun run build
bun run tauri dev
```

Manual checks:

- Queue and detail remain legible at the minimum supported window width.
- Long comments wrap; paths truncate without widening the queue.
- `Copy` places only the comment body on the clipboard.
- Right-side and left-side findings open the existing PR diff at the exact line.
- Limited context and failure states cannot be mistaken for a complete full-context review.

Commit:

```bash
git add src/routes/review-inbox.tsx src/components/auto-review src/lib/auto-review/navigation.ts src/lib/auto-review/navigation.test.ts src/lib/router.tsx src/app/sidebar.tsx src/routes/pr-detail.tsx src/components/diff-viewer.tsx
git commit -m "feat: add automated review cockpit"
```

---

## Task 8: Add isolated worktree context through the existing Git boundary

**Files:**

- Modify: `src-tauri/src/commands/git.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri.ts`
- Modify: `src/lib/auto-review/coordinator.ts`
- Modify: `src/lib/auto-review/coordinator.test.ts`

### 8.1 Add failing Rust filesystem and Git tests

- [ ] Use a temporary bare origin and working clone. Do not require network access.
- [ ] Cover:
  - safe run IDs cannot escape the Reviewly cache root;
  - the mapped clone's `origin` must normalize to the requested `owner/repo`;
  - fetch creates `refs/reviewly/auto-review/<run-id>` from `refs/pull/<number>/head` and verifies it equals the requested head SHA;
  - `git worktree add --detach` leaves the user's current branch, index, and untracked files unchanged;
  - cleanup removes the worktree and namespaced ref on success and failure;
  - orphan cleanup touches only paths under Reviewly's review-worktree cache directory.
- [ ] Add a coordinator test proving an invalid clone mapping falls back to diff-only only when GitHub patches remain reviewable.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml review_worktree --locked
bun test src/lib/auto-review/coordinator.test.ts
```

Expected: fail because the worktree operations do not exist.

### 8.2 Extend `git.rs` without introducing a shell wrapper

- [ ] Make the existing argument-based `run_git` and parsing helpers reusable within the module.
- [ ] Add commands:

```rust
#[tauri::command]
pub async fn git_prepare_review_worktree(
    app: AppHandle,
    clone_path: String,
    expected_repo: String,
    pr_number: u64,
    expected_head_sha: String,
    run_id: String,
) -> AppResult<ReviewWorktree>;

#[tauri::command]
pub async fn git_cleanup_review_worktree(
    app: AppHandle,
    clone_path: String,
    run_id: String,
) -> AppResult<()>;

#[tauri::command]
pub async fn git_cleanup_orphaned_review_worktrees(app: AppHandle) -> AppResult<u64>;
```

- [ ] Resolve the root with `app.path().app_cache_dir()` and append `review-worktrees/<safe-run-id>`.
- [ ] Run Git only through the existing `cli_command`, timeout, and argument-array path.
- [ ] Verify remote identity before fetch and exact SHA after fetch.
- [ ] Perform cleanup in a finally-style path and make it idempotent.

### 8.3 Use mapped clones without touching active work

- [ ] Resolve clone mappings from `useLocalRepos` in the coordinator.
- [ ] Set `contextMode: "worktree"` and pass the returned detached path as `cwd` only after preparation succeeds.
- [ ] Always keep the authoritative GitHub patch in the prompt, even in worktree mode.
- [ ] On preparation failure, record a diagnostic and fall back to `diff_only` only when the patch is sufficient. Otherwise fail.
- [ ] Run orphan cleanup on app launch after stale-run recovery.

### 8.4 Verify and commit

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml review_worktree --locked
bun test src/lib/auto-review/coordinator.test.ts
bun run typecheck
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Manual check: keep a mapped clone on a dirty branch with an untracked file, run a review, and confirm `git status --short --branch` is byte-for-byte unchanged afterward.

Commit:

```bash
git add src-tauri/src/commands/git.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/lib/tauri.ts src/lib/auto-review/coordinator.ts src/lib/auto-review/coordinator.test.ts
git commit -m "feat: review pull requests in isolated worktrees"
```

---

## Task 9: Learn review tone from recent authored GitHub reviews

**Files:**

- Modify: `src-tauri/src/clients/github.rs`
- Modify: `src-tauri/src/commands/search.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri.ts`
- Create: `src/lib/auto-review/tone.ts`
- Create: `src/lib/auto-review/tone.test.ts`
- Modify: `src/lib/auto-review/prompt.ts`
- Modify: `src/routes/settings.tsx`

### 9.1 Write failing sample and profile tests

- [ ] Add a Rust deserialization fixture for one `pullRequestReviewContributions` GraphQL response containing a review body and inline comments.
- [ ] Add TypeScript tests that:
  - normalize whitespace without changing wording;
  - discard empty, bot-authored, pending, and duplicate samples;
  - prefer recent inline comments while retaining a small number of overall comments;
  - cap sample count and per-sample length;
  - produce a stable sample hash independent of API ordering;
  - calculate concise style measurements such as median length, question frequency, paragraph frequency, punctuation tendency, and list frequency;
  - keep user override text separate from generated profile text;
  - include representative recent examples in prompts without storing them in artifacts.

Run:

```bash
bun test src/lib/auto-review/tone.test.ts
cargo test --manifest-path src-tauri/Cargo.toml review_tone --locked
```

Expected: fail because tone fetching and profiling do not exist.

### 9.2 Fetch recent reviews in one read-only GraphQL flow

- [ ] Add `gh_review_tone_samples(lookback_days, limit)` using `viewer.contributionsCollection(from:, to:).pullRequestReviewContributions(first:, orderBy: { direction: DESC })`.
- [ ] Select review ID, body, state, submitted time, repository name, pull request number, and inline review-comment IDs, bodies, and creation times.
- [ ] Return both review bodies and inline comments as `ReviewToneSample` values with stable source IDs.
- [ ] Reuse `clients::graphql::graphql`, current OAuth token loading, HTTP client, retry/error behavior, and camelCase serialization.
- [ ] Do not call one review endpoint per pull request.

### 9.3 Persist samples and derive the local profile

- [ ] Upsert by `source_id`, prune samples outside the lookback window, and update the singleton profile only when the stable sample hash changes.
- [ ] Derive the generated profile deterministically from measurements and representative examples. The review model learns semantic tone from the examples themselves; a second model call is not required.
- [ ] Keep the fixed rules authoritative even when historical samples contain a now-forbidden style.
- [ ] Refresh on first eligible review, when samples are older than `toneRefreshHours`, and through a `Refresh tone` settings action.
- [ ] Show last refresh, sample count, generated summary, and editable `user_override` in the existing settings page.
- [ ] If refresh fails, retain the last good profile and show `last_error` without blocking reviews.

### 9.4 Verify and commit

Run:

```bash
bun test src/lib/auto-review/tone.test.ts src/lib/auto-review/prompt.test.ts
cargo test --manifest-path src-tauri/Cargo.toml review_tone --locked
bun run typecheck
```

Manual check: compare the fetched source IDs and dates with the authenticated user's recent submitted GitHub reviews; do not print review bodies to logs.

Commit:

```bash
git add src-tauri/src/clients/github.rs src-tauri/src/commands/search.rs src-tauri/src/lib.rs src/lib/tauri.ts src/lib/auto-review/tone.ts src/lib/auto-review/tone.test.ts src/lib/auto-review/prompt.ts src/routes/settings.tsx
git commit -m "feat: learn automated review tone locally"
```

---

## Task 10: Export deterministic artifacts and deliver native notifications

**Files:**

- Create: `src/lib/auto-review/export.ts`
- Create: `src/lib/auto-review/export.test.ts`
- Create: `src/lib/auto-review/notifications.ts`
- Create: `src/lib/auto-review/notifications.test.ts`
- Create: `src-tauri/src/commands/auto_review.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/notifications.rs`
- Modify: `src/lib/auto-review/coordinator.ts`
- Modify: `src/app/use-auto-review.ts`

### 10.1 Write failing export and quiet-hours tests

- [ ] Snapshot JSON and Markdown for findings, no-concerns, worktree, and limited-context runs.
- [ ] Assert deterministic output excludes absolute clone paths, prompts, raw output, token data, and full patches.
- [ ] Assert right-side and left-side stable links use the correct reviewed SHA.
- [ ] Test same-day, overnight, disabled, and boundary quiet-hour calculations.
- [ ] Test duplicate completion events schedule or send one notification per run ID.
- [ ] Add Rust tests for atomic replace, subpath containment, traversal rejection, retry, and idempotent deletion.

Run:

```bash
bun test src/lib/auto-review/export.test.ts src/lib/auto-review/notifications.test.ts
cargo test --manifest-path src-tauri/Cargo.toml auto_review_artifacts --locked
```

Expected: fail because export and local completion notifications do not exist.

### 10.2 Build versioned export models

- [ ] Export this stable envelope from stored data only:

```ts
interface AutoReviewArtifactV1 {
  schemaVersion: 1;
  pullRequest: { repo: string; number: number; title: string; url: string; baseSha: string; headSha: string };
  run: { id: string; contextMode: AutoReviewContextMode; model: string | null; reasoning: string | null; toneSampleHash: string | null; queuedAt: string; completedAt: string };
  result: { conclusion: AutoReviewConclusion; overallComment: string | null; findings: ArtifactFinding[] };
}
```

- [ ] Markdown includes result status, context label, paste-ready comments, exact `path:line` placement, evidence, and stable links.
- [ ] Sort object arrays and findings deterministically. End text files with one newline.

### 10.3 Add narrow atomic filesystem commands

- [ ] Implement `write_auto_review_artifacts`, `retry_auto_review_artifacts`, and `delete_auto_review_artifacts` in `src-tauri/src/commands/auto_review.rs`.
- [ ] Resolve the base from `app.path().app_data_dir()` and the configured safe directory name. Reject separators, traversal, and paths outside that base.
- [ ] Write to sibling temporary files, flush, then rename to `review.json` and `review.md` under `owner/repo/pull-<number>/<head-sha>/`.
- [ ] Return paths only after both writes succeed. On partial failure, keep the completed database result and record `export_error`.
- [ ] Keep AI, Git, queueing, and notifications out of this command module.

### 10.4 Extend native notifications through the current path

- [ ] Add `notify_auto_review` to `commands/notifications.rs`. It must check the existing `notify_enabled`, allowed reason set, and quiet-hour state before using `NotificationExt`.
- [ ] Return `sent`, `quiet`, or `disabled` so the coordinator can set durable notification columns.
- [ ] For `quiet`, compute and persist the next local quiet-hours boundary. `useAutoReview` drains `listDueNotifications()` at that time and on launch/focus.
- [ ] Suppress duplicates when `notified_at` is already present.
- [ ] Notification text distinguishes findings, no concerns, limited context, and failure and names the pull request clearly so the corresponding run is immediately findable in `/review-inbox`.
- [ ] Do not notify for queueing, ordinary retry, unchanged polls, or superseded output.

### 10.5 Verify and commit

Run:

```bash
bun test src/lib/auto-review/export.test.ts src/lib/auto-review/notifications.test.ts
cargo test --manifest-path src-tauri/Cargo.toml auto_review_artifacts --locked
bun run typecheck
bun run lint
```

Manual checks:

- Hide Reviewly to the menu bar, complete a review, and confirm one macOS notification appears.
- Set quiet hours around the current time, complete a run, restart the app, and confirm one delayed notification appears after the boundary.
- Open exported Markdown and JSON, compare them with the cockpit, and confirm no full patch or raw response is present.

Commit:

```bash
git add src/lib/auto-review/export.ts src/lib/auto-review/export.test.ts src/lib/auto-review/notifications.ts src/lib/auto-review/notifications.test.ts src-tauri/src/commands/auto_review.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/commands/notifications.rs src/lib/auto-review/coordinator.ts src/app/use-auto-review.ts
git commit -m "feat: export and notify automated reviews"
```

---

## Task 11: Harden recovery, enforce no-write boundaries, and finish integration

**Files:**

- Create: `src/lib/auto-review/security.test.ts`
- Create: `src/lib/auto-review/integration.test.ts`
- Modify: `src/lib/auto-review/coordinator.ts`
- Modify: `src/lib/auto-review/db.ts`
- Modify: `src/app/use-auto-review.ts`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

### 11.1 Add the final failing integration and dependency tests

- [ ] Create an in-memory fake service suite covering:
  - offline launch followed by reconnect;
  - app restart with queued and stale-running jobs;
  - mid-run head update;
  - assignment removal before claim;
  - worktree preparation failure with diff-only fallback;
  - malformed result followed by successful repair;
  - completed result with artifact failure;
  - completion and failure notification deduplication.
- [ ] Add a static dependency test that scans production files under `src/lib/auto-review`, `src/app/use-auto-review.ts`, `src/routes/review-inbox.tsx`, and `src/components/auto-review`, excludes `*.test.ts`, and fails if they reference:

```text
gh_submit_review
gh_create_review_comment
gh_create_review_reply
gh_merge
gh_update_pull
gh_set_labels
gh_request_reviewers
```

- [ ] Add a Rust test asserting automated Codex argument construction always includes `read-only` and never includes `workspace-write`, `danger-full-access`, or approval bypass flags.

Run:

```bash
bun test src/lib/auto-review/integration.test.ts src/lib/auto-review/security.test.ts
cargo test --manifest-path src-tauri/Cargo.toml codex_args --locked
```

Expected: fail until the final recovery edges and dependency boundary are complete.

### 11.2 Close recovery and lifecycle gaps

- [ ] Coalesce simultaneous wakes so one reconcile finishes before another starts; record that another pass is needed instead of dropping it.
- [ ] Use bounded retry for transient GitHub reads and no retry for authentication or schema errors.
- [ ] Requeue a stale running row once when no matching Rust inflight key exists. Fail with `interrupted_repeatedly` after the second stale recovery.
- [ ] Ignore late events for failed, completed, or superseded rows.
- [ ] Mark older queued/running rows superseded when the same PR exposes a new head, but preserve completed history.
- [ ] Run context cleanup even when persistence, export, or notification delivery fails.
- [ ] Keep Quit behavior unchanged: active processes stop with the app. On next launch, recovery makes the unfinished run actionable.

### 11.3 Document the actual user flow and privacy boundary

- [ ] Add a concise README section covering:
  - opt in per repository;
  - app must be running, including hidden in the menu bar;
  - polling rather than webhooks or Codex Scheduled;
  - full-context versus limited-context behavior;
  - local-only SQLite and artifact storage;
  - no automatic GitHub posting;
  - existing manual submission remains explicit.
- [ ] Link the design spec and this implementation plan.

### 11.4 Run full verification

Automated:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run lint
bun run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Manual macOS flow:

1. Launch Reviewly with automatic reviews disabled. Confirm incoming PRs do not create runs.
2. Enable one test repository with no clone mapping. Assign a PR and confirm one limited-context run appears and notifies.
3. Trigger launch, focus, and manual refresh repeatedly. Confirm the same head still has one run.
4. Push a new head. Confirm one new run appears and a stale in-flight result cannot attach to it.
5. Create an Alex-authored pending GitHub review. Confirm Reviewly shows `existing draft` and does not load the diff or create a run.
6. Map a deliberately dirty local clone. Run the next head and confirm full-context mode, exact-line findings, cleanup, and unchanged clone status.
7. Quit during a run and relaunch. Confirm one recovery attempt and a visible final state.
8. Open every finding through `Open exact line`, including one left-side deletion.
9. Compare cockpit, Markdown, and JSON content; confirm the same SHAs, lines, comments, and context label.
10. Search logs and application data for a raw prompt, full diff, raw Codex output, and token. Confirm none is retained.
11. Use Reviewly's existing manual review flow separately. Confirm it still requires explicit user action and confirmation.

### 11.5 Final spec coverage review

- [ ] Search for placeholders and incomplete prose:

```bash
rg -n "TBD|TODO|implement later|similar to|appropriate error handling|handle edge cases" docs/superpowers/plans/2026-08-28-automated-pr-review-inbox.md src/lib/auto-review src/app/use-auto-review.ts src/components/auto-review src/routes/review-inbox.tsx
```

- [ ] Compare every design acceptance criterion with a test or a manual verification step above.
- [ ] Confirm no setting owner was duplicated.
- [ ] Confirm no N+1 candidate detail query was introduced.
- [ ] Confirm no second Git, Codex, notification, diff, router, or SQLite abstraction was introduced.
- [ ] Confirm `git diff --check` is clean and inspect the complete branch diff against `upstream/main`.

### 11.6 Commit the hardened feature

```bash
git add src/lib/auto-review/security.test.ts src/lib/auto-review/integration.test.ts src/lib/auto-review/coordinator.ts src/lib/auto-review/db.ts src/app/use-auto-review.ts README.md .github/workflows/ci.yml
git commit -m "test: harden automated review lifecycle"
```

---

## Acceptance Traceability

| Design requirement | Implementation task | Primary verification |
| --- | --- | --- |
| Per-repository opt-in, default off | Task 2 | Config tests and manual flow 1-2 |
| One run per PR head SHA | Tasks 1 and 6 | DB and coordinator dedupe tests |
| Pending GitHub draft skips all work | Tasks 3 and 6 | Pending guard spy test and manual flow 5 |
| One shared incoming query, no N+1 | Task 3 | Rust projection test and final query audit |
| Existing poller drives automation | Task 6 | Wake-source integration test |
| Closing the window keeps work alive; Quit stops it | Tasks 6 and 11 | Existing close-to-tray path and manual restart flow |
| One Codex process at a time | Task 6 | Claim-order coordinator test |
| Read-only Codex and no automated GitHub writes | Tasks 4 and 11 | Rust argument and static dependency tests |
| Exact current diff lines | Tasks 5 and 7 | Side-aware validation and navigation tests |
| Existing diff viewer handles Open exact line | Task 7 | Route and visual checks |
| Full local context without touching active clone | Task 8 | Temporary-repository and dirty-clone checks |
| Worktree mode reuses the existing Git boundary | Task 8 | Rust command and timeout-helper tests |
| Clear limited-context path | Tasks 5, 7, and 10 | Prompt, UI, and artifact snapshots |
| No-concerns runs complete and notify | Tasks 6 and 10 | Coordinator and notification tests |
| Recent authored-review tone | Task 9 | GraphQL fixture, stable-profile, and prompt tests |
| Fixed supportive/direct style rules | Task 5 | Prompt and forbidden-style tests |
| Durable history and restart recovery | Tasks 1, 6, and 11 | DB and lifecycle integration tests |
| Deterministic Markdown and JSON | Task 10 | Export snapshots |
| Native notifications and quiet hours | Task 10 | Timer, dedupe, and manual macOS checks |
| Failures, supersession, export errors, and recovery are actionable | Tasks 7, 10, and 11 | State-model and lifecycle integration tests |
| Existing settings owners stay authoritative | Tasks 2 and 11 | Ownership tests and final duplicate-owner audit |
| Existing explicit manual posting remains | Tasks 7 and 11 | No-write test and manual flow 11 |
| Existing primitives reused | All tasks | Final owner and duplicate-abstraction audit |
