/**
 * Display: the live status widget, per-agent progress rendering, and the
 * tool-call / tool-result renderers.
 */
import type { AgentResult, Details, AgentScope } from "./core.js";
import { formatDuration, shortenHome, truncLine } from "../../shared/text-format.js";
import { ANSI, DOT, SPINNER, TICK_MS, styled, styledDuration } from "../../shared/widget-kit.js";
import {
    getMarkdownTheme,
    type ExtensionContext,
    type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { SubagentParams } from "../index.js";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";

/** Renders a token count compactly, switching to thousands above 1000. */
function formatTokens(n: number): string {
    return n < 1000
        ? String(n)
        : n < 10000
          ? `${(n / 1000).toFixed(1)}k`
          : `${Math.round(n / 1000)}k`;
}

// ── Live status widget ──────────────────────────────────────────────────
/**
 * Live subagent status widget (above the editor, Claude Code style).
 *
 * The tool-result renderers only paint after completion; this widget covers
 * the running state. Hooked once in index.ts executeWithEvents, so all
 * modes (single/parallel/chain/hybrid) report through it with no changes
 * to execute.ts. Entries live exactly while their invocation runs and are
 * removed on its final return; snapshots are copied per update so later
 * mutations of live progress objects never leak into rendered rows.
 */

const MAX_ROWS = 6;

interface RowSnapshot {
    agent: string;
    status: string;
    firstSeen: number;
    exitCode: number;
    title: string;
    /** Elapsed ms frozen when a terminal status was first seen. Undefined while live. */
    finishedMs?: number;
}

function toTitle(task: string): string {
    if (!task) return "";
    const words = task.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length === 0) return "";
    const head = words.slice(0, 5).join(" ");
    return words.length > 5 ? `${head}…` : head;
}

const live = new Map<string, RowSnapshot[]>();
// Finished invocations ignore late progress: throttled trailing updates can
// fire after finish and would otherwise resurrect the row forever.
// A Set is insertion-ordered, so the oldest id is always first.
const finished = new Set<string>();
const MAX_FINISHED = 128;
let lastCtx: any;
let timer: ReturnType<typeof setInterval> | undefined;

function stopTimer(): void {
    if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
    }
}

function ensureTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
        if (live.size === 0) {
            stopTimer();
            return;
        }
        paint(lastCtx);
    }, TICK_MS);
}

function isLive(status: string): boolean {
    return status === "running" || status === "pending";
}

function snapshot(r: AgentResult, firstSeen: number, prev?: RowSnapshot): RowSnapshot {
    const status = r.progress?.status ?? "running";
    const row: RowSnapshot = {
        agent: r.agent,
        status,
        firstSeen,
        exitCode: r.exitCode ?? -1,
        title: toTitle(r.title || r.task || ""),
    };
    // Freeze the clock on terminal rows. Elapsed is wall-clock only while a run
    // is live; otherwise a finished row keeps counting for as long as any
    // sibling row keeps the shared repaint timer alive. Prefer the duration the
    // run itself reported, and capture it once so late throttled updates and
    // repaints can never move the number again.
    if (!isLive(status)) {
        const reported = r.progress?.durationMs ?? 0;
        row.finishedMs =
            prev?.finishedMs ?? (reported > 0 ? reported : Math.max(0, Date.now() - firstSeen));
    }
    return row;
}

function renderRow(row: RowSnapshot, now: number): string {
    const [icon, color] =
        row.status === "running"
            ? [SPINNER[Math.floor(now / TICK_MS) % SPINNER.length], ANSI.cyan]
            : row.status === "pending"
              ? ["○", ANSI.dim]
              : row.exitCode === 0
                ? ["✓", ANSI.green]
                : ["✗", ANSI.red];
    const duration = styledDuration(row.finishedMs ?? Math.max(0, now - row.firstSeen));
    const agent = styled(ANSI.yellow, row.agent);
    if (!row.title) return `${styled(color, icon)} ${agent} ${DOT} ${duration}`;
    return `${styled(color, icon)} ${agent} ${DOT} ${row.title} ${DOT} ${duration}`;
}

function paint(ctx: any): void {
    const setWidget = ctx?.ui?.setWidget;
    if (!ctx?.hasUI || typeof setWidget !== "function") return;
    const rows = [...live.values()].flat();
    if (rows.length === 0) {
        try {
            setWidget("subagents", undefined);
        } catch {
            /* non-interactive host — ignore */
        }
        return;
    }
    const now = Date.now();
    const running = rows.filter((r) => isLive(r.status)).length;
    const shown = rows.slice(0, MAX_ROWS);
    const hasMore = rows.length > MAX_ROWS;
    const lines = [
        `${styled(`${ANSI.bold};${ANSI.yellow}`, "subagents")} ${DOT} ${styled(`${ANSI.bold};${ANSI.yellow}`, String(running))} ${styled(`${ANSI.bold};${ANSI.green}`, "running")}`,
        ...shown.map((r, i) => {
            const branch = !hasMore && i === shown.length - 1 ? "└─" : "├─";
            return `${branch} ${renderRow(r, now)}`;
        }),
    ];
    if (hasMore) lines.push(`└─ +${rows.length - MAX_ROWS} more`);
    try {
        setWidget("subagents", lines);
    } catch {
        /* non-interactive host — ignore */
    }
}

/** Record fresh progress for one tool-call invocation and repaint. */
export function updateSubagentWidget(ctx: any, toolCallId: string, results: unknown): void {
    if (finished.has(toolCallId)) return;
    if (!Array.isArray(results) || results.length === 0) return;
    const now = Date.now();
    const prev = live.get(toolCallId) ?? [];
    live.set(
        toolCallId,
        (results as AgentResult[]).map((r, i) => {
            const before = prev[i];
            return snapshot(r, before?.firstSeen ?? now, before);
        }),
    );
    lastCtx = ctx;
    ensureTimer();
    paint(ctx);
}

/** Drop one invocation's rows; clears the widget when nothing runs. */
export function finishSubagentWidget(ctx: any, toolCallId: string): void {
    if (!finished.has(toolCallId)) {
        finished.add(toolCallId);
        if (finished.size > MAX_FINISHED) {
            const oldest = finished.values().next().value;
            if (oldest !== undefined) finished.delete(oldest);
        }
    }
    if (!live.has(toolCallId)) return;
    live.delete(toolCallId);
    if (live.size === 0) stopTimer();
    paint(ctx);
}

/**
 * Reset every module-level field — called on `session_start` (index.ts).
 * `live`, `finished` and the repaint timer outlive one conversation in a process
 * that keeps the extension loaded, so a new session must not inherit them.
 */
export function resetSubagentWidgetState(): void {
    live.clear();
    finished.clear();
    stopTimer();
    lastCtx = undefined;
}

// ── Agent progress ──────────────────────────────────────────────────────
type Theme = ExtensionContext["ui"]["theme"];
function getTermWidth(): number {
    return process.stdout.columns || 120;
}

function tryParseJson(s: string): Record<string, unknown> | null {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

/**
 * Format a tool call for display in the subagent UI.
 *
 * Accepts:
 * - A plain preview string (our ToolEvent.args format from extractToolArgsPreview)
 * - A JSON string (will be parsed for richer formatting)
 * - An object (full args, as used in the reference implementation)
 */
export function formatToolCall(
    toolName: string,
    args: Record<string, unknown> | string,
    themeFg: (color: ThemeColor, text: string) => string,
): string {
    // Resolve the preview text from whatever argument format we receive
    let previewText: string;
    if (typeof args === "string") {
        const parsed = tryParseJson(args);
        previewText = parsed ? extractPreviewText(toolName, parsed) : shortenHome(args);
    } else {
        previewText = extractPreviewText(toolName, args);
    }

    // Truncate long previews
    if (previewText.length > 80) {
        previewText = previewText.slice(0, 80) + "...";
    }

    switch (toolName) {
        case "bash":
            return themeFg("muted", "$ ") + themeFg("toolOutput", previewText);
        case "read":
            return themeFg("muted", "read ") + themeFg("accent", previewText);
        case "write":
            return themeFg("muted", "write ") + themeFg("accent", previewText);
        case "edit":
            return themeFg("muted", "edit ") + themeFg("accent", previewText);
        case "ls":
            return themeFg("muted", "ls ") + themeFg("accent", previewText);
        case "find":
        case "fffind":
            return themeFg("muted", "find ") + themeFg("accent", previewText);
        case "grep":
        case "ffgrep":
            return themeFg("muted", "grep ") + themeFg("accent", previewText);
        default:
            return themeFg("accent", toolName) + themeFg("dim", ` ${previewText}`);
    }
}

/**
 * Extract a human-readable preview text from a full args object.
 * Mirrors extractToolArgsPreview in process.ts for backward compat.
 */
function extractPreviewText(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
        case "bash":
            return String(args.command || args.cmd || "...");
        case "read": {
            const filePath = String(args.file_path || args.path || "...");
            const offset = args.offset != null ? Number(args.offset) : undefined;
            const limit = args.limit != null ? Number(args.limit) : undefined;
            let text = shortenHome(filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += `:${startLine}${endLine ? `-${endLine}` : ""}`;
            }
            return text;
        }
        case "write": {
            const filePath = String(args.file_path || args.path || "...");
            const content = String(args.content || "");
            const lines = content.split("\n").length;
            let text = shortenHome(filePath);
            if (lines > 1) text += ` (${lines} lines)`;
            return text;
        }
        case "edit":
            return shortenHome(String(args.file_path || args.path || "..."));
        case "ls":
            return shortenHome(String(args.path || args.dir || "."));
        case "find":
        case "fffind":
            return `${String(args.pattern || args.query || "*")} in ${shortenHome(String(args.path || args.dir || "."))}`;
        case "grep":
        case "ffgrep":
            return `/${String(args.pattern || args.query || "")}/ in ${shortenHome(String(args.path || args.dir || "."))}`;
        default: {
            const s = JSON.stringify(args);
            return s.length > 200 ? `${s.slice(0, 200)}…` : s;
        }
    }
}

function renderLine(text: string, expanded: boolean, w: number): Text {
    return new Text(expanded ? text : truncLine(text, w), 0, 0);
}

/** Glyphs for the four run states, kept together so every surface agrees. */
const SPIN_GLYPH = "\uE22C";
const PENDING_GLYPH = "\uDB86\uDD9F";
const OK_GLYPH = "\uF05D";
const FAIL_GLYPH = "\uF52F";

/** Row glyph for one agent: terminal state first, then exit code. */
function statusIcon(theme: Theme, r: AgentResult): string {
    if (r.exitCode === 0) return theme.fg("success", OK_GLYPH);
    if (r.progress?.status === "running") return theme.fg("warning", PENDING_GLYPH);
    return theme.fg("error", FAIL_GLYPH);
}

export function renderAgentProgress(
    r: AgentResult,
    theme: Theme,
    expanded: boolean,
    w: number,
): Container {
    const c = new Container();
    const prog = r.progress;
    if (!prog) return c;
    const isRunning = prog.status === "running";

    // Header: icon + agent + stats (always one line, truncated)
    const icon =
        prog.status === "pending"
            ? theme.fg("dim", PENDING_GLYPH)
            : prog.status === "running"
              ? theme.fg("warning", SPIN_GLYPH)
              : statusIcon(theme, r);
    const stats = `${prog.toolCount} tools · ${formatTokens(prog.tokens)} tok · ${formatDuration(prog.durationMs)}`;
    const modelStr = r.model ? theme.fg("dim", ` (${r.model})`) : "";
    c.addChild(
        new Text(
            truncLine(
                `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelStr} — ${theme.fg("dim", stats)}`,
                w,
            ),
            0,
            0,
        ),
    );

    // Task
    const taskStr = expanded ? r.task : r.task.replace(/\n/g, " ");
    c.addChild(renderLine(theme.fg("dim", `Task: ${taskStr}`), expanded, w));

    // Current tool (running state)
    if (isRunning && prog.currentTool) {
        const toolLine =
            prog.currentToolArgs || prog.currentToolArgsObj
                ? formatToolCall(
                      prog.currentTool,
                      prog.currentToolArgsObj ?? prog.currentToolArgs ?? "",
                      theme.fg.bind(theme),
                  )
                : prog.currentTool;
        c.addChild(renderLine(theme.fg("warning", `▸ ${toolLine}`), expanded, w));
    }

    // Recent tools (always all)
    const toolsToShow = prog.recentTools;
    for (const t of toolsToShow) {
        c.addChild(
            renderLine(
                theme.fg("muted", "  ") +
                    formatToolCall(t.tool, t.argsObj ?? t.args, theme.fg.bind(theme)),
                expanded,
                w,
            ),
        );
    }

    // Latest assistant message — the prose "thinking" text, always visible
    if (prog.lastMessage) {
        c.addChild(new Spacer(1));
        c.addChild(renderLine(theme.fg("text", prog.lastMessage), expanded, w));
    }

    // Expanded: full final output
    if (!isRunning && r.output && expanded) {
        c.addChild(new Spacer(1));
        // Results are structuredCloned by the host; keep rendered nodes off them.
        c.addChild(new Markdown(r.output, 0, 0, getMarkdownTheme()));
    }

    // Usage breakdown
    c.addChild(new Spacer(1));
    const usageParts: string[] = [];
    if (r.usage.turns) usageParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
    if (r.usage.input) usageParts.push(`in:${formatTokens(r.usage.input)}`);
    if (r.usage.output) usageParts.push(`out:${formatTokens(r.usage.output)}`);
    if (r.usage.cacheRead) usageParts.push(`cR:${formatTokens(r.usage.cacheRead)}`);
    if (r.usage.cacheWrite) usageParts.push(`cW:${formatTokens(r.usage.cacheWrite)}`);
    if (r.usage.cost) usageParts.push(`$${r.usage.cost.toFixed(4)}`);
    if (usageParts.length) {
        c.addChild(new Text(theme.fg("dim", usageParts.join(" · ")), 0, 0));
    }

    // Error
    if (prog.error) {
        c.addChild(renderLine(theme.fg("error", `Error: ${prog.error}`), expanded, w));
    }

    return c;
}

// ── Tool renderers ──────────────────────────────────────────────────────
type HybridPhaseParam = NonNullable<Static<typeof SubagentParams>["hybrid"]>[number];
type RenderOptions = { expanded: boolean };
type SummaryStats = {
    ok: number;
    failed: number;
    running: number;
    tokens: number;
    durationMs: number;
};

function tally(results: AgentResult[]): SummaryStats {
    let ok = 0;
    let running = 0;
    let tokens = 0;
    let durationMs = 0;
    for (const r of results) {
        if (r.exitCode === 0) ok++;
        if (r.progress?.status === "running") running++;
        tokens += r.progress?.tokens ?? 0;
        durationMs = Math.max(durationMs, r.progress?.durationMs ?? 0);
    }
    return { ok, failed: results.length - ok, running, tokens, durationMs };
}

/** Per-mode header line; only hybrid and parallel report tokens and duration. */
function modeHeader(
    mode: Exclude<Details["mode"], "single">,
    theme: Theme,
    total: number,
    stats: SummaryStats,
): string {
    const title = theme.fg("toolTitle", theme.bold(mode));
    if (mode === "chain") {
        const icon =
            stats.failed === 0 ? theme.fg("success", OK_GLYPH) : theme.fg("error", FAIL_GLYPH);
        return `${icon} ${title} ${stats.ok}/${total} steps`;
    }
    const icon =
        stats.running > 0
            ? theme.fg("warning", PENDING_GLYPH)
            : stats.failed === 0
              ? theme.fg("success", OK_GLYPH)
              : theme.fg("error", FAIL_GLYPH);
    const noun = mode === "hybrid" ? "agents" : "completed";
    const running = mode === "hybrid" && stats.running > 0 ? `${stats.running} running · ` : "";
    return `${icon} ${title} ${stats.ok}/${total} ${noun} · ${running}${formatTokens(stats.tokens)} tok · ${formatDuration(stats.durationMs)}`;
}
function phaseAgentSummary(phase: HybridPhaseParam): string {
    if (phase.mode === "single") return phase.agent;
    const names = phase.tasks.map((t) => t.agent).join(phase.mode === "chain" ? " → " : ", ");
    return `${phase.mode} (${phase.tasks.length}: ${names})`;
}

export function renderSubagentToolCall(args: Static<typeof SubagentParams>, theme: Theme): Text {
    const scope: AgentScope = args.agentScope ?? "user";
    const scopeText = scope !== "user" ? theme.fg("warning", ` [${scope}]`) : "";
    const header = theme.fg("toolTitle", theme.bold("subagent"));
    const call = (mode: string, detail?: string) =>
        new Text(
            detail
                ? `${header} ${theme.fg("accent", mode)} ${theme.fg("dim", detail)}${scopeText}`
                : `${header} ${theme.fg("accent", mode)}${scopeText}`,
            0,
            0,
        );

    if (args.hybrid && args.hybrid.length > 0) {
        const phases = args.hybrid.map(phaseAgentSummary).join(" → ");
        return call("hybrid", `(${args.hybrid.length} phases: ${phases})`);
    }
    if (args.chain && args.chain.length > 0) {
        const names = args.chain.map((s) => s.agent).join(" → ");
        return call("chain", `(${args.chain.length} steps: ${names})`);
    }
    if (args.tasks && args.tasks.length > 0) {
        const names = args.tasks.map((t) => t.agent).join(", ");
        return call("parallel", `(${args.tasks.length} tasks: ${names})`);
    }
    if (args.agent) {
        const task = args.task ?? "";
        const preview = (task.length > 60 ? `${task.slice(0, 60)}…` : task).replace(/\n/g, " ");
        return call(args.agent, preview);
    }
    return new Text(header, 0, 0);
}

export function renderSubagentToolResult(
    result: { content: { type: string; text?: string }[]; details?: unknown },
    options: RenderOptions,
    theme: Theme,
): Container | Text {
    const details = result.details as Details | undefined;
    if (!details?.results?.length) {
        const t = result.content[0];
        const text = t?.type === "text" && t.text ? t.text : "(no output)";
        return new Text(text.slice(0, 200), 0, 0);
    }

    const w = getTermWidth() - 4;
    const expanded = options.expanded;
    const { mode, results } = details;
    const c = new Container();
    const stats = tally(results);

    if (mode !== "single") {
        c.addChild(new Text(truncLine(modeHeader(mode, theme, results.length, stats), w), 0, 0));
        c.addChild(new Spacer(1));
    }

    results.forEach((r, i) => {
        if (mode === "chain") {
            const label = `Step ${r.step ?? i + 1}: ${r.agent}`;
            c.addChild(
                new Text(
                    truncLine(`${statusIcon(theme, r)} ${theme.fg("accent", label)}`, w),
                    0,
                    0,
                ),
            );
        }
        c.addChild(renderAgentProgress(r, theme, expanded, w));
        if (i < results.length - 1) c.addChild(new Spacer(1));
    });

    return c;
}
