/**
 * Boxed card for the `subagent` tool (fork addition — not vendored pi-style).
 *
 * The renderer patch replaces every tool's renderer, so subagents' own
 * `renderResult` never ran: a running subagent fell to the generic fallback,
 * which prints the call args (`Agent:/Title:/Task:`) plus the literal content
 * string `(running...)` and drops `details` entirely. This card keeps the
 * fork's box chrome and draws that payload instead — one row per agent, its
 * live tool rows while running, metrics once it settles, and the concatenated
 * output underneath.
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import {
    type BoxTheme,
    formatBoxedRunningStatus,
    formatMetricParts,
    formatToolName,
    formatToolOutputLine,
    getTextOutput,
    renderBoxedToolCall,
    renderBoxedToolResult,
    RUNNING_TITLE_GLYPH,
    selectRenderLines,
} from "./pistyle/shared/box.js";
import {
    type BoxedToolContext,
    type BoxedToolResult,
    noteBoxedCallState,
    noteBoxedResultPhase,
    noteExecutionStart,
    stateElapsedMs,
} from "./pistyle/features/tools/boxed/shared.js";
import {
    getToolsRenderConfig,
    isResultSeen,
} from "./pistyle/features/tools/boxed/session-config.js";

const SUBAGENT_TOOL_NAME = "subagent";
/** Call-card task preview before the expand hint, mirroring pi-style's 5-line cap. */
const COLLAPSED_TASK_LINES = 5;
/** Tool rows shown per agent while collapsed; expanding reveals the rest. */
const COLLAPSED_TOOL_ROWS = 6;
/** Result output lines shown while collapsed. */
const COLLAPSED_OUTPUT_LINES = 10;
/**
 * Collapsed line budget for the whole card. Deliberately not `previewLines`
 * (8): a multi-agent run needs its per-agent rows, the live tool rows and the
 * output, and the shared preview budget cut the payload off before the output
 * section could ever appear.
 */
const COLLAPSED_RUN_LINES = 24;

interface SubagentToolRow {
    tool?: unknown;
    args?: unknown;
}

interface SubagentProgress {
    status?: unknown;
    currentTool?: unknown;
    currentToolArgs?: unknown;
    recentTools?: SubagentToolRow[];
    toolCount?: unknown;
    tokens?: unknown;
    durationMs?: unknown;
    lastMessage?: unknown;
    error?: unknown;
}

interface SubagentUsage {
    turns?: unknown;
    input?: unknown;
    output?: unknown;
    cost?: unknown;
}

interface SubagentRow {
    agent?: unknown;
    title?: unknown;
    task?: unknown;
    exitCode?: unknown;
    output?: unknown;
    progress?: SubagentProgress;
    usage?: SubagentUsage;
}

interface SubagentDetails {
    mode?: unknown;
    results?: SubagentRow[];
    agentScope?: unknown;
}

/** True for the `subagent` tool this card owns. */
export function isSubagentTool(toolName: unknown): toolName is string {
    return toolName === SUBAGENT_TOOL_NAME;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `details` arrives untyped through the renderer bridge; read it defensively. */
function readDetails(result: BoxedToolResult | undefined): SubagentDetails | undefined {
    const details = result?.details;
    if (!details || typeof details !== "object") return undefined;
    const results = (details as SubagentDetails).results;
    if (!Array.isArray(results) || results.length === 0) return undefined;
    return details as SubagentDetails;
}

/** Single-line preview: newlines collapsed, cut to `max` characters. */
function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** First `max` logical lines of a task, for the call card. */
function taskPreviewLines(task: string, max: number): string[] {
    return task
        .replace(/\r/g, "")
        .split("\n")
        .slice(0, max)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function requestSummary(args: Record<string, unknown>): string {
    if (Array.isArray(args.hybrid) && args.hybrid.length > 0) {
        return `hybrid · ${args.hybrid.length} phases`;
    }
    if (Array.isArray(args.chain) && args.chain.length > 0) {
        const agents = args.chain.map((step: { agent?: unknown }) => asString(step?.agent) ?? "?");
        return `chain · ${agents.join(" → ")}`;
    }
    if (Array.isArray(args.tasks) && args.tasks.length > 0) {
        const agents = args.tasks.map((task: { agent?: unknown }) => asString(task?.agent) ?? "?");
        return `parallel · ${agents.join(", ")}`;
    }
    const agent = asString(args.agent);
    return agent ? `single · ${agent}` : "single";
}

/** Row lines for the call card: one per requested agent/task. */
function requestDetailLines(
    args: Record<string, unknown>,
    expanded: boolean,
    theme: BoxTheme,
): string[] {
    const maxLines = expanded ? Number.MAX_SAFE_INTEGER : COLLAPSED_TASK_LINES;
    const lines: string[] = [];
    const push = (agent: unknown, task: unknown, title: unknown): void => {
        const name = asString(agent) ?? "?";
        const label = asString(title);
        const body = asString(task);
        const head = `${theme.fg("accent", name)}${label ? theme.fg("dim", ` · ${label}`) : ""}`;
        lines.push(head);
        if (body) {
            for (const line of taskPreviewLines(body, maxLines)) {
                lines.push(`${theme.fg("muted", "  ")}${theme.fg("dim", line)}`);
            }
        }
    };

    if (Array.isArray(args.hybrid)) {
        for (const phase of args.hybrid) {
            if (phase?.mode === "single") {
                push(phase.agent, phase.task, phase.title);
            } else if (Array.isArray(phase?.tasks)) {
                lines.push(theme.fg("dim", `${phase.mode} · ${phase.tasks.length}`));
                for (const task of phase.tasks) push(task?.agent, task?.task, task?.title);
            }
        }
    } else if (Array.isArray(args.chain)) {
        for (const step of args.chain) push(step?.agent, step?.task, step?.title);
    } else if (Array.isArray(args.tasks)) {
        for (const task of args.tasks) push(task?.agent, task?.task, task?.title);
    } else {
        push(args.agent, args.task, args.title);
    }
    return lines;
}

function rowStatus(row: SubagentRow): "running" | "pending" | "completed" | "failed" {
    const status = asString(row.progress?.status);
    if (
        status === "running" ||
        status === "pending" ||
        status === "completed" ||
        status === "failed"
    ) {
        return status;
    }
    return row.exitCode === 0 ? "completed" : "failed";
}

function rowGlyph(row: SubagentRow, theme: BoxTheme): string {
    switch (rowStatus(row)) {
        case "running":
            return theme.fg("warning", RUNNING_TITLE_GLYPH);
        case "pending":
            return theme.fg("dim", "○");
        case "completed":
            return theme.fg("success", "✓");
        default:
            return theme.fg("error", "✗");
    }
}

/** `12 tools · 3.4k tok · 41.2s` — the metrics line subagents renders in its own result. */
function rowMetrics(row: SubagentRow, theme: BoxTheme): string {
    const parts: string[] = [];
    const tools = asNumber(row.progress?.toolCount);
    const tokens = asNumber(row.progress?.tokens);
    const durationMs = asNumber(row.progress?.durationMs);
    if (tools !== undefined && tools > 0) parts.push(`${tools} tools`);
    if (tokens !== undefined && tokens > 0) {
        const value = tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
        parts.push(`${value} tok`);
    }
    if (durationMs !== undefined && durationMs > 0) {
        parts.push(formatMetricParts(theme, (durationMs / 1000).toFixed(2), "s"));
    }
    return parts.join(theme.fg("dim", " · "));
}

function toolRowLines(row: SubagentRow, expanded: boolean, theme: BoxTheme): string[] {
    const recent = Array.isArray(row.progress?.recentTools) ? row.progress.recentTools : [];
    const current = asString(row.progress?.currentTool);
    const running = rowStatus(row) === "running";
    const limit = expanded ? Number.MAX_SAFE_INTEGER : COLLAPSED_TOOL_ROWS;
    const shown = running && current ? recent.slice(-(limit - 1)) : recent.slice(-limit);
    const hidden = recent.length - shown.length;

    const lines: string[] = [];
    if (hidden > 0) {
        lines.push(
            `${theme.fg("muted", "  ")}${theme.fg("dim", `… ${hidden} earlier tool calls`)}`,
        );
    }
    for (const entry of shown) {
        const name = asString(entry?.tool) ?? "?";
        const args = asString(entry?.args);
        lines.push(
            `${theme.fg("muted", "  ")}${theme.fg("accent", name)}${args ? ` ${theme.fg("dim", oneLine(args, 80))}` : ""}`,
        );
    }
    if (running && current) {
        const args = asString(row.progress?.currentToolArgs);
        lines.push(
            `${theme.fg("muted", "  ")}${theme.fg("warning", "▸ ")}${theme.fg("accent", current)}${args ? ` ${theme.fg("dim", oneLine(args, 80))}` : ""}`,
        );
    }
    return lines;
}

function agentBlockLines(
    row: SubagentRow,
    index: number,
    expanded: boolean,
    theme: BoxTheme,
): string[] {
    const agent = asString(row.agent) ?? `agent ${index + 1}`;
    const label = asString(row.title) ?? asString(row.task);
    const head = `${rowGlyph(row, theme)} ${theme.fg("toolTitle", agent)}${label ? theme.fg("dim", ` · ${oneLine(label, 60)}`) : ""}`;
    const metrics = rowMetrics(row, theme);
    const lines = [metrics ? `${head} ${theme.fg("dim", "·")} ${metrics}` : head];
    lines.push(...toolRowLines(row, expanded, theme));
    const lastMessage = asString(row.progress?.lastMessage);
    if (lastMessage) {
        lines.push(`${theme.fg("muted", "  ")}${theme.fg("dim", oneLine(lastMessage, 120))}`);
    }
    const error = asString(row.progress?.error);
    if (error) {
        lines.push(`${theme.fg("muted", "  ")}${theme.fg("error", oneLine(error, 120))}`);
    }
    return lines;
}

export function renderSubagentCall(
    _toolName: unknown,
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteExecutionStart(context);
    noteBoxedCallState(context);
    return renderBoxedToolCall(
        theme,
        formatToolName(SUBAGENT_TOOL_NAME),
        requestDetailLines(args, context.expanded, theme),
        {
            headerDetail: requestSummary(args),
            isError: context.isError,
            isPartial: context.isPartial,
            isPending: context.isPartial,
            running: context.executionStarted,
            resultSeen: isResultSeen(context.state),
        },
    );
}

function footerLines(
    details: SubagentDetails,
    isPartial: boolean,
    theme: BoxTheme,
    context: BoxedToolContext,
): string[] {
    if (isPartial) {
        return [formatBoxedRunningStatus(theme, stateElapsedMs(context))];
    }
    const rows = details.results ?? [];
    const ok = rows.filter((row) => rowStatus(row) === "completed").length;
    const elapsedMs = stateElapsedMs(context);
    const parts: string[] = [];
    parts.push(
        elapsedMs === undefined
            ? theme.fg("dim", "--")
            : formatMetricParts(theme, (elapsedMs / 1000).toFixed(2), "s"),
    );
    parts.push(theme.fg("dim", `${ok}/${rows.length} agents`));
    const tokens = rows.reduce((sum, row) => sum + (asNumber(row.progress?.tokens) ?? 0), 0);
    if (tokens > 0) parts.push(theme.fg("dim", `${tokens} tok`));
    return [parts.join(theme.fg("dim", " · "))];
}

/** First-partial-pass result: the running call card stands alone. */
const EMPTY_RESULT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});

export function renderSubagentResult(
    result: BoxedToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
    const details = readDetails(result);
    const output = getTextOutput(result);
    if (!details) {
        // No structured payload (e.g. the call was rejected before dispatch):
        // fall back to the plain output so the card never renders empty.
        const text = output.trim() || "No output received yet";
        return renderBoxedToolResult(theme, (width) => new Text(text, 0, 0).render(width), {
            dividerLabel: "Output",
            isError: context.isError,
            isPartial: options.isPartial,
        });
    }

    if (options.isPartial && firstResultPass) return EMPTY_RESULT;

    const budget = options.expanded ? getToolsRenderConfig().maxExpandedLines : COLLAPSED_RUN_LINES;

    const bodyLines = (contentWidth: number): string[] => {
        const rows = details.results ?? [];
        const lines: string[] = [];
        rows.forEach((row, index) => {
            if (index > 0) lines.push("");
            lines.push(...agentBlockLines(row, index, options.expanded, theme));
        });

        // Settled runs append the concatenated output underneath the rows.
        if (!options.isPartial && output.trim()) {
            lines.push("");
            lines.push(theme.fg("muted", "─".repeat(Math.max(8, contentWidth))));
            const maxOutput = options.expanded ? budget : COLLAPSED_OUTPUT_LINES;
            const { lines: outputLines, omitted } = selectRenderLines(output, maxOutput);
            for (const line of outputLines) {
                lines.push(
                    formatToolOutputLine(theme, line, context.isError ? "error" : "toolOutput"),
                );
            }
            if (omitted > 0 && !options.expanded) {
                lines.push(theme.fg("muted", `… ${omitted} more lines omitted by render budget`));
            }
        }

        if (lines.length > budget) {
            const omitted = lines.length - budget;
            return [
                ...lines.slice(0, budget),
                theme.fg("muted", `… ${omitted} more lines omitted by render budget`),
            ];
        }
        return lines;
    };

    const hasOutput = output.trim().length > 0;
    return renderBoxedToolResult(theme, bodyLines, {
        dividerLabel: options.isPartial ? "Agents" : "Run",
        footerLines: footerLines(details, options.isPartial, theme, context),
        showDivider: options.isPartial ? hasOutput : true,
        isError: context.isError,
        isPartial: options.isPartial,
    });
}
