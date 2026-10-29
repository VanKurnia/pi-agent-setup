import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { setBlackholeSnapshotApi } from "../shared/blackhole-api.ts";
import { recallParams } from "./recall-schema.ts";
import { getAutoCompactThreshold, getBlackholeConfigPath, loadBlackholeConfig } from "./config.ts";
import { compileVccSummary, rawTokensSinceLastCompaction } from "./compaction.ts";
import {
    ANSI_BLUE,
    ANSI_GREEN,
    ANSI_ORANGE,
    ANSI_RESET,
    ANSI_WHITE,
    buildOmCompactionSummary,
    cleanupOrphanedPendingFiles,
    notifyWorkerAction,
    readPendingState,
    registerConsolidationHooks,
} from "./om.ts";

export default function (pi: ExtensionAPI): void {
    // Publish the snapshot provider for cross-extension consumers (subagents'
    // delegation snapshot). Global-backed: the module registry does not cross
    // extension boundaries under the loader's per-extension jiti instances.
    setBlackholeSnapshotApi({ compileVccSummary, buildOmCompactionSummary });

    // ── 1. Background Workers (Observational Memory) ──
    registerConsolidationHooks(pi);

    // ── 2. Proactive Auto-Compaction Trigger ──
    let autoCompactionController: AbortController | null = null;
    let compactInFlight = false;

    /** Release the auto-compaction latch and its abort handle. */
    function releaseLatch(): void {
        compactInFlight = false;
        autoCompactionController = null;
    }

    function abortInFlightCompaction(): void {
        if (autoCompactionController) {
            autoCompactionController.abort();
            releaseLatch();
        }
    }

    pi.on("agent_start", () => {
        abortInFlightCompaction();
    });

    // Store files of sessions that no longer exist are unreachable, so reap them
    // on every start instead of waiting for a manual /blackhole-prune.
    pi.on("session_start", (_event, ctx) => {
        const keepSessionId = ctx.sessionManager?.getSessionId?.();
        const { removed } = cleanupOrphanedPendingFiles(keepSessionId || undefined);
        if (removed > 0) {
            ctx.ui.notify(`blackhole: reaped ${removed} orphaned store files.`, "info");
        }
    });

    pi.on("agent_settled", async (event, ctx) => {
        if ((event as { aborted?: boolean }).aborted) {
            abortInFlightCompaction();
            return;
        }

        const currentConfig = loadBlackholeConfig();
        if (currentConfig.compaction === "off" || currentConfig.compaction === "manual") return;
        if (compactInFlight) return;

        const contextWindow = ctx.model?.contextWindow || 128000;
        const threshold = getAutoCompactThreshold(currentConfig, contextWindow);

        const branch = (ctx.sessionManager?.getBranch?.() || []) as Array<{
            type: string;
            message?: unknown;
        }>;
        if (branch.length === 0) return;

        // Skip if branch already ends with a compaction entry
        if (branch[branch.length - 1]?.type === "compaction") return;

        const usage = ctx.getContextUsage?.();
        const tokens = usage?.tokens != null ? usage.tokens : rawTokensSinceLastCompaction(branch);

        if (tokens < threshold) return;

        // Threshold reached: schedule deferred compaction
        compactInFlight = true;
        const controller = new AbortController();
        autoCompactionController = controller;
        const signal = controller.signal;
        const sessionId = ctx.sessionManager?.getSessionId?.();

        if (currentConfig.showWorkerMessages !== false) {
            notifyWorkerAction(
                pi,
                "compaction",
                `${ANSI_ORANGE}󰃢${ANSI_RESET} ${ANSI_BLUE}[blackhole:compaction]${ANSI_RESET}${ANSI_WHITE} - threshold reached (${ANSI_RESET}${ANSI_GREEN}~${tokens.toLocaleString()} tokens${ANSI_RESET}${ANSI_WHITE}); auto-compacting session${ANSI_RESET}`,
                `${ANSI_WHITE}Context usage (${ANSI_RESET}${ANSI_GREEN}${tokens.toLocaleString()}${ANSI_RESET}${ANSI_WHITE} / ${contextWindow.toLocaleString()}) exceeded threshold (${threshold.toLocaleString()}). Triggering VCC compaction...${ANSI_RESET}`,
            );
        }

        void (async () => {
            try {
                await new Promise((resolve) => setTimeout(resolve, 0));

                let isIdle = false;
                const IDLE_WAIT_MAX_MS = 120_000;
                const idleDeadline = Date.now() + IDLE_WAIT_MAX_MS;
                while (!isIdle) {
                    if (signal.aborted) return;
                    if (ctx.sessionManager?.getSessionId?.() !== sessionId) return;
                    if (Date.now() > idleDeadline) {
                        // Session stayed busy; release the latch so a later
                        // agent_settled can try again instead of disabling
                        // auto-compaction for the rest of the session.
                        releaseLatch();
                        return;
                    }

                    isIdle = ctx.isIdle ? ctx.isIdle() : true;
                    if (!isIdle) {
                        const sliceMs = 50;
                        const end = Date.now() + 200;
                        while (Date.now() < end) {
                            if (signal.aborted) return;
                            await new Promise((resolve) => setTimeout(resolve, sliceMs));
                        }
                    }
                }

                if (signal.aborted) return;

                const currentBranch = (ctx.sessionManager?.getBranch?.() || []) as Array<{
                    type: string;
                    message?: unknown;
                }>;
                if (
                    currentBranch.length === 0 ||
                    currentBranch[currentBranch.length - 1]?.type === "compaction"
                ) {
                    return;
                }

                const currentUsage = ctx.getContextUsage?.();
                const currentTokens =
                    currentUsage?.tokens != null
                        ? currentUsage.tokens
                        : rawTokensSinceLastCompaction(currentBranch);
                if (currentTokens < threshold) return;

                // Handed to the host: detach the abort handle but keep the latch
                // held until the host reports completion.
                autoCompactionController = null;

                const COMPACTION_SETTLE_TIMEOUT_MS = 600_000;
                // The host may never report completion: release the latch anyway,
                // so one stuck compaction cannot disable every future one.
                const settleTimer = setTimeout(releaseLatch, COMPACTION_SETTLE_TIMEOUT_MS);

                ctx.compact?.({
                    onComplete: () => {
                        clearTimeout(settleTimer);
                        releaseLatch();
                    },
                    onError: (err) => {
                        clearTimeout(settleTimer);
                        releaseLatch();
                        const msg = err?.message || String(err);
                        if (
                            msg === "Compaction cancelled" ||
                            msg.includes("Nothing to compact") ||
                            msg.includes("Already compacted")
                        ) {
                            return;
                        }
                        ctx.ui?.notify?.(`Blackhole compaction error: ${msg}`, "error");
                    },
                });
            } catch {
                releaseLatch();
            }
        })();
    });

    // ── 3. VCC Compaction Hook ──
    pi.on(
        "session_before_compact",
        async (
            event: SessionBeforeCompactEvent,
            ctx: ExtensionContext,
        ): Promise<SessionBeforeCompactResult | void> => {
            const config = loadBlackholeConfig();
            if (config.compaction === "off") return;
            // "pi-default" defers to the host's own summarizer.
            if (config.compactionEngine === "pi-default") return;
            const sessionId = ctx.sessionManager?.getSessionId?.();
            const omSummary = sessionId ? buildOmCompactionSummary(sessionId) : "";
            // A split turn passes its earlier part separately
            // (compaction.d.ts: turnPrefixMessages); without it, file edits made
            // before the split disappear from ### Files Touched.
            const messages = [
                ...(event.preparation?.turnPrefixMessages || []),
                ...(event.preparation?.messagesToSummarize ||
                    ctx.sessionManager?.buildSessionProjection?.()?.messages ||
                    []),
            ] as Array<{
                role?: string;
                content?: unknown;
            }>;

            const summary = compileVccSummary({
                messages,
                previousSummary: event.preparation?.previousSummary,
                cwd: ctx.cwd,
                omSummary,
            });

            if (summary && summary.trim().length > 0) {
                return {
                    compaction: {
                        summary,
                        firstKeptEntryId: event.preparation.firstKeptEntryId,
                        tokensBefore: event.preparation.tokensBefore,
                    },
                };
            }
        },
    );

    // ── 3. Commands ──
    pi.registerCommand("blackhole-prune", {
        description: "Prune orphaned blackhole store files",
        handler: async (_args, ctx) => {
            const report = cleanupOrphanedPendingFiles();
            ctx.ui.notify(
                `Cleaned up ${report.removed} orphaned store files (${report.preserved} active preserved).`,
                "info",
            );
        },
    });
    pi.registerCommand("blackhole-memory", {
        description: "Show blackhole observation/reflection counts",
        handler: async (_args, ctx) => {
            const sessionId = ctx.sessionManager?.getSessionId?.() || "";
            const state = readPendingState(sessionId);
            ctx.ui.notify(
                `Observational Memory: ${state.observations.length} observations, ${state.reflections.length} reflections recorded.`,
                "info",
            );
        },
    });
    pi.registerCommand("blackhole-model", {
        description: "Edit blackhole models and pi-blackhole-config.json settings",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify(
                    `Blackhole settings live in ${getBlackholeConfigPath()} (no interactive menu in this mode).`,
                    "info",
                );
                return;
            }
            const { editBlackholeSettings } = await import("./settings-ui.ts");
            await editBlackholeSettings(ctx);
        },
    });

    // ── 4. Unified Recall Tool ──
    pi.registerTool({
        name: "recall",
        label: "Recall",
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
        description:
            "Search session history and earlier lines omitted, file write/edit content by text/regex. " +
            "Expand entries (#N); read one entry's text (#N:text) or a tool-call payload (#N:file, #N:<path>) with paging (:offset:limit, :full); aggregate touched files (mode:touched). " +
            "Each drill-down window reports [chars X-Y of N] so the next window can be requested; :full returns the whole payload.",
        promptSnippet:
            "Search your own earlier session history and file write/edit payloads by text or regex",
        promptGuidelines: [
            "Use recall — literal text/regex search across session history and file write/edit payloads. If nothing matches, retry with fewer terms or a different pattern.",
            "Use recall — when a drill-down path matches several files, the options are listed; narrow it with a more specific path substring.",
            "Use recall — source:'parent' reads the delegating parent session's history + OM instead of your own. Only works inside a subagent child run; default stays 'current' so parent reads are always explicit, never implicit.",
        ],
        parameters: recallParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const { runRecallTool } = await import("./recall-tool.ts");
            return runRecallTool(params, ctx);
        },
    });
}
