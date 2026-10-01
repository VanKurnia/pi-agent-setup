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
import { ANSI, DOT, SPINNER, TICK_MS, styled, styledDuration } from "../../shared/widget-kit.js";

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
 * Reset every module-level field — called on `session_start` (register.ts).
 * `live`, `finished` and the repaint timer outlive one conversation in a process
 * that keeps the extension loaded, so a new session must not inherit them.
 */
export function resetSubagentWidgetState(): void {
    live.clear();
    finished.clear();
    stopTimer();
    lastCtx = undefined;
}
