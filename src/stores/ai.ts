import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AiProvider = "claude" | "codex" | "gemini" | "openai";

/** Providers that are a local CLI on PATH (vs. the HTTP OpenAI-compatible one). */
export const CLI_PROVIDERS: AiProvider[] = ["claude", "codex", "gemini"];

/** Short display name per provider (the "Thinking with …" label). */
export const PROVIDER_LABEL: Record<AiProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  openai: "your model",
};

/**
 * Common models per CLI provider — just suggestions for the free-text model
 * field (it accepts any id the CLI understands, so new models work without a
 * code change). Fable is a Claude model; each CLI takes its own set.
 */
export const MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  claude: [
    "default",
    "sonnet",
    "opus",
    "haiku",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-fable-5",
  ],
  codex: ["gpt-5-codex", "gpt-5", "o3", "o4-mini", "gpt-4.1"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-exp"],
  openai: [],
};

interface State {
  /** Which backend to use for reviews. */
  provider: AiProvider;
  setProvider: (provider: AiProvider) => void;
  /**
   * OpenAI-compatible endpoint config — used when provider === "openai".
   * Covers Ollama (local), LM Studio, OpenRouter, DeepSeek, Groq, etc.
   */
  baseUrl: string;
  model: string;
  /** Optional bearer key; local servers like Ollama need none. */
  apiKey: string;
  setOpenai: (cfg: Partial<Pick<State, "baseUrl" | "model" | "apiKey">>) => void;
  /** Optional model override per CLI provider (claude/codex/gemini). Empty = the CLI's own default. */
  cliModels: Partial<Record<AiProvider, string>>;
  setCliModel: (provider: AiProvider, model: string) => void;
  /** How long an AI run may take before it's stopped, in seconds. `null` =
   * automatic (the backend picks 3 min, or 7 min when the PR's clone is present). */
  aiTimeoutSecs: number | null;
  setAiTimeoutSecs: (secs: number | null) => void;
}

export const useAiProvider = create<State>()(
  persist(
    (set) => ({
      provider: "claude",
      setProvider: (provider) => set({ provider }),
      baseUrl: "",
      model: "",
      apiKey: "",
      setOpenai: (cfg) => set(cfg),
      cliModels: {},
      setCliModel: (provider, model) =>
        set((s) => ({ cliModels: { ...s.cliModels, [provider]: model } })),
      aiTimeoutSecs: null,
      setAiTimeoutSecs: (aiTimeoutSecs) => set({ aiTimeoutSecs }),
    }),
    { name: "reviewly.ai", storage: sqlStorage<State>() },
  ),
);

/**
 * Extra invoke args for the `ai_review` / `ai_review_bg` commands. Carries the
 * OpenAI-compatible config when that provider is selected; the CLI providers
 * just get `{ provider }` and ignore the rest.
 */
export function aiInvokeArgs(): {
  provider: AiProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutSecs?: number;
} {
  const s = useAiProvider.getState();
  // `null`/0 → omit so the Rust side keeps its automatic default.
  const timeout = s.aiTimeoutSecs && s.aiTimeoutSecs > 0 ? { timeoutSecs: s.aiTimeoutSecs } : {};
  if (s.provider !== "openai") {
    const model = s.cliModels[s.provider]?.trim();
    return { provider: s.provider, ...(model ? { model } : {}), ...timeout };
  }
  return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, ...timeout };
}
