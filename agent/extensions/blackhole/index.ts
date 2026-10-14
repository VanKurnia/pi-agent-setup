import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { getExtensionApi, getParentLinkGlobal } from "../shared/cross-extension-api.js";
import { setBlackholeSnapshotApi } from "../shared/blackhole-api.js";
import type { SubagentParentLink, SubagentsApi } from "../subagents/src/core.js";
import { getAutoCompactThreshold, loadBlackholeConfig } from "./config.js";
import {
    collectTouchedFiles,
    compileVccSummary,
    rawTokensSinceLastCompaction,
} from "./compaction.js";
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
} from "./om.js";

/** Build a case-insensitive regex; an invalid pattern falls back to a literal search. */
function safeRegex(query: string): RegExp {
    try {
        return new RegExp(query, "i");
    } catch {
        return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
}

interface DrillWindow {
    selector: string;
    offset: number;
    limit?: number;
    full: boolean;
}

/**
 * Parse the `#N:<selector>[:<offset>:<limit>|:full]` drill-down syntax. Trailing
 * segments only count as a window when they are `full` or two numbers, so paths
 * keeps their colons intact.
 */
function parseDrillWindow(raw: string): DrillWindow {
    const parts = raw.split(":");
    const last = parts[parts.length - 1] ?? "";
    let full = false;
    let offset = 0;
    let limit: number | undefined;
    if (last === "full") {
        full = true;
        parts.pop();
    } else if (/^\d+$/.test(last) && /^\d+$/.test(parts[parts.length - 2] ?? "")) {
        limit = Number(parts.pop());
        offset = Number(parts.pop());
    }
    return { selector: parts.join(":").trim(), full, offset, limit };
}

/**
 * One window of a drill-down payload plus the range it covers, so a caller can page
 * through a long entry instead of only ever seeing its head.
 */
function windowPayload(
    body: string,
    window: DrillWindow,
    continueHint: string,
    maxChars: number,
): string {
    if (window.full) {
        return `${body}\n[chars 0-${body.length} of ${body.length}]`;
    }
    const start = Math.min(window.offset, body.length);
    const size = Math.min(window.limit ?? maxChars, maxChars);
    const end = Math.min(start + size, body.length);
    const next = end < body.length ? ` — continue with ${continueHint}:${end}:${size}` : "";
    return `${body.slice(start, end)}\n[chars ${start}-${end} of ${body.length}]${next}`;
}

export default function (pi: ExtensionAPI): void {
    const config = loadBlackholeConfig();

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
        parameters: Type.Object({
            query: Type.Optional(
                Type.String({
                    description:
                        "Text/regex search; #N expands entry; #N:text reads a message body; #N:file / #N:<path> reads a tool-call payload; append :offset:limit or :full to page a long entry; 12-char hex recovers an observation/reflection. mode:file searches tool-call payloads (write/edit arguments) and message text.",
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
            source: Type.Optional(
                StringEnum(["current", "parent"] as const, {
                    description:
                        "Which session to read. current (default) = own session. parent = delegating parent session; only resolves inside a subagent child run.",
                }),
            ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const maxChars = config.recallResponseMaxChars || 4000;
            // Recall target: own session by default; delegating parent on
            // source:"parent". The child->parent link is registered by the
            // subagent dispatcher per run and cleared on dispose — parent reads
            // are always explicit and mutate neither session.
            const childSessionId: string = ctx.sessionManager?.getSessionId?.() || "";
            let targetManager: any = ctx.sessionManager;
            let omSessionId = childSessionId;
            let readCwd: string = ctx.cwd;
            if (params.source === "parent") {
                const api = getExtensionApi<SubagentsApi>("subagents");
                // Registry first; globalThis fallback covers loader module
                // isolation (per-extension jiti instances) and children that
                // never load the provider extension at all.
                const link =
                    api?.resolveParentLink(childSessionId) ??
                    getParentLinkGlobal<SubagentParentLink>(childSessionId);
                if (!link?.parentSessionManager) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: api
                                    ? `No parent session linked to this session (child: ${childSessionId || "unknown"}). source:"parent" only works inside a subagent child run dispatched from a parent session.`
                                    : 'Subagents extension API not available in this session and no parent link found; source:"parent" needs a dispatcher-registered parent link.',
                            },
                        ],
                        details: undefined,
                    };
                }
                targetManager = link.parentSessionManager;
                omSessionId = link.parentSessionId;
                readCwd = link.parentCwd || ctx.cwd;
            }
            const messages = (
                params.scope === "all"
                    ? (
                          (targetManager?.getEntries?.() || []) as Array<{
                              type?: string;
                              message?: unknown;
                          }>
                      )
                          .filter((e) => e.type === "message" && "message" in e)
                          .map((e) => (e as { message: unknown }).message)
                    : targetManager?.buildSessionProjection?.()?.messages || []
            ) as Array<{
                role?: string;
                content?: unknown;
            }>;
            const query = (params.query || "").trim();

            // 1. Hex Memory ID lookup (12-char hex)
            if (/^[a-f0-9]{12}$/.test(query)) {
                const state = readPendingState(omSessionId);
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
                const touched = collectTouchedFiles(messages, readCwd);
                const text =
                    touched.length > 0
                        ? `Files touched in session (${touched.length}):\n${touched.map((f) => `- ${f}`).join("\n")}`
                        : "No files touched in session.";
                return { content: [{ type: "text", text }], details: undefined };
            }

            // 3. Entry drill-down (#N:text, #N:file or #N:<path>), optionally windowed
            const drillDownMatch = query.match(/^#(\d+):(.+)$/);
            if (drillDownMatch) {
                const idx = Number.parseInt(drillDownMatch[1], 10);
                const drill = parseDrillWindow(drillDownMatch[2].trim());
                const msg = messages[idx];
                if (!msg) {
                    return {
                        content: [{ type: "text", text: `Entry #${idx} not found.` }],
                        details: undefined,
                    };
                }
                const continueHint = `#${idx}:${drill.selector}`;
                if (drill.selector.startsWith("text")) {
                    const body = Array.isArray(msg.content)
                        ? msg.content.map((c) => (c as { text?: string })?.text || "").join("\n")
                        : String(msg.content || "");
                    return {
                        content: [
                            {
                                type: "text",
                                text: windowPayload(body, drill, continueHint, maxChars),
                            },
                        ],
                        details: undefined,
                    };
                }
                if (Array.isArray(msg.content)) {
                    const callArgs = (b: unknown): Record<string, unknown> | undefined => {
                        const block = b as {
                            arguments?: Record<string, unknown>;
                            args?: Record<string, unknown>;
                        };
                        return (block?.arguments || block?.args) as
                            Record<string, unknown> | undefined;
                    };
                    const tc = msg.content.find((b) => {
                        const args = callArgs(b);
                        if (!args) return false;
                        const p = String(args.path || args.file || args.filePath || "");
                        if (!p) return false;
                        return drill.selector === "file" ? true : p.includes(drill.selector);
                    });
                    if (tc) {
                        const body = JSON.stringify(tc, null, 2);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: windowPayload(body, drill, continueHint, maxChars),
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
            // Text a message contributes to a search: its text blocks plus, for
            // mode:"file", the JSON of its tool-call arguments (where write/edit
            // file content lives).
            const messageSearchText = (
                m: { content?: unknown },
                includeToolArgs: boolean,
            ): string =>
                Array.isArray(m.content)
                    ? m.content
                          .map((c) => {
                              const block = c as {
                                  type?: string;
                                  text?: string;
                                  arguments?: unknown;
                                  args?: unknown;
                              };
                              if (
                                  includeToolArgs &&
                                  block?.type === "toolCall" &&
                                  (block.arguments || block.args)
                              ) {
                                  return JSON.stringify(block.arguments ?? block.args);
                              }
                              return block?.text || "";
                          })
                          .join(" ")
                    : String(m.content || "");

            // mode:"file" only searches messages that carry tool-call payloads.
            const candidateMessages = messages
                .map((m, idx) => ({ m, idx }))
                .filter(
                    ({ m }) =>
                        params.mode !== "file" ||
                        (Array.isArray(m.content) &&
                            m.content.some((b) => (b as { type?: string })?.type === "toolCall")),
                );

            const regex = safeRegex(query);
            const hits: string[] = [];
            for (const { m, idx } of candidateMessages) {
                const text = messageSearchText(m, params.mode === "file");
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
