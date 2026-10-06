import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadBlackholeConfig } from "./config.js";
import { compileVccSummary } from "./compaction.js";
import {
    buildOmCompactionSummary,
    cleanupOrphanedPendingFiles,
    readPendingState,
    registerConsolidationHooks,
} from "./om.js";

export default function (pi: ExtensionAPI): void {
    const config = loadBlackholeConfig();

    // ── 1. Background Consolidation Pipeline ──
    registerConsolidationHooks(pi);

    // ── 2. VCC Compaction Hook ──
    pi.on("session_before_compact", async (event: unknown, ctx: unknown) => {
        if (config.compaction === "off") return;
        const c = ctx as {
            sessionManager?: {
                getSessionId?: () => string;
                buildSessionProjection?: () => { messages?: unknown[] };
            };
            cwd?: string;
        };
        const sessionId = c.sessionManager?.getSessionId?.();
        const omSummary = sessionId ? buildOmCompactionSummary(sessionId) : "";
        const messages = (c.sessionManager?.buildSessionProjection?.()?.messages || []) as Array<{
            role?: string;
            content?: unknown;
        }>;

        const summary = compileVccSummary({
            messages,
            previousSummary: (event as { previousSummary?: string })?.previousSummary,
            cwd: c.cwd,
            omSummary,
        });

        if (summary) {
            (event as { customInstructions?: string }).customInstructions = summary;
        }
    });

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
            const messages = (ctx.sessionManager?.buildSessionProjection?.()?.messages ||
                []) as Array<{
                role?: string;
                content?: unknown;
            }>;
            const query = (params.query || "").trim();

            if (!query && !params.expand?.length) {
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

            // Simple index lookup (#N)
            const indexMatch = query.match(/^#(\d+)/);
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

            // Keyword / regex search
            const results: string[] = [];
            const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            messages.forEach((msg, idx) => {
                const text = Array.isArray(msg.content)
                    ? msg.content.map((c) => (c as { text?: string })?.text || "").join(" ")
                    : String(msg.content || "");
                if (regex.test(text)) {
                    results.push(`[#${idx} ${msg.role || "unknown"}]: ${text.slice(0, 200)}...`);
                }
            });

            const output =
                results.length > 0
                    ? results.join("\n\n")
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
