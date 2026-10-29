import {
    buildSessionProjection,
    type AgentToolResult,
    type ExtensionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { getExtensionApi, getParentLinkGlobal } from "../shared/cross-extension-api.js";
import type { SubagentParentLink, SubagentsApi } from "../subagents/src/core.ts";
import { collectTouchedFiles } from "./compaction.ts";
import { loadBlackholeConfig } from "./config.ts";
import { readPendingState } from "./om.ts";
import type { RecallParams } from "./recall-schema.ts";

/** Build a case-insensitive regex; an invalid pattern falls back to a literal search. */
function safeRegex(query: string): RegExp {
    try {
        return new RegExp(query, "i");
    } catch {
        return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
}

/** Read and parse only the first line of a JSONL session file. Undefined on any
 * failure (missing file, short read, unparseable line). Session headers are one
 * short line, well under the chunk; a longer first line reads as unparseable. */
function readJsonFirstLine(filePath: string): Record<string, unknown> | undefined {
    let fd: number | undefined;
    try {
        fd = openSync(filePath, "r");
        const chunk = Buffer.alloc(8192);
        const bytes = readSync(fd, chunk, 0, chunk.length, 0);
        const line = chunk.toString("utf8", 0, bytes).split("\n")[0] ?? "";
        if (line.trim() === "") return undefined;
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        return parsed as Record<string, unknown>;
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch {
                // Descriptor already gone; nothing to clean up.
            }
        }
    }
}

/** Parent-file projection for out-of-process recall: per-line tolerant parse (a
 * concurrently-growing parent may end mid-line — skip blanks and bad lines,
 * never a whole-file parse), header lines dropped, full linear history via an
 * undefined leaf. Undefined unless the projection yields at least one message. */
function readFileSessionMessages(
    filePath: string,
): Array<{ role?: string; content?: unknown }> | undefined {
    let content: string;
    try {
        content = readFileSync(filePath, "utf8");
    } catch {
        return undefined;
    }
    const entries: SessionEntry[] = [];
    for (const line of content.split("\n")) {
        if (line.trim() === "") continue;
        try {
            const parsed: unknown = JSON.parse(line);
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                (parsed as { type?: unknown }).type !== "session" &&
                typeof (parsed as SessionEntry).id === "string"
            ) {
                entries.push(parsed as SessionEntry);
            }
        } catch {
            continue;
        }
    }
    if (entries.length === 0) return undefined;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const projection = buildSessionProjection(entries, undefined, byId).messages as Array<{
        role?: string;
        content?: unknown;
    }>;
    return projection.length > 0 ? projection : undefined;
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

/** Body of the `recall` tool. Lazy-loaded: the tool is call-only, so its code stays off the boot path. */
export async function runRecallTool(
    params: RecallParams,
    ctx: ExtensionContext,
): Promise<AgentToolResult<undefined>> {
    const maxChars = loadBlackholeConfig().recallResponseMaxChars || 4000;
    // Recall target: own session by default; delegating parent on
    // source:"parent". The child->parent link is registered by the
    // subagent dispatcher per run and cleared on dispose — parent reads
    // are always explicit and mutate neither session.
    const childSessionId: string = ctx.sessionManager?.getSessionId?.() || "";
    let targetManager: any = ctx.sessionManager;
    let omSessionId = childSessionId;
    let readCwd: string = ctx.cwd;
    // Assigned by the file-based parent fallback when the link is absent,
    // otherwise by the shared pipeline below.
    let messages: Array<{ role?: string; content?: unknown }> | undefined;
    if (params.source === "parent") {
        const api = getExtensionApi<SubagentsApi>("subagents");
        // Registry first; globalThis fallback covers loader module
        // isolation (per-extension jiti instances) and children that
        // never load the provider extension at all.
        const link =
            api?.resolveParentLink(childSessionId) ??
            getParentLinkGlobal<SubagentParentLink>(childSessionId);
        if (!link?.parentSessionManager) {
            // Out-of-process child (herdr pi-bolt): no live manager is
            // reachable, but the child's own session header records the
            // parent file. Resolve everything the pipeline below needs
            // (messages, omSessionId, readCwd) from disk — both paths come
            // from pi-written headers, never user input, and every failure
            // falls through to the existing error return.
            const ownFile: unknown = ctx.sessionManager?.getSessionFile?.();
            if (typeof ownFile === "string" && ownFile.length > 0) {
                const parentFile = readJsonFirstLine(ownFile)?.parentSession;
                if (typeof parentFile === "string" && parentFile.length > 0) {
                    const parentHeader = readJsonFirstLine(parentFile);
                    if (parentHeader?.type === "session" && typeof parentHeader.id === "string") {
                        const parentMessages = readFileSessionMessages(parentFile);
                        if (parentMessages) {
                            messages = parentMessages;
                            omSessionId = parentHeader.id;
                            readCwd =
                                typeof parentHeader.cwd === "string" && parentHeader.cwd.length > 0
                                    ? parentHeader.cwd
                                    : ctx.cwd;
                        }
                    }
                }
            }
            if (messages === undefined) {
                return {
                    content: [
                        {
                            type: "text",
                            text: api
                                ? `No parent session linked to this session (child: ${childSessionId || "unknown"}). source:"parent" only works inside a subagent child run dispatched from a parent session.`
                                : 'Subagent snapshot provider not available in this session and no parent link found; source:"parent" needs a dispatcher-registered parent link (herdr delegates via session header; disk fallback applies).',
                        },
                    ],
                    details: undefined,
                };
            }
        } else {
            targetManager = link.parentSessionManager;
            omSessionId = link.parentSessionId;
            readCwd = link.parentCwd || ctx.cwd;
        }
    }
    if (messages === undefined) {
        messages = (
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
    }
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
                return (block?.arguments || block?.args) as Record<string, unknown> | undefined;
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
                content: [{ type: "text", text: `Entry #${targetIdx} not found in session.` }],
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
    const messageSearchText = (m: { content?: unknown }, includeToolArgs: boolean): string =>
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
}
