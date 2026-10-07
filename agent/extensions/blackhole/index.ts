import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAutoCompactThreshold, loadBlackholeConfig } from "./config.js";
import {
    collectTouchedFiles,
    compileVccSummary,
    rawTokensSinceLastCompaction,
} from "./compaction.js";
import {
    ANSI_BLUE,
    ANSI_ORANGE,
    ANSI_RESET,
    ANSI_WHITE,
    buildOmCompactionSummary,
    cleanupOrphanedPendingFiles,
    notifyWorkerAction,
    readPendingState,
    registerConsolidationHooks,
} from "./om.js";

export default function (pi: ExtensionAPI): void {
    const config = loadBlackholeConfig();

    // ── 1. Background Workers (Observational Memory) ──
    registerConsolidationHooks(pi);

    // ── 2. Proactive Auto-Compaction Trigger ──
    let autoCompactionController: AbortController | null = null;
    let compactInFlight = false;

    pi.on("agent_start", () => {
        if (autoCompactionController) {
            autoCompactionController.abort();
            autoCompactionController = null;
            compactInFlight = false;
        }
    });

    pi.on("agent_end", async (_event, ctx) => {
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
                `${ANSI_BLUE}󰃢 [blackhole:compaction]${ANSI_RESET}${ANSI_WHITE} - threshold reached (${ANSI_RESET}${ANSI_ORANGE}~${tokens.toLocaleString()} tokens${ANSI_RESET}${ANSI_WHITE}); auto-compacting session${ANSI_RESET}`,
                `${ANSI_WHITE}Context usage (${ANSI_RESET}${ANSI_ORANGE}${tokens.toLocaleString()}${ANSI_RESET}${ANSI_WHITE} / ${contextWindow.toLocaleString()}) exceeded threshold (${threshold.toLocaleString()}). Triggering VCC compaction...${ANSI_RESET}`,
            );
        }

        void (async () => {
            try {
                await new Promise((resolve) => setTimeout(resolve, 0));

                let isIdle = false;
                while (!isIdle) {
                    if (signal.aborted) return;
                    if (ctx.sessionManager?.getSessionId?.() !== sessionId) return;

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

                autoCompactionController = null;

                ctx.compact?.({
                    onComplete: () => {
                        compactInFlight = false;
                    },
                    onError: (err) => {
                        compactInFlight = false;
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
                compactInFlight = false;
                autoCompactionController = null;
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
            if (config.compaction === "off") return;
            const sessionId = ctx.sessionManager?.getSessionId?.();
            const omSummary = sessionId ? buildOmCompactionSummary(sessionId) : "";
            const messages = (event.preparation?.messagesToSummarize ||
                ctx.sessionManager?.buildSessionProjection?.()?.messages ||
                []) as Array<{
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
    pi.registerCommand("blackhole", {
        description: "Blackhole compaction & memory management",
        handler: async (args, ctx) => {
            const sub = (args || "").trim().toLowerCase();
            if (sub === "cleanup") {
                const report = cleanupOrphanedPendingFiles();
                ctx.ui.notify(
                    `Cleaned up ${report.removed} stale pending files (${report.preserved} active preserved).`,
                    "info",
                );
            } else if (sub === "memory" || sub === "status") {
                const sessionId = ctx.sessionManager?.getSessionId?.() || "";
                const state = readPendingState(sessionId);
                ctx.ui.notify(
                    `Observational Memory: ${state.observations.length} observations, ${state.reflections.length} reflections recorded.`,
                    "info",
                );
            } else {
                ctx.ui.notify("Usage: /blackhole [cleanup | memory]", "info");
            }
        },
    });

    // ── 4. Unified Recall Tool ──
    pi.registerTool({
        name: "recall",
        label: "Recall",
        description:
            "Search session history and earlier lines omitted, file write/edit content by text/regex. " +
            "Expand entries (#N), drill-down file content (#N:path) or message text (#N:text) with paging, or aggregate touched files (mode:touched). " +
            "Responses are capped at a character budget; #N:text / #N:path page the full stored payload.",
        promptSnippet:
            "Search session history + file write/edit content by text/regex. #N expand, #N:path / #N:text drill-down with optional :offset:limit or :full, mode:file/touched.",
        promptGuidelines: [
            "Use recall — literal text/regex search across session history and file write/edit content. #N expands an entry; #N:path with optional :offset:limit or :full drills down into file content; #N:text pages a message body; 12-char hex ids recover observation/reflection sources. mode:file for file-content-only, mode:touched for aggregated files-by-path. scope:'all' to search the full session. If no results, try fewer terms or a regex pattern.",
            "Use recall — when a drill-down path matches multiple files, options are listed. Narrow with a more specific path substring. Only full-file writes are indexed for text search (edit diffs are not).",
        ],
        parameters: Type.Object({
            query: Type.Optional(
                Type.String({
                    description:
                        "Text/regex search; #N expands entry; #N:path drills file (#N:file auto-selects); #N:text pages a message body; #N:path:full all lines; #N:path:offset:limit range; 12-char hex for observations. Only full-file writes indexed.",
                }),
            ),
            expand: Type.Optional(
                Type.Array(Type.Number(), {
                    description:
                        "Entry indices to return full untruncated content for. Standalone or with query.",
                }),
            ),
            page: Type.Optional(
                Type.Number({
                    description: "Page number (1-based) for paginated results. Default: 1.",
                }),
            ),
            scope: Type.Optional(
                StringEnum(["lineage", "all"] as const, {
                    description:
                        "Search scope. lineage = active lineage (default), all = entire session.",
                }),
            ),
            mode: Type.Optional(
                StringEnum(["hybrid", "file", "touched"] as const, {
                    description:
                        "What content to search. hybrid (default) = all session content. file = file content only. touched = files-by-path summary with entry indices.",
                }),
            ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const maxChars = config.recallResponseMaxChars || 4000;
            const messages = (
                params.scope === "all"
                    ? (ctx.sessionManager?.getEntries?.() || [])
                          .filter((e) => e.type === "message" && "message" in e)
                          .map((e) => (e as { message: unknown }).message)
                    : ctx.sessionManager?.buildSessionProjection?.()?.messages || []
            ) as Array<{
                role?: string;
                content?: unknown;
            }>;
            const query = (params.query || "").trim();

            // 1. Hex Memory ID lookup (12-char hex)
            if (/^[a-f0-9]{12}$/.test(query)) {
                const sessionId = ctx.sessionManager?.getSessionId?.() || "";
                const state = readPendingState(sessionId);
                const obs = state.observations.find((o) => o.id === query);
                const ref = state.reflections.find((r) => r.id === query);
                if (obs || ref) {
                    const text = obs
                        ? `[Observation ${obs.id}] (${new Date(obs.createdAt).toISOString()}):\n${obs.text}`
                        : `[Reflection ${ref!.id}] (${new Date(ref!.createdAt).toISOString()}):\n${ref!.text}`;
                    return { content: [{ type: "text", text }], details: undefined };
                }
            }

            // 2. Touched files aggregation (mode: "touched")
            if (params.mode === "touched") {
                const touched = collectTouchedFiles(messages, ctx.cwd);
                const text =
                    touched.length > 0
                        ? `Files touched in session (${touched.length}):\n${touched.map((f) => `- ${f}`).join("\n")}`
                        : "No files touched in session.";
                return { content: [{ type: "text", text }], details: undefined };
            }

            // 3. Entry drill-down (#N:text or #N:path)
            const drillDownMatch = query.match(/^#(\d+):(.+)$/);
            if (drillDownMatch) {
                const idx = Number.parseInt(drillDownMatch[1], 10);
                const target = drillDownMatch[2].trim();
                const msg = messages[idx];
                if (!msg) {
                    return {
                        content: [{ type: "text", text: `Entry #${idx} not found.` }],
                        details: undefined,
                    };
                }
                if (target.startsWith("text")) {
                    const body = Array.isArray(msg.content)
                        ? msg.content.map((c) => (c as { text?: string })?.text || "").join("\n")
                        : String(msg.content || "");
                    return {
                        content: [{ type: "text", text: body.slice(0, maxChars) }],
                        details: undefined,
                    };
                }
                if (Array.isArray(msg.content)) {
                    const tc = msg.content.find((b) => {
                        const args =
                            (
                                b as {
                                    arguments?: Record<string, unknown>;
                                    args?: Record<string, unknown>;
                                }
                            ).arguments || (b as { args?: Record<string, unknown> }).args;
                        const p = String(args?.path || args?.file || "");
                        return p.includes(target);
                    });
                    if (tc) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(tc, null, 2).slice(0, maxChars),
                                },
                            ],
                            details: undefined,
                        };
                    }
                }
            }

            // 4. Standalone Expand parameter
            if (params.expand && params.expand.length > 0) {
                const expandedEntries = params.expand.map((idx) => {
                    const msg = messages[idx];
                    return msg
                        ? `[#${idx} ${msg.role || "unknown"}]:\n${JSON.stringify(msg, null, 2)}`
                        : `[#${idx}]: not found`;
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: expandedEntries.join("\n\n---\n\n").slice(0, maxChars),
                        },
                    ],
                    details: undefined,
                };
            }

            if (!query) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Session contains ${messages.length} messages. Specify a query or #N index to inspect.`,
                        },
                    ],
                    details: undefined,
                };
            }

            // 5. Simple index lookup (#N)
            const indexMatch = query.match(/^#(\d+)$/);
            if (indexMatch) {
                const targetIdx = Number.parseInt(indexMatch[1], 10);
                const targetMsg = messages[targetIdx];
                if (!targetMsg) {
                    return {
                        content: [
                            { type: "text", text: `Entry #${targetIdx} not found in session.` },
                        ],
                        details: undefined,
                    };
                }
                const serialized = JSON.stringify(targetMsg, null, 2);
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                serialized.slice(0, maxChars) +
                                (serialized.length > maxChars ? "\n... (truncated)" : ""),
                        },
                    ],
                    details: undefined,
                };
            }

            // 6. Paginated keyword/regex search with mode filter
            const candidateMessages =
                params.mode === "file"
                    ? messages
                          .map((m, idx) => ({ m, idx }))
                          .filter(({ m }) => {
                              if (!Array.isArray(m.content)) return false;
                              return m.content.some(
                                  (b) => (b as { type?: string })?.type === "toolCall",
                              );
                          })
                    : messages.map((m, idx) => ({ m, idx }));

            const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            const hits: string[] = [];
            for (const { m, idx } of candidateMessages) {
                const text = Array.isArray(m.content)
                    ? m.content.map((c) => (c as { text?: string })?.text || "").join(" ")
                    : String(m.content || "");
                if (regex.test(text)) {
                    hits.push(`[#${idx} ${m.role || "unknown"}]: ${text.slice(0, 200)}...`);
                }
            }

            const pageSize = 5;
            const page = Math.max(1, params.page || 1);
            const totalPages = Math.max(1, Math.ceil(hits.length / pageSize));
            const pageHits = hits.slice((page - 1) * pageSize, page * pageSize);
            const outputHeader = `Matches for "${query}" (page ${page}/${totalPages}, total ${hits.length}):\n\n`;
            const output =
                hits.length > 0
                    ? outputHeader + pageHits.join("\n\n")
                    : `No matches found for query "${query}".`;

            return {
                content: [
                    {
                        type: "text",
                        text:
                            output.slice(0, maxChars) +
                            (output.length > maxChars ? "\n... (truncated)" : ""),
                    },
                ],
                details: undefined,
            };
        },
    });
}
