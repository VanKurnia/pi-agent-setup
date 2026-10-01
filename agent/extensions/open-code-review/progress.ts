/**
 * Open Code Review — run state and stderr progress parsing.
 *
 * Parses the human-audience stderr stream into per-action rows and file
 * rows; the widget and the fork card both read OcrRunState via details.
 */

import { stripAnsi } from "../shared/strip-ansi.js";

export interface OcrAction {
    tool: string;
    args?: string;
    ok: boolean;
    ms?: number;
}

export interface OcrFileRow {
    path: string;
    state: "running" | "done";
    comments?: number;
}

export interface OcrFinding {
    path: string;
    start_line: number;
    end_line: number;
    severity: string;
    category: string;
    content: string;
    suggestion_code?: string;
}

export interface OcrResultPayload {
    findings: OcrFinding[];
    filesReviewed: number;
    comments: number;
    totalTokens: number;
    elapsed: string;
    model?: string;
    sessionId?: string;
}

export interface OcrRunState {
    mode: "review" | "scan";
    scope: string;
    phase: "running" | "done" | "failed";
    startedAt: number;
    finishedMs?: number;
    changedFiles?: number;
    reviewingFiles?: number;
    files: OcrFileRow[];
    actions: OcrAction[];
    result?: OcrResultPayload;
    error?: string;
}

export type OcrProgressEvent =
    | { kind: "counts"; changed: number; reviewing: number }
    | { kind: "group"; files: string[] }
    | { kind: "action-start"; tool: string; args?: string }
    | { kind: "action-done"; tool: string; ms: number };

const MAX_ACTIONS = 40;

/** Pure stderr-line parser — never throws, returns undefined for unknown lines. */
function parseProgressLine(line: string): OcrProgressEvent | undefined {
    let clean: string;
    try {
        clean = stripAnsi(line);
    } catch {
        return undefined;
    }
    let m: RegExpMatchArray | null;
    m = clean.match(/^\[ocr\]\s+▶ (\S+)(?: (.*))?$/);
    if (m) {
        const args = m[2]?.trim();
        return args
            ? { kind: "action-start", tool: m[1], args }
            : { kind: "action-start", tool: m[1] };
    }
    m = clean.match(/^\[ocr\]\s+✔ (\S+) \((\d+(?:\.\d+)?)(ms|s|m)\)$/);
    if (m) {
        const n = parseFloat(m[2]);
        const ms = m[3] === "ms" ? n : m[3] === "s" ? n * 1000 : n * 60000;
        return { kind: "action-done", tool: m[1], ms };
    }
    m = clean.match(/^\[ocr\] (\d+) file\(s\) changed, reviewing (\d+) in .*$/);
    if (m) {
        return { kind: "counts", changed: parseInt(m[1], 10), reviewing: parseInt(m[2], 10) };
    }
    m = clean.match(/^\[ocr\] Skipping plan phase for group "([^"]*)" \(.*\)$/);
    if (m) {
        const files = m[1]
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
        return { kind: "group", files };
    }
    return undefined;
}

function createRunState(mode: "review" | "scan", scope: string): OcrRunState {
    return { mode, scope, phase: "running", startedAt: Date.now(), files: [], actions: [] };
}

/** Fold one stderr line into the run state; mutates and returns the state. */
function applyProgressLine(state: OcrRunState, line: string): OcrRunState {
    let event: OcrProgressEvent | undefined;
    try {
        event = parseProgressLine(line);
    } catch {
        return state;
    }
    if (!event) return state;
    try {
        if (event.kind === "counts") {
            state.changedFiles = event.changed;
            state.reviewingFiles = event.reviewing;
        } else if (event.kind === "group") {
            for (const path of event.files) {
                if (!state.files.some((f) => f.path === path)) {
                    state.files.push({ path, state: "running" });
                }
            }
        } else if (event.kind === "action-start") {
            const action: OcrAction =
                event.args === undefined
                    ? { tool: event.tool, ok: false }
                    : { tool: event.tool, args: event.args, ok: false };
            state.actions.push(action);
            if (state.actions.length > MAX_ACTIONS) {
                state.actions = state.actions.slice(-MAX_ACTIONS);
            }
        } else if (event.kind === "action-done") {
            for (let i = state.actions.length - 1; i >= 0; i--) {
                if (!state.actions[i].ok) {
                    state.actions[i].ok = true;
                    state.actions[i].ms = event.ms;
                    break;
                }
            }
        }
    } catch {
        /* total parser — a malformed event never breaks the run */
    }
    return state;
}

interface ScopeParams {
    commit?: string;
    from?: string;
    to?: string;
    path?: string;
    preview?: boolean;
}

function describeScope(mode: "review" | "scan", params: ScopeParams): string {
    let scope: string;
    if (mode === "review") {
        if (params.commit) scope = `commit ${params.commit.slice(0, 7)}`;
        else if (params.from && params.to) scope = `${params.from}..${params.to}`;
        else scope = "workspace";
    } else {
        scope = params.path ?? "whole repo";
    }
    return params.preview ? `${scope} · preview` : scope;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyResult(state: OcrRunState, json: any): OcrRunState {
    const comments = Array.isArray(json?.comments) ? json.comments : [];
    const byPath = new Map<string, number>();
    const findings: OcrFinding[] = [];
    for (const c of comments) {
        if (typeof c?.path !== "string") continue;
        byPath.set(c.path, (byPath.get(c.path) ?? 0) + 1);
        findings.push({
            path: c.path,
            start_line: typeof c.start_line === "number" ? c.start_line : 0,
            end_line: typeof c.end_line === "number" ? c.end_line : 0,
            severity: typeof c.severity === "string" ? c.severity : "",
            category: typeof c.category === "string" ? c.category : "",
            content: typeof c.content === "string" ? c.content : "",
            suggestion_code: typeof c.suggestion_code === "string" ? c.suggestion_code : undefined,
        });
    }
    for (const row of state.files) {
        row.state = "done";
        if (byPath.has(row.path)) row.comments = byPath.get(row.path);
    }
    for (const [path, count] of byPath) {
        if (!state.files.some((f) => f.path === path)) {
            state.files.push({ path, state: "done", comments: count });
        }
    }
    const summary = json?.summary ?? {};
    const llm = json?.llm ?? {};
    state.phase = "done";
    state.result = {
        findings,
        filesReviewed: typeof summary.files_reviewed === "number" ? summary.files_reviewed : 0,
        comments: typeof summary.comments === "number" ? summary.comments : comments.length,
        totalTokens: typeof summary.total_tokens === "number" ? summary.total_tokens : 0,
        elapsed: typeof summary.elapsed === "string" ? summary.elapsed : "",
        model:
            typeof llm.provider === "string" && typeof llm.model === "string"
                ? `${llm.provider}/${llm.model}`
                : undefined,
        sessionId: typeof json?.session_id === "string" ? json.session_id : undefined,
    };
    return state;
}

export { parseProgressLine, createRunState, applyProgressLine, describeScope, applyResult };
