import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CbmServices } from "../pi-tools/definitions.js";
import { CODEBASE_MEMORY_PROMPT } from "./prompt.js";

const AUTO_REFRESH_INTERVAL_MS = 60_000;

export function registerLifecycle(pi: ExtensionAPI, services: CbmServices) {
  let indexInFlight = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeCtx: ExtensionContext | undefined;

  async function indexCurrentRepo(ctx: ExtensionContext) {
    if (indexInFlight || ctx.signal?.aborted || ctx !== activeCtx) return;

    indexInFlight = true;
    function safeSetStatus(text: string) {
      if (ctx.signal?.aborted || ctx !== activeCtx) return;
      try {
        ctx.ui.setStatus("codebase-memory", text);
      } catch {
        // Silently ignore if ctx is stale after session reload
      }
    }

    try {
      const result = await services.projects.indexCurrentRepo(ctx.cwd, ctx.signal);
      if (result.status === "skipped") {
        safeSetStatus(`cbm skipped: ${result.reason}`);
        return;
      }

      const nodes = typeof result.nodes === "number" ? ` · ${result.nodes} nodes` : "";
      const edges = typeof result.edges === "number" ? ` · ${result.edges} edges` : "";
      safeSetStatus(`cbm ${result.project}${nodes}${edges}`);
    } catch (error) {
      if (ctx.signal?.aborted) return;
      const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
      safeSetStatus(`cbm index failed${reason}`);
    } finally {
      indexInFlight = false;
    }
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + CODEBASE_MEMORY_PROMPT,
  }));

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    services.settings.reload();
    if (refreshTimer) clearInterval(refreshTimer);

    void indexCurrentRepo(ctx);
    refreshTimer = setInterval(() => {
      void indexCurrentRepo(ctx);
    }, AUTO_REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    activeCtx = undefined;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
}
