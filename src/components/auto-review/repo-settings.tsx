import { Card } from "@/components/card";
import { CollapsibleSection } from "@/components/collapsible-section";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  type AutoReviewRepoOption,
  type CodexReasoningEffort,
  collectAutoReviewRepos,
} from "@/lib/auto-review/config";
import { autoReviewDb } from "@/lib/auto-review/db";
import type { AutoReviewRepoSetting } from "@/lib/auto-review/types";
import type { Dashboard } from "@/lib/tauri";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAiProvider } from "@/stores/ai";
import { useLocalRepos } from "@/stores/local-repos";
import { useWatchedRepos } from "@/stores/watched-repos";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CircleAlert, Cloud, Laptop, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const REASONING_OPTIONS: Array<{ value: CodexReasoningEffort; label: string }> = [
  { value: "", label: "Model default" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

const SETTINGS_QUERY_KEY = ["auto-review-repo-settings"] as const;

function emptySetting(repo: string): AutoReviewRepoSetting {
  return {
    repo,
    enabled: false,
    modelOverride: null,
    reasoningOverride: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function AutomaticReviewSettingsSection() {
  const watched = useWatchedRepos((state) => state.repos);
  const local = useLocalRepos((state) => state.repos);
  const repoQualifier = useMemo(() => watched.map((repo) => `repo:${repo}`).join(" "), [watched]);
  const queryClient = useQueryClient();

  const dashboard = useQuery({
    queryKey: ["dashboard", repoQualifier],
    queryFn: () => invoke<Dashboard>("gh_dashboard", { repoQualifier }),
    staleTime: 60_000,
  });
  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => autoReviewDb.listRepoSettings(),
  });

  const options = useMemo(
    () =>
      collectAutoReviewRepos({
        watched: [...watched, ...(settings.data ?? []).map((item) => item.repo)],
        incoming: (dashboard.data?.incoming ?? []).map((item) => item.repo),
        local,
      }),
    [dashboard.data?.incoming, local, settings.data, watched],
  );

  const save = useMutation({
    mutationFn: (setting: AutoReviewRepoSetting) => autoReviewDb.setRepoSetting(setting),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      const previous = queryClient.getQueryData<AutoReviewRepoSetting[]>(SETTINGS_QUERY_KEY);
      queryClient.setQueryData<AutoReviewRepoSetting[]>(SETTINGS_QUERY_KEY, (current = []) => [
        ...current.filter((item) => item.repo !== next.repo),
        next,
      ]);
      return { previous };
    },
    onError: (_error, _next, context) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, context?.previous);
      toast.error("Could not save automatic review settings");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
  });

  function update(repo: string, patch: Partial<AutoReviewRepoSetting>) {
    const current =
      queryClient
        .getQueryData<AutoReviewRepoSetting[]>(SETTINGS_QUERY_KEY)
        ?.find((item) => item.repo === repo) ?? emptySetting(repo);
    save.mutate({ ...current, ...patch });
  }

  return (
    <CollapsibleSection id="automatic-reviews" title="Automatic reviews" icon={Bot}>
      <Card className="space-y-4">
        <AutomaticCodexDefaults />

        <div className="border-t border-hairline pt-4">
          <p className="text-xs font-medium text-foreground">Repositories</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Automatic review is off for every repository until you enable it here. Results stay
            private in Reviewly.
          </p>
        </div>

        {settings.isLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading repository settings…
          </div>
        ) : settings.isError ? (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive">
            <CircleAlert className="size-3.5 shrink-0" />
            Repository settings could not be loaded.
          </div>
        ) : options.length === 0 ? (
          <p className="rounded-lg bg-foreground/[0.03] px-3 py-3 text-xs text-muted-foreground">
            Watch a repository, map a local clone, or receive a review request to configure it.
          </p>
        ) : (
          <div className="divide-y divide-hairline rounded-xl border border-hairline">
            {options.map((option) => (
              <RepositorySettingRow
                key={option.repo}
                option={option}
                setting={
                  settings.data?.find((item) => item.repo === option.repo) ??
                  emptySetting(option.repo)
                }
                saving={save.isPending && save.variables?.repo === option.repo}
                onUpdate={(patch) => update(option.repo, patch)}
              />
            ))}
          </div>
        )}
      </Card>
    </CollapsibleSection>
  );
}

function AutomaticCodexDefaults() {
  const model = useAiProvider((state) => state.cliModels.codex ?? "");
  const setModel = useAiProvider((state) => state.setCliModel);
  const reasoning = useAiProvider((state) => state.codexReasoningEffort);
  const setReasoning = useAiProvider((state) => state.setCodexReasoningEffort);
  const timeout = useAiProvider((state) => state.aiTimeoutSecs);

  return (
    <div>
      <div className="flex items-start gap-2.5 rounded-xl bg-foreground/[0.03] px-3 py-2.5">
        <Bot className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Automatic reviews always use your local Codex CLI. Manual AI features keep using the
          backend selected above. The shared timeout is{" "}
          {timeout ? `${Math.round(timeout / 60)} min` : "automatic"}.
        </p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        {/* biome-ignore lint/a11y/noLabelWithoutControl: Input renders the native control */}
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Default Codex model
          </span>
          <Input
            value={model}
            onChange={(event) => setModel("codex", event.target.value)}
            placeholder="Codex default"
            size="sm"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div>
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Reasoning
          </span>
          <Select
            value={reasoning || "default"}
            onValueChange={(value) =>
              setReasoning(value === "default" ? "" : (value as CodexReasoningEffort))
            }
          >
            <SelectTrigger size="sm" className="w-full text-xs text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONING_OPTIONS.map((option) => (
                <SelectItem
                  key={option.value || "default"}
                  value={option.value || "default"}
                  className="text-xs"
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function RepositorySettingRow({
  option,
  setting,
  saving,
  onUpdate,
}: {
  option: AutoReviewRepoOption;
  setting: AutoReviewRepoSetting;
  saving: boolean;
  onUpdate: (patch: Partial<AutoReviewRepoSetting>) => void;
}) {
  const [model, setModel] = useState(setting.modelOverride ?? "");

  useEffect(() => setModel(setting.modelOverride ?? ""), [setting.modelOverride]);

  const context = {
    full: { label: "full local context", icon: Laptop, className: "text-success" },
    limited: { label: "limited diff context", icon: Cloud, className: "text-muted-foreground" },
    invalid: {
      label: "clone mapping needs attention",
      icon: CircleAlert,
      className: "text-warning",
    },
  }[option.context];
  const ContextIcon = context.icon;

  return (
    <div className="space-y-3 px-3 py-3 first:rounded-t-xl last:rounded-b-xl">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-xs font-medium text-foreground">{option.repo}</p>
            {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
          </div>
          <p className={cn("mt-0.5 flex items-center gap-1 text-[11px]", context.className)}>
            <ContextIcon className="size-3" />
            {context.label}
          </p>
        </div>
        <Switch
          checked={setting.enabled}
          onCheckedChange={(enabled) => onUpdate({ enabled })}
          label={`Automatic review for ${option.repo}`}
        />
      </div>

      {setting.enabled && (
        <div className="grid gap-3 border-t border-hairline pt-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Input renders the native control */}
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted-foreground">Model override</span>
            <Input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              onBlur={() => onUpdate({ modelOverride: model.trim() || null })}
              placeholder="Use app default"
              size="sm"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div>
            <span className="mb-1 block text-[11px] text-muted-foreground">Reasoning override</span>
            <Select
              value={setting.reasoningOverride ?? "default"}
              onValueChange={(value) =>
                onUpdate({ reasoningOverride: value === "default" ? null : value })
              }
            >
              <SelectTrigger size="sm" className="w-full text-xs text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONING_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value || "default"}
                    value={option.value || "default"}
                    className="text-xs"
                  >
                    {option.value ? option.label : "Use app default"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}
