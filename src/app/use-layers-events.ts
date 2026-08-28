import { type AiDone, classifyAiTaskKey, firstLineHint } from "@/lib/ai/tasks";
import { parseLayers } from "@/lib/layers";
import { subscribe } from "@/lib/tauri";
import { useLayers } from "@/stores/layers";
import { useLayersGen } from "@/stores/layers-gen";
import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Bridge the backend `ai:done` event for a LAYER-PLAN run into the stores.
 * `ai:done` is broadcast for every AI background task, so the prefix on the key
 * is what tells a layering apart from a guided tour; anything else is another
 * surface's result and is left alone. Mounted app-wide, so a plan started on one
 * screen still lands after navigating away or refreshing — the Rust task
 * outlives both.
 */
export function useLayersEvents() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await subscribe<AiDone>("ai:done", (e) => {
        const { key, ok, output, error, provider, headSha, canceled } = e.payload;
        const task = classifyAiTaskKey(key);
        if (task.kind !== "layers") return;
        const prKey = task.storeKey;
        const gen = useLayersGen.getState();
        gen.done(prKey);
        // Canceled by the user — just clear the pending state, no error/toast.
        if (canceled) return;
        const ref = prKey.split("/").pop() ?? prKey;
        if (!ok) {
          gen.fail(prKey, firstLineHint(error ?? "") || "The layer plan failed.");
          toast.error(`Layering failed · ${ref}`);
          return;
        }
        const plan = parseLayers(output ?? "");
        if (!plan) {
          const h = firstLineHint(output ?? "");
          gen.fail(
            prKey,
            h
              ? `The AI didn't return a usable split — it said: “${h}”`
              : "The AI didn't return a usable split. Try again, or split by structure.",
          );
          toast.error(`Layering failed · ${ref}`);
          return;
        }
        useLayers.getState().set(prKey, plan, { headSha: headSha ?? "", source: provider ?? "" });
        toast.success(`Layers ready · ${ref}`, {
          description: `${plan.layers.length} layers to read in order`,
        });
      });
    })();
    return () => unsub?.();
  }, []);
}
