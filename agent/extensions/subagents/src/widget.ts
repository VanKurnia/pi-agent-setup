/**
 * Live subagent status widget (above the editor, Claude Code style).
 *
 * The tool-result renderers only paint after completion; this widget covers
 * the running state. Hooked once in register.ts executeWithEvents, so all
 * modes (single/parallel/chain/hybrid) report through it with no changes
 * to execute.ts. Entries live exactly while their invocation runs and are
 * removed on its final return; snapshots are copied per update so later
 * mutations of live progress objects never leak into rendered rows.
 */
import type { AgentResult } from "./types.js";
import { formatDuration } from "./utils.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_ROWS = 6;
// Repaint cadence while runs are live — decoupled from progress events so the
// spinner and timers keep moving through long silent model streams.
const TICK_MS = 150;

/** Minimal ANSI palette — widget strings render verbatim, no theme access here. */
const ANSI = { reset: "\x1b[0m", bold: "1", dim: "2", cyan: "36", green: "32", red: "31" };
const styled = (code: string, text: string): string => `\x1b[${code}m${text}${ANSI.reset}`;

interface RowSnapshot {
    agent: string;
    status: string;
    firstSeen: number;
    exitCode: number;
}

const live = new Map<string, RowSnapshot[]>();
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

function snapshot(r: AgentResult, firstSeen: number): RowSnapshot {
    return {
        agent: r.agent,
        status: r.progress?.status ?? "running",
        firstSeen,
        exitCode: r.exitCode ?? -1,
    };
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
    return `${styled(color, icon)} ${row.agent} · ${styled(ANSI.dim, formatDuration(Math.max(0, now - row.firstSeen)))}`;
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
    const running = rows.filter((r) => r.status === "running" || r.status === "pending").length;
    const shown = rows.slice(0, MAX_ROWS);
    const hasMore = rows.length > MAX_ROWS;
    const lines = [
        styled(ANSI.bold, `subagents · ${running} running`),
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
    if (!Array.isArray(results) || results.length === 0) return;
    const now = Date.now();
    const prev = live.get(toolCallId) ?? [];
    live.set(
        toolCallId,
        (results as AgentResult[]).map((r, i) => snapshot(r, prev[i]?.firstSeen ?? now)),
    );
    lastCtx = ctx;
    ensureTimer();
    paint(ctx);
}

/** Drop one invocation's rows; clears the widget when nothing runs. */
export function finishSubagentWidget(ctx: any, toolCallId: string): void {
    if (!live.has(toolCallId)) return;
    live.delete(toolCallId);
    if (live.size === 0) stopTimer();
    paint(ctx);
}
