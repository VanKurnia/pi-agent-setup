/**
 * Boxed card for the OCR tools (`ocr_review`, `ocr_scan`) (fork addition — not vendored pi-style).
 *
 * The OCR extension publishes its live run state through `details` on every
 * partial update and on the settled return. This card reads that state: live
 * action and file rows while running, severity-grouped findings with a metrics
 * footer once it settles. Without it the run falls to the generic fallback,
 * which prints the raw JSON wall and drops `details` entirely.
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import {
    type BoxTheme,
    formatBoxedRunningStatus,
    formatCompactCount,
    formatElapsedMetric,
    formatToolOutputLine,
    getTextOutput,
    renderBoxedToolCall,
    renderBoxedToolResult,
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
import { registerCleanup } from "./disposable.js";

/** Action rows shown while collapsed; expanding reveals the rest. */
const COLLAPSED_ACTIONS = 12;
/** Findings shown while collapsed; expanding reveals the rest. */
const COLLAPSED_FINDINGS = 3;
/** Collapsed line budget for the whole card, mirroring the subagent card. */
const COLLAPSED_RUN_LINES = 24;
/** Call-card detail lines shown while collapsed. */
const COLLAPSED_CALL_LINES = 5;

/**
 * Braille frames for in-flight file rows, same set `bash-display.ts` uses.
 * The shared boxed ticker repaints once a second (that is what keeps elapsed
 * labels live), which is far too coarse for a spinner to read as motion, so a
 * running card drives its own faster repaint through `context.invalidate()`.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 150;

let spinnerFrameIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;

function startSpinnerTicker(context: BoxedToolContext): void {
    if (spinnerTimer !== undefined) return;
    spinnerTimer = setInterval(() => {
        spinnerFrameIndex = (spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
        context.invalidate();
    }, SPINNER_INTERVAL_MS);
}

function stopSpinnerTicker(): void {
    if (spinnerTimer === undefined) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
}

// One module-level ticker, so one cleanup: `registerTimer` per start would
// pile up a callback every time a run begins.
registerCleanup(stopSpinnerTicker);

interface OcrActionRow {
    tool: string;
    args?: string;
    ok: boolean;
    ms?: number;
}

interface OcrFileRow {
    path: string;
    comments?: number;
}

interface OcrFindingRow {
    path: string;
    start: number;
    end: number;
    severity: string;
    category: string;
    content: string;
    suggestion?: string;
}

interface OcrResultState {
    findings: OcrFindingRow[];
    filesReviewed: number;
    comments: number;
    totalTokens: number;
    elapsed?: string;
    model?: string;
}

interface OcrCardState {
    mode: string;
    scope?: string;
    files?: OcrFileRow[];
    actions: OcrActionRow[];
    result?: OcrResultState;
    error?: string;
}

/** True for the OCR tools this card owns (`ocr_health` keeps the fallback card). */
export function isOcrTool(toolName: unknown): toolName is string {
    return toolName === "ocr_review" || toolName === "ocr_scan";
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Single-line preview: newlines collapsed, cut to `max` characters. */
function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Cosmetic `mode · scope` for the call header, kept local on purpose: the
 * vendored fork stays self-contained and never imports from the OCR extension.
 */
function callScope(toolName: string, args: Record<string, unknown>): string {
    const mode = toolName === "ocr_scan" ? "scan" : "review";
    let scope: string;
    if (mode === "scan") {
        scope = asString(args.path) ?? "whole repo";
    } else if (asString(args.commit)) {
        scope = `commit ${(args.commit as string).slice(0, 7)}`;
    } else {
        const from = asString(args.from);
        const to = asString(args.to);
        scope = from && to ? `${from}..${to}` : "workspace";
    }
    if (args.preview === true) scope += " · preview";
    return `${mode} · ${scope}`;
}

/** Call-card body: model, scope source and background context, max 5 lines collapsed. */
function callDetailLines(
    args: Record<string, unknown>,
    expanded: boolean,
    theme: BoxTheme,
): string[] {
    const lines: string[] = [];
    const model = asString(args.model);
    if (model) lines.push(`${theme.fg("dim", "model: ")}${model}`);
    const commit = asString(args.commit);
    const path = asString(args.path);
    const from = asString(args.from);
    const to = asString(args.to);
    const scopeSource = commit ?? path ?? (from && to ? `${from}..${to}` : undefined);
    if (scopeSource) lines.push(`${theme.fg("dim", "scope: ")}${oneLine(scopeSource, 80)}`);
    const background = asString(args.background);
    if (background) {
        if (expanded) {
            lines.push(theme.fg("dim", "context:"));
            for (const line of background.replace(/\r/g, "").split("\n")) {
                if (line.trim()) lines.push(`  ${line.trim()}`);
            }
        } else {
            lines.push(`${theme.fg("dim", "context: ")}${oneLine(background, 80)}`);
        }
    }
    return expanded ? lines : lines.slice(0, COLLAPSED_CALL_LINES);
}

export function renderOcrCall(
    toolName: string,
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteExecutionStart(context);
    noteBoxedCallState(context);
    if (!context.isPartial) stopSpinnerTicker();
    // The title is a literal: the name formatter would render "Ocr Review".
    const title = toolName === "ocr_scan" ? "OCR Scan" : "OCR Review";
    let headerDetail = callScope(toolName, args);
    const effort = asString(args.effort);
    if (effort) headerDetail += ` · effort ${effort}`;
    if (headerDetail.length > 63) headerDetail = `${headerDetail.slice(0, 60)}…`;
    return renderBoxedToolCall(theme, title, callDetailLines(args, context.expanded, theme), {
        headerDetail,
        isError: context.isError,
        isPartial: context.isPartial,
        isPending: context.isPartial,
        running: context.executionStarted,
        resultSeen: isResultSeen(context.state),
    });
}

/** `details` arrives untyped through the renderer bridge, so every entry is narrowed before use. */
function readDetails(result: BoxedToolResult | undefined): OcrCardState | undefined {
    const details = result?.details;
    if (!details || typeof details !== "object") return undefined;
    const raw = details as Record<string, unknown>;

    const filesRaw = Array.isArray(raw.files) ? raw.files : undefined;
    const files = filesRaw
        ?.map((entry) => {
            if (!entry || typeof entry !== "object") return undefined;
            const record = entry as Record<string, unknown>;
            const path = asString(record.path);
            if (!path) return undefined;
            const row: OcrFileRow = { path };
            const comments = asNumber(record.comments);
            if (comments !== undefined) row.comments = comments;
            return row;
        })
        .filter((row): row is OcrFileRow => row !== undefined);
    // An empty file list carries no rows, so it counts as absent.
    const fileRows = files && files.length > 0 ? files : undefined;

    const actionsRaw = Array.isArray(raw.actions) ? raw.actions : [];
    const actions: OcrActionRow[] = [];
    for (const entry of actionsRaw) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const tool = asString(record.tool);
        if (!tool) continue;
        const action: OcrActionRow = { tool, ok: record.ok === true };
        const args = asString(record.args);
        if (args !== undefined) action.args = args;
        const ms = asNumber(record.ms);
        if (ms !== undefined) action.ms = ms;
        actions.push(action);
    }

    let stateResult: OcrResultState | undefined;
    const resultRaw = raw.result;
    if (resultRaw && typeof resultRaw === "object") {
        const record = resultRaw as Record<string, unknown>;
        const findings: OcrFindingRow[] = [];
        const commentsRaw = Array.isArray(record.findings) ? record.findings : [];
        for (const entry of commentsRaw) {
            if (!entry || typeof entry !== "object") continue;
            const finding = entry as Record<string, unknown>;
            const path = asString(finding.path);
            if (!path) continue;
            findings.push({
                path,
                start: asNumber(finding.start_line) ?? 0,
                end: asNumber(finding.end_line) ?? 0,
                severity: asString(finding.severity) ?? "",
                category: asString(finding.category) ?? "",
                content: asString(finding.content) ?? "",
                suggestion: asString(finding.suggestion_code),
            });
        }
        stateResult = {
            findings,
            filesReviewed: asNumber(record.filesReviewed) ?? 0,
            comments: asNumber(record.comments) ?? findings.length,
            totalTokens: asNumber(record.totalTokens) ?? 0,
            elapsed: asString(record.elapsed),
            model: asString(record.model),
        };
    }

    return {
        mode: asString(raw.mode) ?? "review",
        scope: asString(raw.scope),
        files: fileRows,
        actions,
        result: stateResult,
        error: asString(raw.error),
    };
}

/** First-partial-pass result: the running call card stands alone. */
const EMPTY_RESULT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});

function actionRowLines(actions: OcrActionRow[], expanded: boolean, theme: BoxTheme): string[] {
    const maxActions = expanded ? getToolsRenderConfig().maxExpandedLines : COLLAPSED_ACTIONS;
    const shown = actions.length > maxActions ? actions.slice(-maxActions) : actions;
    const omitted = actions.length - shown.length;
    const lines: string[] = [];
    if (omitted > 0) {
        lines.push(theme.fg("muted", `… ${omitted} earlier actions omitted by render budget`));
    }
    for (const action of shown) {
        const glyph = action.ok ? theme.fg("success", "✓") : theme.fg("warning", "▸");
        const args = action.args ? ` ${theme.fg("dim", oneLine(action.args, 80))}` : "";
        const ms =
            action.ms !== undefined
                ? `${theme.fg("dim", " · ")}${formatElapsedMetric(theme, action.ms)}`
                : "";
        lines.push(`${glyph} ${theme.fg("accent", action.tool)}${args}${ms}`);
    }
    return lines;
}

function fileRowLines(
    files: OcrFileRow[],
    glyph: string,
    glyphRole: "warning" | "success",
    theme: BoxTheme,
    withCounts: boolean,
): string[] {
    return files.map((file) => {
        const count =
            withCounts && file.comments !== undefined
                ? theme.fg(
                      "dim",
                      `  ${file.comments} ${file.comments === 1 ? "comment" : "comments"}`,
                  )
                : "";
        return `${theme.fg(glyphRole, glyph)} ${file.path}${count}`;
    });
}

function applyBudget(lines: string[], expanded: boolean, theme: BoxTheme): string[] {
    const budget = expanded ? getToolsRenderConfig().maxExpandedLines : COLLAPSED_RUN_LINES;
    if (lines.length <= budget) return lines;
    const omitted = lines.length - budget;
    return [
        ...lines.slice(0, budget),
        theme.fg("muted", `… ${omitted} more lines omitted by render budget`),
    ];
}

function severityRole(severity: string): "error" | "warning" | "dim" {
    switch (severity.toLowerCase()) {
        case "high":
        case "critical":
        case "error":
            return "error";
        case "medium":
        case "moderate":
        case "warning":
            return "warning";
        default:
            return "dim";
    }
}

function findingBlockLines(
    finding: OcrFindingRow,
    showSuggestion: boolean,
    expanded: boolean,
    theme: BoxTheme,
): string[] {
    const role = severityRole(finding.severity);
    const location =
        finding.start > 0 ? `${finding.path}:${finding.start}-${finding.end}` : finding.path;
    const lines = [
        `${theme.fg(role, "●")} ${theme.fg(role, finding.severity.toUpperCase() || "?")}  ${theme.fg("accent", finding.category || "review")}  ${theme.fg("dim", location)}`,
    ];
    if (finding.content) {
        for (const line of finding.content.replace(/\r/g, "").split("\n")) {
            if (line.trim()) lines.push(`  ${line.trim()}`);
        }
    }
    // Only the first finding carries its suggestion inline; the rest stay compact.
    if (showSuggestion && finding.suggestion) {
        const { lines: suggestionLines, omitted } = selectRenderLines(
            finding.suggestion,
            expanded ? getToolsRenderConfig().maxExpandedLines : 10,
        );
        lines.push(theme.fg("muted", "┌ suggestion"));
        for (const line of suggestionLines) {
            lines.push(formatToolOutputLine(theme, `│ ${line}`));
        }
        if (omitted > 0) {
            lines.push(theme.fg("muted", `… ${omitted} more lines omitted by render budget`));
        }
        lines.push(theme.fg("muted", "└"));
    }
    return lines;
}

function summaryLine(result: OcrResultState, theme: BoxTheme): string {
    const files = `${result.filesReviewed} ${result.filesReviewed === 1 ? "file" : "files"} reviewed`;
    const comments = `${result.comments} ${result.comments === 1 ? "comment" : "comments"}`;
    return `${theme.fg("text", files)}${theme.fg("dim", " · ")}${theme.fg("text", comments)}`;
}

function settledFooterLines(
    state: OcrCardState,
    result: OcrResultState,
    theme: BoxTheme,
    context: BoxedToolContext,
): string[] {
    const elapsedMs = stateElapsedMs(context);
    const elapsed =
        result.elapsed ??
        (elapsedMs === undefined ? undefined : formatElapsedMetric(theme, elapsedMs));
    const total = Math.max(state.files?.length ?? 0, result.filesReviewed);
    const parts = [
        theme.fg("dim", elapsed ?? "--"),
        theme.fg("dim", `${result.filesReviewed}/${total} files`),
    ];
    if (result.totalTokens > 0) {
        parts.push(theme.fg("dim", `${formatCompactCount(result.totalTokens)} tok`));
    }
    if (result.model) parts.push(theme.fg("dim", result.model));
    return [parts.join(theme.fg("dim", " · "))];
}

function renderPartial(
    state: OcrCardState,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const body = (contentWidth: number): string[] => {
        void contentWidth;
        const lines =
            state.actions.length > 0
                ? actionRowLines(state.actions, options.expanded, theme)
                : [theme.fg("dim", "No output received yet")];
        if (state.files !== undefined && state.files.length > 0) {
            lines.push("", theme.fg("dim", "Files"));
            lines.push(
                ...fileRowLines(
                    state.files,
                    SPINNER_FRAMES[spinnerFrameIndex],
                    "warning",
                    theme,
                    false,
                ),
            );
        }
        return applyBudget(lines, options.expanded, theme);
    };
    startSpinnerTicker(context);
    const fileCount = state.files?.length ?? 0;
    const footer = `${formatBoxedRunningStatus(theme, stateElapsedMs(context))}${
        fileCount > 0
            ? `${theme.fg("dim", " · ")}${theme.fg("dim", `${fileCount} ${fileCount === 1 ? "file" : "files"}`)}`
            : ""
    }`;
    return renderBoxedToolResult(theme, body, {
        dividerLabel: "Actions",
        footerLines: [footer],
        isError: context.isError,
        isPartial: options.isPartial,
    });
}

function renderSettled(
    state: OcrCardState,
    result: OcrResultState,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const maxFindings = options.expanded
        ? getToolsRenderConfig().maxExpandedLines
        : COLLAPSED_FINDINGS;
    const body = (): string[] => {
        const lines = [summaryLine(result, theme), ""];
        const shown = result.findings.slice(0, maxFindings);
        if (shown.length === 0) {
            lines.push(`${theme.fg("success", "✓")} ${theme.fg("dim", "no findings")}`);
        } else {
            for (const [index, finding] of shown.entries()) {
                if (index > 0) lines.push("");
                lines.push(...findingBlockLines(finding, index === 0, options.expanded, theme));
            }
            if (result.findings.length > shown.length) {
                lines.push(
                    theme.fg(
                        "muted",
                        `… ${result.findings.length - shown.length} more lines omitted by render budget`,
                    ),
                );
            }
        }
        if (state.files !== undefined && state.files.length > 0) {
            lines.push("", theme.fg("dim", "Files"));
            lines.push(...fileRowLines(state.files, "✓", "success", theme, true));
        }
        return applyBudget(lines, options.expanded, theme);
    };
    return renderBoxedToolResult(theme, body, {
        dividerLabel: "Findings",
        footerLines: settledFooterLines(state, result, theme, context),
        isError: context.isError,
        isPartial: options.isPartial,
    });
}

function renderPreview(
    state: OcrCardState,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const body = (): string[] => {
        const lines =
            state.files && state.files.length > 0
                ? fileRowLines(state.files, "✓", "success", theme, false)
                : [theme.fg("dim", "No output received yet")];
        return applyBudget(lines, options.expanded, theme);
    };
    const elapsedMs = stateElapsedMs(context);
    const footer = [
        `${elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs)}${theme.fg("dim", " · ")}${theme.fg("dim", `${state.files?.length ?? 0} files`)}`,
    ];
    return renderBoxedToolResult(theme, body, {
        dividerLabel: "Files",
        footerLines: footer,
        isError: context.isError,
        isPartial: options.isPartial,
    });
}

function renderFailed(
    state: OcrCardState,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const body = (): string[] => {
        const { lines: errorLines, omitted } = selectRenderLines(
            state.error ?? "Unknown error",
            options.expanded ? getToolsRenderConfig().maxExpandedLines : 10,
        );
        const lines = errorLines.map((line) => formatToolOutputLine(theme, line, "error"));
        if (omitted > 0) {
            lines.push(theme.fg("muted", `… ${omitted} more lines omitted by render budget`));
        }
        if (state.files !== undefined && state.files.length > 0) {
            lines.push("", theme.fg("dim", "Files"));
            lines.push(...fileRowLines(state.files, "✓", "success", theme, true));
        }
        return applyBudget(lines, options.expanded, theme);
    };
    return renderBoxedToolResult(theme, body, {
        dividerLabel: "Error",
        isError: context.isError,
        isPartial: options.isPartial,
    });
}

export function renderOcrResult(
    result: BoxedToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
    // Terminal pass: the run is over, so the spinner must not outlive it.
    if (!options.isPartial) stopSpinnerTicker();
    const state = readDetails(result);
    const output = getTextOutput(result);
    if (!state) {
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
    if (options.isPartial) return renderPartial(state, options, theme, context);
    if (state.result) return renderSettled(state, state.result, options, theme, context);
    if (state.error) return renderFailed(state, options, theme, context);
    // Preview runs publish the seeded file list without a result payload.
    return renderPreview(state, options, theme, context);
}
