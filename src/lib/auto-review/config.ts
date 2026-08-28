export type CodexReasoningEffort = "" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AutomatedCodexDefaults {
  model?: string | null;
  reasoning?: CodexReasoningEffort | null;
  timeoutSecs?: number | null;
}

export interface AutomatedCodexOverrides {
  model?: string | null;
  reasoning?: CodexReasoningEffort | null;
}

export interface AutomatedCodexConfig {
  provider: "codex";
  model?: string;
  reasoningEffort?: Exclude<CodexReasoningEffort, "">;
  timeoutSecs?: number;
}

export const AUTO_REVIEW_DEFAULTS = {
  artifactDirectoryName: "artifacts",
  toneLookbackDays: 90,
  toneSampleLimit: 40,
  toneRefreshHours: 24,
} as const;

export interface AutoReviewRepoSource {
  owner: string;
  repo: string;
  path: string;
  remoteUrl: string;
}

export interface AutoReviewRepoOption {
  repo: string;
  context: "full" | "limited" | "invalid";
  localPath: string | null;
}

function remoteRepo(url: string): string | null {
  const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Build the settings list from Reviewly's existing repository sources. */
export function collectAutoReviewRepos(input: {
  watched: string[];
  incoming: string[];
  local: AutoReviewRepoSource[];
}): AutoReviewRepoOption[] {
  const localByRepo = new Map(
    input.local.map((item) => [`${item.owner}/${item.repo}`.toLowerCase(), item] as const),
  );
  const repos = new Set([
    ...input.watched,
    ...input.incoming,
    ...input.local.map((item) => `${item.owner}/${item.repo}`),
  ]);

  return [...repos]
    .sort((a, b) => a.localeCompare(b))
    .map((repo) => {
      const local = localByRepo.get(repo.toLowerCase());
      if (!local) return { repo, context: "limited" as const, localPath: null };
      return {
        repo,
        context: remoteRepo(local.remoteUrl) === repo.toLowerCase() ? "full" : "invalid",
        localPath: local.path,
      };
    });
}

/** Resolve the Codex-only settings used by automatic reviews. Repository
 * values are optional overrides; blank values inherit the app defaults. */
export function resolveAutomatedCodexConfig(
  defaults: AutomatedCodexDefaults,
  overrides?: AutomatedCodexOverrides,
): AutomatedCodexConfig {
  const model = overrides?.model?.trim() || defaults.model?.trim();
  const reasoning = overrides?.reasoning || defaults.reasoning;

  return {
    provider: "codex",
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoningEffort: reasoning } : {}),
    ...(defaults.timeoutSecs && defaults.timeoutSecs > 0
      ? { timeoutSecs: defaults.timeoutSecs }
      : {}),
  };
}
