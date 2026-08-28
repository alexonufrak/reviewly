# Automated PR Review Inbox

**Status:** Approved design, pending implementation plan
**Date:** 2026-08-28
**Base:** Reviewly 0.1.8, forked from `volnei/reviewly`
**Target:** Local macOS-first Tauri application

## Summary

Extend Reviewly into a local review cockpit that automatically prepares a private preliminary review whenever GitHub requests a review from the signed-in user. The app polls through Reviewly's existing GitHub worker, runs Codex locally in a read-only sandbox, validates every suggested comment against the current PR head and diff, and stores the result in Reviewly's SQLite database with deterministic Markdown and JSON exports.

The automated path never posts to GitHub. Reviewly's existing manual review controls remain available and unchanged. A review can reach GitHub only after the user opens the app, chooses a verdict, and explicitly confirms the existing submission flow.

## Goals

- Detect open, non-draft pull requests with `review-requested:@me` through the existing 60-second poller.
- Run a preliminary Codex review automatically for each enabled repository.
- Review every newly observed head SHA exactly once, including force-pushes and follow-up commits.
- Skip analysis when the signed-in user already has a `PENDING` GitHub review on the PR, avoiding a competing draft.
- Use an isolated temporary worktree when a matching local clone is configured.
- Fall back to a clearly labeled diff-only review when no local clone is available.
- Produce concise, paste-ready comments with exact file and line placement.
- Match the user's recent GitHub review voice while enforcing fixed style rules.
- Notify after every completed review, including reviews with no concerns.
- Keep a lightweight, offline-friendly history in SQLite and export every completed run as Markdown and JSON.
- Preserve Reviewly's current architecture and manual review workflow so upstream changes remain practical to merge.

## Non-goals for v1

- GitHub webhooks or a hosted service.
- Codex Scheduled task integration or visibility in the Codex Scheduled interface.
- Automatic GitHub comments, reviews, approvals, or change requests.
- Cloud sync, team collaboration, or shared review history.
- Replacing Reviewly's existing guided tour, chat, layered review, or manual submission features.
- Automatically adding generated findings to a GitHub review draft. The first version provides Copy and Open exact line actions.
- Windows and Linux release work beyond keeping shared code portable where practical.

## User flows

### First-time configuration

1. The user signs into GitHub through Reviewly's existing OAuth device flow.
2. The user selects repositories to watch and maps local clones using Reviewly's current repository settings.
3. The user enables automatic review per repository. Newly discovered repositories default to off.
4. The user selects an app-level Codex model and reasoning effort, with optional per-repository overrides.
5. Reviewly refreshes recent reviews authored by the signed-in GitHub account and builds an editable style profile.
6. The user enables launch at login. Closing the window leaves Reviewly running in the menu bar; choosing Quit stops polling and review execution.

### New review request

1. Reviewly's existing poller detects a new PR in `review-requested:@me`.
2. The coordinator reconciles through the shared incoming-review GraphQL projection, which supplies the base SHA, head SHA, and whether the signed-in user already has a pending review.
3. If an authored `PENDING` review exists, the queue shows `existing draft` from live GitHub state and Reviewly does not inspect the diff, create a run, or start Codex.
4. If automatic review is enabled and no run exists for that repository, PR number, and head SHA, it creates a queued run.
5. If a mapped clone is available, Reviewly fetches the PR head and creates a detached temporary worktree without switching or modifying the user's working branch.
6. Codex runs in the worktree with read-only sandboxing. The prompt includes PR metadata, the current diff, relevant conversation, the tone profile, and the required output schema.
7. Reviewly validates the response, rechecks the live head SHA, stores the run and findings, writes Markdown and JSON artifacts, and removes the temporary worktree.
8. A native notification appears for every completed review. Selecting the PR in the app opens the prepared review.

### Updated PR head

1. The existing poller emits a change event.
2. Reconciliation sees that the requested PR has a head SHA not present in review history.
3. A new run is queued for that SHA, even if an earlier head was already reviewed.
4. The cockpit keeps both runs and defaults to the newest non-superseded result.

### PR changes during analysis

1. A run starts against head SHA A.
2. GitHub reports head SHA B before finalization.
3. The SHA A run is marked superseded and is not presented as current.
4. Reviewly queues SHA B immediately. It does not notify as though SHA A were a completed current review.

### No concerns

1. Validation accepts a result with an empty findings list.
2. The run is stored as completed with a short `looks good from my side` conclusion.
3. Reviewly sends the same completion notification used for reviews with findings.

### Failure and recovery

1. GitHub failures use bounded retries with backoff and preserve the queued run.
2. Malformed Codex output receives one schema-repair attempt.
3. A persistent failure is stored visibly with a useful error and a Retry action.
4. On wake, reconnect, or launch, reconciliation resumes queued work and recovers stale running records.

## Product behavior

### Review Cockpit

Add a dedicated review-inbox route while retaining Reviewly's existing sidebar and PR detail routes. The route uses the approved three-part layout:

1. Existing application navigation.
2. A queue of assigned PRs and recent review runs.
3. The selected prepared review.

The queue reuses the dashboard's `DashboardPr` incoming-review projection and extracts the existing inbox row/view-model behavior into a shared component. It must not introduce a second source of PR assignment truth or duplicate the dashboard's repository, author, age, CI, and review-state formatting.

The visual treatment should stay close to a quiet native macOS app:

- Keep the existing macOS vibrancy at the window level.
- Use opaque reading surfaces for comments and evidence.
- Use restrained status color and comfortable information density.
- Avoid decorative dashboards or oversized summary cards.
- Compose the existing `PageHeader`, `ScrollArea`, resizable panels, empty state, tooltip, icon-button, and PR-row styling primitives.
- Preserve keyboard navigation already used elsewhere in Reviewly.

Each queue row shows repository, PR number, title, author, current head status, context mode, and run state. Completed rows distinguish `findings`, `no concerns`, and `limited context` without turning the list into a severity dashboard.

### Finding presentation

The paste-ready comment is the primary content. Supporting evidence appears below it and may be collapsed. Each finding provides:

- File and exact line or tight line range.
- Diff side for placement.
- Copy action.
- Open exact line action.
- Category and confidence as quiet secondary metadata.
- A short evidence snippet when it materially helps the user verify the comment.

The Open action navigates to Reviewly's current PR detail route with `file`, `line`, and `side` search parameters. `PRDetailPage` consumes those parameters through its existing `activeFile`, `focusLine`, and diff-viewer focus behavior. The cockpit does not implement a second diff viewer. A GitHub link is also stored for the exact head or base line when a stable line link can be constructed.

### Existing manual submission

The existing review composer and `gh_submit_review` command remain intact. Automated-review modules do not import, receive, or invoke any GitHub mutation command. Moving a generated comment into the existing draft is deliberately outside v1.

This gives the user the current Reviewly workflow when they decide to post:

1. Inspect the prepared review.
2. Open the PR diff.
3. Copy the comments they agree with.
4. Choose Comment, Approve, or Request changes in Reviewly's existing dialog.
5. Confirm submission explicitly.

## Tone and comment rules

### Fixed rules

These rules are part of the application prompt. The machine-checkable subset is also enforced by the validator. Automatically learned style and user edits cannot override them.

- Sound like a supportive engineer while remaining direct.
- Lead with the question, concern, or requested verification.
- Do not restate the implementation or explain the author's own code back to them.
- Do not add ceremonial praise or a list of obvious positives.
- Use a practical consequence only when it makes the concern clearer.
- Do not use em dashes.
- Do not use stock AI phrasing or AI attribution.
- Use ordinary punctuation and paragraph breaks when they improve legibility.
- Use a short list only when it materially improves understanding.
- Do not use code fences or inline-code markup in generated review comments.
- Refer to a method by its useful short name instead of reproducing a fully qualified signature.
- Avoid technical exposition when a shorter direct question or observation works.
- When the change is sound, keep the conclusion brief: `looks good from my side`.
- Add an overall review summary only when it contributes information not already present in inline comments.

### Recent-review learning

The tone refresher reads a bounded set of the most recent submitted reviews and inline review comments authored by the signed-in GitHub user. It runs on first setup, on launch when stale, and at most once per 24 hours unless manually refreshed.

The app stores:

- The recent source samples and their GitHub identifiers.
- A hash of the active sample set.
- An automatically generated style profile.
- A separate user-editable override.

When the sample-set hash changes, Reviewly may regenerate the automatic profile. It never overwrites the user's override. The automated-review prompt receives recent examples, the generated profile, the override, and finally the fixed rules in that order.

Empty approval bodies, generated bot reviews, and duplicate comments are excluded from tone samples. The UI shows when the profile was last refreshed and which GitHub account supplied it.

## Architecture

```mermaid
flowchart LR
    GH[GitHub read APIs] --> Poller[Existing GitHub poller]
    Poller --> Reconcile[Auto-review reconciliation hook]
    Tone[Tone refresher] --> Reconcile
    Reconcile --> Queue[(SQLite run queue)]
    Queue --> Context[Context preparer]
    Context --> Worktree[Temporary worktree]
    Context --> Diff[Diff-only fallback]
    Worktree --> Codex[Existing Codex bridge]
    Diff --> Codex
    Codex --> Validate[Parser and finding validator]
    Validate --> Runs[(SQLite runs and findings)]
    Runs --> Export[Atomic Markdown and JSON export]
    Runs --> Cockpit[Review Cockpit]
    Runs --> Notify[Native notification]
    Cockpit --> Manual[Existing manual review flow]
    Manual --> GHWrite[GitHub write API after confirmation]
```

### Reused Reviewly primitives

- `src-tauri/src/workers/github_poll.rs` remains the only periodic GitHub poller.
- `src/app/use-realtime-events.ts` remains the bridge from poller events into the WebView.
- The incoming portion of `gh_dashboard` remains the source for requested-review metadata. Its shared GraphQL projection is extended with base SHA, head SHA, and authored-pending-review state instead of adding per-PR detail requests.
- `src-tauri/src/commands/ai.rs` remains the provider process bridge. Automated review uses `ai_review_bg`, `ai_inflight`, `ai_tasks`, and `ai:done` with the existing Codex path and read-only sandbox.
- `src/lib/ai/json.ts` remains the shared model-output JSON utility. Automated review uses its fence stripping and safe primitive coercion while keeping the final finding contract strict.
- `src/stores/ai.ts` remains the source for app-level Codex model and timeout configuration and is extended with reasoning effort. A provider-specific resolver reads Codex settings for automation without changing the provider selected for manual AI features.
- `src/stores/review-prefs.ts` remains the source for user-authored AI review instructions. Those instructions are included before the automated-review fixed rules.
- `src/stores/local-repos.ts` remains the source for repository-to-clone mappings.
- `src-tauri/src/commands/git.rs` remains the system Git execution boundary. Its existing process, timeout, repository-inspection, and worktree primitives are extended or extracted for temporary review worktrees.
- `src-tauri/src/lib.rs` remains the centralized SQLite migration registry.
- `src/lib/sql-storage.ts` and the existing `reviewly.db` remain the settings and application database.
- `src/stores/notif-settings.ts`, `src/app/use-notif-sync.ts`, and the notification fields in `AppState` remain the single notification preference and delivery configuration path.
- `src/stores/app-behavior.ts`, `tauri-plugin-autostart`, the tray worker, and close-to-tray behavior remain the application-lifecycle path.
- The router, sidebar, dashboard incoming rows, PR detail focus state, diff viewer, and review composer remain in place and are composed by the new cockpit.

### New modules

Keep new behavior isolated so upstream merges remain understandable:

- `src/lib/auto-review/`: domain types, database access, reconciliation, prompt construction, parsing, validation, export models, and tone-profile logic.
- `src/app/use-auto-review.ts`: the single app-wide coordinator hook.
- `src/components/auto-review/`: queue, run detail, finding card, empty, limited-context, and failure states.
- `src/routes/review-inbox.tsx`: the cockpit route.
- `src/stores/auto-review.ts`: automation-only preferences, such as artifact-root and tone-refresh controls, persisted through existing SQL-backed Zustand storage. It must not duplicate AI, notification, application-behavior, review-instruction, or local-repository settings.
- `src-tauri/src/commands/auto_review.rs`: atomic artifact write, retry, and delete operations with application-data path containment. It does not duplicate AI, Git, notification, or queue orchestration.
- `src-tauri/src/clients/github.rs`: shared read-only projections needed for tone samples or current-head verification when an existing endpoint cannot provide them. No second GitHub client or retry stack is introduced.

Changes to existing files should be limited to shared-query fields, background-task key routing, shared Git helpers, route registration, sidebar navigation, settings controls, migrations, command registration, and the app-wide hook mount.

### Existing settings ownership

Configuration stays with the current owner instead of being copied into an automated-review store:

- App-level Codex model and timeout remain in `useAiProvider`; reasoning effort is added beside them. Automated review resolves the Codex entry explicitly and overlays repository overrides without changing the provider used by guided review or chat.
- Custom engineering guidance remains in `useReviewPrefs.aiInstructions`.
- Desktop notification enablement, reasons, polling cadence, and quiet hours remain in `useNotifSettings` and continue syncing through `useNotifSync`.
- Launch-at-login, start-in-tray, confirmation, and the new review-inbox landing option remain in `useAppBehavior`.
- Clone mappings remain in `useLocalRepos`.
- Per-repository automatic-review enablement and model/reasoning overrides remain in the relational `auto_review_repo_settings` table because they must participate in queue reconciliation and querying.

## Execution model

The main WebView remains loaded when Reviewly is hidden in the menu bar, including when the app starts hidden. The coordinator therefore lives in one app-wide React hook, while each Codex process runs in Reviewly's existing Rust background-task mechanism so navigation does not interrupt it.

The coordinator wakes on:

- Authentication becoming ready.
- App launch.
- `pr:new`.
- `pr:changed`.
- Network reconnect and system wake when detectable.
- A low-frequency reconciliation timer as a safety net.
- Manual Retry.

Each wake reconciles against one shared incoming-review GraphQL projection for all enabled repositories. That projection includes the candidate identity, base SHA, head SHA, and authored-pending-review state. The coordinator must not fetch `gh_get_pull` once per candidate merely to learn those fields.

V1 executes one automated review at a time. This keeps local CPU use predictable, avoids multiple Codex processes competing for context, and simplifies recovery. The database uniqueness constraint makes all wake sources idempotent.

Before adding the automated-review consumer, Reviewly defines explicit background AI task keys for guided, layered, and automated work. Automated runs use `auto-review:<run-id>`. Event listeners classify keys before parsing so one AI surface can never interpret another surface's output. The common completion payload and actionable error-hint formatting are shared instead of copied into a third listener.

Before spawning Codex through the existing `ai_review_bg` command, the coordinator persists the run as running. Completion is accepted only for the matching run ID and head SHA. If the WebView reloads, the coordinator checks Reviewly's current AI inflight registry and recovers stale running rows. A result event whose run is no longer current is ignored or marked superseded rather than attached to a newer head.

## Local context

### Worktree mode

When `src/stores/local-repos.ts` contains a valid clone mapping for the PR repository:

1. Verify the clone's remote corresponds to the requested repository.
2. Fetch the PR head into a namespaced local ref.
3. Create a detached worktree under Reviewly's cache directory, keyed by run ID.
4. Run Codex with that worktree as its working directory and with `read-only` sandboxing.
5. Include the authoritative GitHub diff in the prompt even though Codex can inspect the repository.
6. Remove the worktree and temporary ref in a finally-style cleanup path.

The user's active branch, index, untracked files, and existing worktrees are never changed.

Worktree preparation and cleanup extend the existing Git command boundary. They reuse its executable discovery, argument-based process spawning, timeout handling, repository inspection, and worktree parsing. Automated-review code must not add another shell wrapper or interpolate Git commands through a shell string.

### Diff-only mode

When no valid clone exists, the prompt includes PR metadata, changed-file patches, selected conversation context, and tone context. The resulting run is labeled `limited context` in the queue, detail header, notification, Markdown, and JSON.

The app must not imply that diff-only analysis inspected call sites, runtime configuration, generated sources, or invariants outside the supplied patch.

## Structured result contract

Codex returns one JSON object with this semantic shape:

```json
{
  "conclusion": "findings | no_concerns",
  "overallComment": null,
  "findings": [
    {
      "category": "correctness | security | data | concurrency | performance | maintainability | test_coverage | question",
      "confidence": "high | medium | low",
      "path": "src/example.ts",
      "line": 42,
      "endLine": 42,
      "side": "RIGHT",
      "comment": "Could this return before the write finishes and leave the next request reading stale data?",
      "evidence": "The promise is started here but is not awaited before the response returns."
    }
  ]
}
```

The parser accepts only this contract. It reuses `stripFence`, `tryJson`, `toInt`, and other safe primitives from `src/lib/ai/json.ts`, but it does not salvage a partial findings array from truncated output. Markdown fences around the JSON may be stripped, but prose mixed with the result is invalid. A malformed response receives one repair pass with the original output and schema, then fails visibly.

## Finding validation

A finding is stored only when all applicable checks pass:

- Path exists in the current PR diff.
- Line and side map to a commentable line using the existing `parsePatch` hunk representation.
- The line range is ordered and tight.
- Comment is non-empty and does not contain forbidden markup or an em dash.
- Comment does not claim access beyond the run's context mode.
- Evidence is short and corresponds to the selected file or line.
- The PR head still matches the run's head SHA.

Low-confidence findings remain visible but sort after higher-confidence findings. A run may complete with zero findings after invalid suggestions are removed. The result view can show that suggestions were discarded without retaining the raw model response.

Stable GitHub links use the reviewed commit SHA. Right-side findings link to the head; left-side findings link to the base. Reviewly's in-app Open action remains the authoritative placement experience because it can use the parsed PR diff directly.

## Data model

Add forward-only SQLite migrations after the current migration version.

### `auto_review_repo_settings`

- `repo TEXT PRIMARY KEY`
- `enabled INTEGER NOT NULL DEFAULT 0`
- `model_override TEXT`
- `reasoning_override TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Local clone paths are not duplicated here. The existing `reviewly.local-repos` setting remains authoritative.

### `auto_review_runs`

- `id TEXT PRIMARY KEY`
- `repo TEXT NOT NULL`
- `pr_id INTEGER NOT NULL`
- `pr_number INTEGER NOT NULL`
- `pr_title TEXT NOT NULL`
- `pr_url TEXT NOT NULL`
- `author_login TEXT NOT NULL`
- `base_sha TEXT NOT NULL`
- `head_sha TEXT NOT NULL`
- `status TEXT NOT NULL`
- `trigger TEXT NOT NULL`
- `context_mode TEXT`
- `provider TEXT NOT NULL DEFAULT 'codex'`
- `model TEXT`
- `reasoning TEXT`
- `conclusion TEXT`
- `overall_comment TEXT`
- `tone_sample_hash TEXT`
- `queued_at INTEGER NOT NULL`
- `started_at INTEGER`
- `completed_at INTEGER`
- `error_code TEXT`
- `error_message TEXT`
- `repair_count INTEGER NOT NULL DEFAULT 0`
- `superseded_by_head_sha TEXT`
- `json_artifact_path TEXT`
- `markdown_artifact_path TEXT`
- `export_error TEXT`
- Unique index on `(repo, pr_number, head_sha)`.
- Indexes on `status`, `queued_at`, and `(repo, pr_number, completed_at)`.

Allowed run states are `queued`, `running`, `completed`, `failed`, and `superseded`.

### `auto_review_findings`

- `id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL` with cascade delete.
- `ordinal INTEGER NOT NULL`
- `category TEXT NOT NULL`
- `confidence TEXT NOT NULL`
- `path TEXT NOT NULL`
- `line INTEGER NOT NULL`
- `end_line INTEGER NOT NULL`
- `side TEXT NOT NULL`
- `comment TEXT NOT NULL`
- `evidence TEXT`
- `github_url TEXT`
- Unique index on `(run_id, ordinal)`.

### `review_tone_samples`

- `source_id TEXT PRIMARY KEY`
- `source_kind TEXT NOT NULL`
- `repo TEXT NOT NULL`
- `pr_number INTEGER NOT NULL`
- `body TEXT NOT NULL`
- `submitted_at TEXT NOT NULL`
- `fetched_at INTEGER NOT NULL`

### `review_style_profile`

- Singleton `id INTEGER PRIMARY KEY CHECK (id = 1)`.
- `sample_hash TEXT`
- `generated_profile TEXT NOT NULL DEFAULT ''`
- `user_override TEXT NOT NULL DEFAULT ''`
- `generated_at INTEGER`
- `refreshed_at INTEGER`
- `last_error TEXT`

Global settings continue through their existing SQL-backed Zustand owners. `useAiProvider` owns the app-level Codex model, reasoning effort, and timeout. `useNotifSettings` owns notification enablement and quiet hours. `useAppBehavior` owns launch and landing behavior. `useReviewPrefs` owns custom engineering instructions. The automation-specific store contains only artifact and tone-refresh preferences.

## Artifacts

SQLite is the source for the app UI. Every completed run is also exported under Reviewly's application-data directory:

```text
artifacts/
  owner/
    repo/
      pull-123/
        <head-sha>/
          review.json
          review.md
```

JSON contains a versioned schema, PR identity, exact SHAs, context mode, model settings, tone-sample hash, conclusion, findings, timestamps, and stable links. Markdown contains the same information in a readable form with paste-ready comments and placement instructions.

Exports are deterministic for a stored run and use temporary-file plus rename semantics. A completed database record remains valid when export fails. The run shows the export error and provides Retry export. Full diffs, repository contents, raw prompts, and raw Codex responses are not retained.

Deleting a run from the app deletes its findings and exported files after explicit confirmation. Compact history otherwise remains until the user deletes it.

## Notifications and quiet hours

Extend Reviewly's existing notification settings, `useNotifSync` bridge, Rust `AppState`, and native notification plugin. Add local completion and failure reasons beside the existing GitHub reasons instead of creating an automated-review notification settings stack. Send an alert for:

- Completed with findings.
- Completed with no concerns.
- Completed with limited context.
- Failed after retries, with a Retry affordance in the app.

Do not notify for unchanged polling cycles, queued runs, ordinary retries, or superseded results. Quiet hours in the existing notification store delay the alert, not the review run. Pending alerts are delivered when quiet hours end, with duplicate suppression by run ID. Delayed-delivery records may live with the automated run, but notification preferences have one source of truth.

## Security and privacy

- Continue using Reviewly's OAuth device flow and OS keychain token storage.
- Keep existing manual write capabilities because Reviewly's manual review workflow remains part of the product.
- Automated-review code uses only read commands and has no dependency on `gh_submit_review`, comment creation, label mutation, reviewer mutation, or merge commands.
- Codex always runs with Reviewly's read-only sandbox flag.
- Temporary worktrees are scoped to Reviewly's cache directory and removed after each run.
- Do not log tokens, raw diffs, complete prompts, review samples, or raw model responses.
- Tone samples and findings stay local in SQLite and local artifacts.
- No telemetry or Reviewly-hosted service is introduced.

## Error handling and state recovery

- GitHub rate limits and transient failures use the existing bounded retry behavior where available.
- Context preparation failures fall back to diff-only only when the GitHub diff remains complete enough to review; otherwise the run fails.
- Codex timeout and process errors fail the run with an actionable message.
- A malformed response gets one repair attempt and no unbounded model loop.
- Cleanup runs after success, failure, cancellation, or supersession. Orphan cleanup also runs on launch.
- Running rows without a matching Rust inflight task are recovered on launch. They return to queued once, then fail if the same recovery condition repeats.
- Artifact export failure does not discard a successfully validated review.
- A database migration failure prevents the feature from starting and leaves existing Reviewly data untouched.

## Testing strategy

Introduce focused tests around the new pure domain modules instead of relying only on end-to-end checks.

### TypeScript tests

- Reconciliation deduplicates `(repo, PR, head SHA)`.
- A new head SHA queues a new run.
- Disabled and newly discovered repositories do not queue.
- A PR with an authored `PENDING` review is skipped before diff loading or Codex execution.
- Stale and removed assignments do not start.
- Shared incoming-review projection supplies base SHA, head SHA, and pending-review state without per-candidate detail calls.
- Structured-output parsing and the single repair boundary.
- Background AI task-key routing prevents guided, layered, and automated consumers from parsing each other's results.
- Exact diff-line and side validation.
- Exact-line route parameters activate the existing PR detail focus behavior.
- Fixed tone rules, including em dash and markup rejection.
- No-concerns completion.
- Superseded-head handling.
- Export model determinism.
- Quiet-hour notification deduplication.

### Rust tests

- Safe worktree naming and path containment.
- Remote/repository identity validation.
- Temporary-worktree commands reuse the existing Git execution and timeout helpers.
- Cleanup on success and failure.
- Atomic artifact replacement.
- Codex argument construction always includes read-only sandboxing.

### Integration tests

- SQLite migrations from the current Reviewly schema.
- Full coordinator flow with fake GitHub data and a fake Codex result.
- Malformed result followed by a successful repair.
- Mid-run head change.
- Offline launch followed by reconnect.
- App restart with queued and stale-running jobs.
- Completion and failure notifications.
- AI, notification, application-behavior, review-instruction, and local-repository preferences each retain one existing source of truth.
- Static dependency test ensuring auto-review modules do not reference GitHub mutation command names.

Existing CI continues to run typecheck, lint, frontend build, and Cargo check. The implementation adds the chosen TypeScript test runner and `cargo test --locked` to CI.

## Rollout

1. Add schema and domain types, extend the existing settings owners, and add repository opt-in controls behind an `automatic reviews` feature flag that defaults off.
2. Extract the shared incoming-review projection and background AI task-key routing, then add reconciliation, fake-Codex tests, run history, and the cockpit UI.
3. Extend the existing Git boundary with isolated worktree preparation and cleanup, then add diff-only fallback.
4. Add tone refresh and editable profile.
5. Add artifact export, notifications, failure recovery, and orphan cleanup.
6. Run the app locally against a test repository with automatic posting structurally absent.
7. Enable one repository, compare generated comments against recent authored reviews, and tune only the prompt/profile boundaries that fail the agreed style.
8. Enable additional repositories individually.

## Acceptance criteria

- Enabling a repository causes a newly assigned PR to receive one local review run for its current head SHA without user interaction.
- A PR with an Alex-authored `PENDING` review is skipped before its diff is inspected and no local review run is created.
- Updating the PR queues one and only one run for the new head SHA.
- Reconciliation obtains all candidate SHAs and pending-review state through one shared incoming-review query rather than an N+1 detail-request loop.
- Closing the window does not stop polling or an active review; choosing Quit does.
- No automated path invokes a GitHub write endpoint.
- Every stored finding maps to an exact current diff line and offers Copy and Open exact line.
- Open exact line uses the existing PR detail route, active-file state, and diff focus behavior rather than a second diff implementation.
- Runs with no findings complete and notify normally.
- The generated comments satisfy the fixed style constraints and use recent authored reviews as tone context.
- Worktree mode never changes the user's active clone state and always cleans up temporary worktrees.
- Worktree mode reuses Reviewly's existing Git executable, process, timeout, repository-inspection, and worktree primitives.
- Diff-only results are visibly labeled limited context.
- Completed runs survive app restart and export deterministic Markdown and JSON.
- Failures, superseded heads, export errors, and recovery states are visible and actionable.
- AI, notification, application-behavior, review-instruction, and local-repository settings are extended in place and are not duplicated by the automated-review feature.
- Existing manual Reviewly submission remains available only through explicit user action and confirmation.
