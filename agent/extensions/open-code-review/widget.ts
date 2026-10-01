/**
 * Live Open Code Review status widget above the editor.
 *
 * One row per running ocr_review/ocr_scan call; cleared when the run
 * settles, mirroring the subagents widget's timer and guard structure.
 */

import { ANSI, DOT, SPINNER, TICK_MS, styled, styledDuration } from "../shared/widget-kit.js";
import type { OcrRunState } from "./progress.js";

const MAX_ROWS = 6;
const MAX_FINISHED = 128;
const MAX_SCOPE = 60;

const live = new Map<string, OcrRunState>();
// Finished tool calls ignore late updates that would otherwise resurrect
// a cleared row. A Set is insertion-ordered, so the oldest id is first.
const finished = new Set<string>();
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

function renderRow(state: OcrRunState, now: number): string {
    const [icon, color] =
        state.phase === "running"
            ? [SPINNER[Math.floor(now / TICK_MS) % SPINNER.length], ANSI.cyan]
            : state.phase === "done"
              ? ["✓", ANSI.green]
              : ["✗", ANSI.red];
    const scope =
        state.scope.length > MAX_SCOPE ? state.scope.slice(0, MAX_SCOPE) + "…" : state.scope;
    const duration = styledDuration(state.finishedMs ?? Math.max(0, now - state.startedAt));
    return `${styled(color, icon)} ${styled(ANSI.yellow, state.mode)} ${DOT} ${scope} ${DOT} ${duration}`;
}

function paint(ctx: any): void {
    const setWidget = ctx?.ui?.setWidget;
    if (!ctx?.hasUI || typeof setWidget !== "function") return;
    const rows = [...live.values()];
    if (rows.length === 0) {
        try {
            setWidget("ocr", undefined);
        } catch {
            /* non-interactive host — ignore */
        }
        return;
    }
    const now = Date.now();
    const running = rows.filter((r) => r.phase === "running").length;
    const shown = rows.slice(0, MAX_ROWS);
    const hasMore = rows.length > MAX_ROWS;
    const lines = [
        `${styled(`${ANSI.bold};${ANSI.yellow}`, "Open Code Review")} ${DOT} ${styled(`${ANSI.bold};${ANSI.yellow}`, String(running))} ${styled(`${ANSI.bold};${ANSI.green}`, "running")}`,
        ...shown.map((r, i) => {
            const branch = !hasMore && i === shown.length - 1 ? "└─" : "├─";
            return `${branch} ${renderRow(r, now)}`;
        }),
    ];
    if (hasMore) lines.push(`└─ +${rows.length - MAX_ROWS} more`);
    try {
        setWidget("ocr", lines);
    } catch {
        /* non-interactive host — ignore */
    }
}

/** Record the current run state for one tool call and repaint. */
export function updateOcrWidget(ctx: any, toolCallId: string, state: OcrRunState): void {
    if (finished.has(toolCallId)) return;
    live.set(toolCallId, state);
    lastCtx = ctx;
    ensureTimer();
    paint(ctx);
}

/** Drop one tool call's row; clears the widget when nothing runs. */
export function finishOcrWidget(ctx: any, toolCallId: string): void {
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
 * Reset every module-level field — called on `session_start`.
 * `live`, `finished` and the repaint timer outlive one conversation in a
 * process that keeps the extension loaded, so a new session must not
 * inherit them.
 *
 * Painting the emptied map is what actually removes the rows:
 * `setWidget("ocr", undefined)` only runs from `paint()`, so without this
 * call a previous session's rows stay on screen until some later repaint.
 */
export function resetOcrWidgetState(ctx?: any): void {
    live.clear();
    finished.clear();
    stopTimer();
    paint(ctx ?? lastCtx);
    lastCtx = undefined;
}
