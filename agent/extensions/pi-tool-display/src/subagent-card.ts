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
    formatCompactCount,
    formatElapsedMetric,
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

interface SubagentRow {
    agent?: unknown;
    title?: unknown;
    task?: unknown;
    exitCode?: unknown;
    progress?: SubagentProgress;
}

interface SubagentDetails {
    results?: SubagentRow[];
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

/** `details` arrives untyped through the renderer bridge, so every entry is narrowed before use. */
function readDetails(result: BoxedToolResult | undefined): SubagentRow[] | undefined {
    const details = result?.details;
    if (!details || typeof details !== "object") return undefined;
    const results = (details as SubagentDetails).results;
    if (!Array.isArray(results)) return undefined;
    // Rows are dereferenced throughout this card, so non-objects are dropped here.
    const rows = results.filter(
        (row): row is SubagentRow => typeof row === "object" && row !== null,
    );
    return rows.length > 0 ? rows : undefined;
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

/** One entry of the call card: a requested run, or a phase header in hybrid mode. */
type CallItem =
    | { kind: "request"; agent: string; label?: string; task?: string }
    | { kind: "group"; label: string };

function toRequest(raw: unknown): CallItem {
    const item = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
        kind: "request",
        agent: asString(item.agent) ?? "?",
        label: asString(item.title),
        task: asString(item.task),
    };
}

function agentNames(items: CallItem[]): string[] {
    return items.flatMap((item) => (item.kind === "request" ? [item.agent] : []));
}

/** Flatten the call arguments into the runs being requested, plus a header summary. */
function readCall(args: Record<string, unknown>): { summary: string; items: CallItem[] } {
    const hybrid = Array.isArray(args.hybrid) ? args.hybrid : undefined;
    if (hybrid?.length) {
        const items: CallItem[] = [];
        for (const phase of hybrid) {
            if (phase?.mode === "single") {
                items.push(toRequest(phase));
            } else if (Array.isArray(phase?.tasks)) {
                items.push({ kind: "group", label: `${phase.mode} · ${phase.tasks.length}` });
                for (const task of phase.tasks) items.push(toRequest(task));
            }
        }
        return { summary: `hybrid · ${hybrid.length} phases`, items };
    }
    const chain = Array.isArray(args.chain) ? args.chain : undefined;
    if (chain?.length) {
        const items = chain.map(toRequest);
        return { summary: `chain · ${agentNames(items).join(" → ")}`, items };
    }
    const tasks = Array.isArray(args.tasks) ? args.tasks : undefined;
    if (tasks?.length) {
        const items = tasks.map(toRequest);
        return { summary: `parallel · ${agentNames(items).join(", ")}`, items };
    }
    return { summary: `single · ${asString(args.agent) ?? "?"}`, items: [toRequest(args)] };
}

/** Body lines for the call card: one block per requested agent/task. */
function requestDetailLines(items: CallItem[], expanded: boolean, theme: BoxTheme): string[] {
    const maxLines = expanded ? Number.MAX_SAFE_INTEGER : COLLAPSED_TASK_LINES;
    const lines: string[] = [];
    for (const item of items) {
        if (item.kind === "group") {
            lines.push(theme.fg("dim", item.label));
            continue;
        }
        lines.push(
            `${theme.fg("accent", item.agent)}${item.label ? theme.fg("dim", ` · ${item.label}`) : ""}`,
        );
        for (const line of item.task ? taskPreviewLines(item.task, maxLines) : []) {
            lines.push(`${theme.fg("muted", "  ")}${theme.fg("dim", line)}`);
        }
    }
    return lines;
}

/**
 * Shared with the subagents widget (`subagents/src/widget.ts`): only `running`
 * and `pending` come from the reported status, and a terminal row is judged by
 * its exit code, so both surfaces classify the same payload identically.
 */
function rowStatus(row: SubagentRow): "running" | "pending" | "completed" | "failed" {
    const status = asString(row.progress?.status) ?? "running";
    if (status === "running" || status === "pending") return status;
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

/** Compact tool count, tokens and elapsed for one agent row. */
function rowMetrics(row: SubagentRow, theme: BoxTheme): string {
    const parts: string[] = [];
    const tools = asNumber(row.progress?.toolCount);
    const tokens = asNumber(row.progress?.tokens);
    const durationMs = asNumber(row.progress?.durationMs);
    if (tools) parts.push(`${tools} tools`);
    if (tokens) parts.push(`${formatCompactCount(tokens)} tok`);
    if (durationMs) parts.push(formatElapsedMetric(theme, durationMs));
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

function agentBlockLines(row: SubagentRow, expanded: boolean, theme: BoxTheme): string[] {
    const agent = asString(row.agent) ?? "?";
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
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteExecutionStart(context);
    noteBoxedCallState(context);
    const { summary, items } = readCall(args);
    return renderBoxedToolCall(
        theme,
        formatToolName(SUBAGENT_TOOL_NAME),
        requestDetailLines(items, context.expanded, theme),
        {
            headerDetail: summary,
            isError: context.isError,
            isPartial: context.isPartial,
            isPending: context.isPartial,
            running: context.executionStarted,
            resultSeen: isResultSeen(context.state),
        },
    );
}

function footerLines(
    rows: SubagentRow[],
    isPartial: boolean,
    theme: BoxTheme,
    context: BoxedToolContext,
): string[] {
    if (isPartial) {
        return [formatBoxedRunningStatus(theme, stateElapsedMs(context))];
    }
    const elapsedMs = stateElapsedMs(context);
    const ok = rows.filter((row) => rowStatus(row) === "completed").length;
    const tokens = rows.reduce((sum, row) => sum + (asNumber(row.progress?.tokens) ?? 0), 0);
    const parts = [
        elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs),
        theme.fg("dim", `${ok}/${rows.length} agents`),
    ];
    if (tokens) parts.push(theme.fg("dim", `${formatCompactCount(tokens)} tok`));
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
    const rows = readDetails(result);
    const output = getTextOutput(result);
    if (!rows) {
        // No structured payload: fall back to the plain output so the card never
        // renders empty.
        const text = output.trim() || "No output received yet";
        return renderBoxedToolResult(theme, (width) => new Text(text, 0, 0).render(width), {
            dividerLabel: "Output",
            isError: context.isError,
            isPartial: options.isPartial,
        });
    }

    if (options.isPartial && firstResultPass) return EMPTY_RESULT;

    const budget = options.expanded ? getToolsRenderConfig().maxExpandedLines : COLLAPSED_RUN_LINES;
    const hasOutput = output.trim().length > 0;

    const bodyLines = (contentWidth: number): string[] => {
        const lines: string[] = [];
        for (const [index, row] of rows.entries()) {
            if (index > 0) lines.push("");
            lines.push(...agentBlockLines(row, options.expanded, theme));
        }

        // Settled runs append the concatenated output underneath the rows.
        if (!options.isPartial && hasOutput) {
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

    return renderBoxedToolResult(theme, bodyLines, {
        dividerLabel: options.isPartial ? "Agents" : "Run",
        footerLines: footerLines(rows, options.isPartial, theme, context),
        showDivider: options.isPartial ? hasOutput : true,
        isError: context.isError,
        isPartial: options.isPartial,
    });
}
