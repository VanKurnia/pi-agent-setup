/**
 * Open Code Review — execution engine: process spawning, CLI arg helpers,
 * stderr progress streaming, and output formatting.
 *
 * Loaded on-demand when OCR tools run.
 */

import fs from "node:fs";
import { spawn, execSync } from "node:child_process";
import { stripAnsi } from "../shared/strip-ansi.js";

// =============================================================================
// Run State & Progress Types
// =============================================================================

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

// =============================================================================
// Progress Parsing & State Mutation
// =============================================================================

function parseProgressLine(line: string): OcrProgressEvent | undefined {
    let clean: string;
    try {
        clean = stripAnsi(line);
    } catch {
        clean = line;
    }

    const mStart = clean.match(/^\[ocr\]\s+▶ (\S+)(?: (.*))?$/);
    if (mStart && mStart[1]) {
        const args = mStart[2]?.trim();
        return args
            ? { kind: "action-start", tool: mStart[1], args }
            : { kind: "action-start", tool: mStart[1] };
    }

    const mDone = clean.match(/^\[ocr\]\s+✔ (\S+) \(([\d.]+)(ms|s|m)\)$/);
    if (mDone && mDone[1] && mDone[2] && mDone[3]) {
        const n = Number(mDone[2]);
        const ms = mDone[3] === "ms" ? n : mDone[3] === "s" ? n * 1000 : n * 60000;
        return { kind: "action-done", tool: mDone[1], ms };
    }

    const mCounts = clean.match(
        /^\[ocr\] (?:full-scan: )?(\d+) file\(s\) (?:changed|discovered), reviewing (\d+) in .*$/,
    );
    if (mCounts && mCounts[1] && mCounts[2]) {
        return { kind: "counts", changed: Number(mCounts[1]), reviewing: Number(mCounts[2]) };
    }

    const mGroup = clean.match(/^\[ocr\] Skipping plan phase for group "([^"]*)" \(.*\)$/);
    if (mGroup && mGroup[1] !== undefined) {
        const files = mGroup[1]
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean);
        if (files.length > 0) return { kind: "group", files };
    }

    return undefined;
}

export function createRunState(mode: "review" | "scan", scope: string): OcrRunState {
    return {
        mode,
        scope,
        phase: "running",
        startedAt: Date.now(),
        files: [],
        actions: [],
    };
}

export function applyProgressLine(state: OcrRunState, line: string): void {
    const ev = parseProgressLine(line);
    if (!ev) return;

    switch (ev.kind) {
        case "counts":
            state.changedFiles = ev.changed;
            state.reviewingFiles = ev.reviewing;
            break;
        case "group":
            for (const f of ev.files) {
                if (!state.files.some((x) => x.path === f)) {
                    state.files.push({ path: f, state: "running" });
                }
            }
            break;
        case "action-start": {
            const existing = state.actions.find((a) => a.tool === ev.tool && a.ms === undefined);
            if (!existing) {
                state.actions.push({ tool: ev.tool, args: ev.args, ok: true });
                if (state.actions.length > MAX_ACTIONS) {
                    state.actions.splice(0, state.actions.length - MAX_ACTIONS);
                }
            }
            break;
        }
        case "action-done": {
            const item = state.actions
                .slice()
                .reverse()
                .find((a) => a.tool === ev.tool);
            if (item) item.ms = ev.ms;
            break;
        }
    }
}

export function applyPreviewResult(state: OcrRunState, stdout: string): void {
    state.phase = "done";
    state.finishedMs = Date.now() - state.startedAt;
    const willReviewMatch = stdout.match(
        /Will review \(\d+\):\s*([\s\S]*?)(?=\n\s*\n|Excluded|$)/i,
    );
    if (willReviewMatch && willReviewMatch[1]) {
        for (const line of willReviewMatch[1].split(/\r?\n/)) {
            const m = line.match(/^\s*\[[A-Z]\]\s+(\S+)/);
            if (m && m[1]) {
                state.files.push({ path: m[1], state: "done" });
            }
        }
    }
}

export function applyResult(state: OcrRunState, payload: unknown): void {
    state.phase = "done";
    state.finishedMs = Date.now() - state.startedAt;
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;

    const findings: OcrFinding[] = Array.isArray(p.findings)
        ? (p.findings as OcrFinding[]).filter((f) => f && typeof f.path === "string")
        : [];

    state.result = {
        findings,
        filesReviewed: typeof p.filesReviewed === "number" ? p.filesReviewed : state.files.length,
        comments: typeof p.comments === "number" ? p.comments : findings.length,
        totalTokens: typeof p.totalTokens === "number" ? p.totalTokens : 0,
        elapsed: typeof p.elapsed === "string" ? p.elapsed : "",
        model: typeof p.model === "string" ? p.model : undefined,
        sessionId: typeof p.sessionId === "string" ? p.sessionId : undefined,
    };

    const countsByFile = new Map<string, number>();
    for (const f of findings) {
        countsByFile.set(f.path, (countsByFile.get(f.path) ?? 0) + 1);
    }
    for (const file of state.files) {
        file.state = "done";
        file.comments = countsByFile.get(file.path) ?? 0;
    }
}

export function describeScope(
    mode: "review" | "scan",
    params: { commit?: string; from?: string; to?: string; path?: string },
): string {
    if (mode === "review") {
        if (params.commit) return `commit ${String(params.commit).slice(0, 10)}`;
        if (params.from && params.to) return `${String(params.from)}..${String(params.to)}`;
        if (params.from) return `from ${String(params.from)}`;
        return "working copy";
    }
    if (params.path) return String(params.path);
    return "workspace";
}

// =============================================================================
// CLI Execution
// =============================================================================

let memoizedOcrCmd: string | null | undefined = undefined;
let memoizedOcrCmdAt = 0;
const OCR_CMD_TTL_MS = 60_000;

export function invalidateOcrCmdCache(): void {
    memoizedOcrCmd = undefined;
    ocrReady = undefined;
}

function resolveOcrCmd(): string | null {
    if (memoizedOcrCmd !== undefined) {
        if (memoizedOcrCmd !== null) return memoizedOcrCmd;
        if (Date.now() - memoizedOcrCmdAt < OCR_CMD_TTL_MS) return null;
    }
    try {
        const isWin = process.platform === "win32";
        const findCmd = isWin ? "where ocr" : "which ocr";
        const findOutput = execSync(findCmd, { encoding: "utf8", timeout: 10_000 });
        const lines = findOutput
            .trim()
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);

        const binPath =
            lines.find((l) => l.endsWith(".exe") || l.endsWith(".cmd") || l.endsWith(".bat")) ||
            lines[0];
        if (binPath && fs.existsSync(binPath)) {
            memoizedOcrCmd = binPath;
            memoizedOcrCmdAt = Date.now();
            return binPath;
        }

        memoizedOcrCmd = null;
        memoizedOcrCmdAt = Date.now();
        return null;
    } catch {
        memoizedOcrCmd = null;
        memoizedOcrCmdAt = Date.now();
        return null;
    }
}

function isOcrAvailable(): boolean {
    return resolveOcrCmd() !== null;
}

export interface RunOcrOptions {
    cwd?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onStderrLine?: (line: string) => void;
}

export interface OcrRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export async function runOcr(args: string[], options: RunOcrOptions = {}): Promise<OcrRunResult> {
    // Honour an already-aborted signal: the listener below would never fire.
    if (options.signal?.aborted) {
        return { code: 1, stdout: "", stderr: "Operation cancelled" };
    }

    const ocrCmd = resolveOcrCmd();
    if (!ocrCmd) {
        return {
            code: 1,
            stdout: "",
            stderr: "Open Code Review CLI ('ocr') is not installed or not in PATH.",
        };
    }

    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(ocrCmd, args, {
                cwd: options.cwd || process.cwd(),
                stdio: ["ignore", "pipe", "pipe"],
                shell: false,
            });
        } catch (spawnError) {
            const err = spawnError as NodeJS.ErrnoException;
            if (err.code === "ENOENT") invalidateOcrCmdCache();
            return resolve({
                code: 1,
                stdout: "",
                stderr: `Failed to spawn ${ocrCmd}: ${err.message}`,
            });
        }

        let stdout = "";
        let stderr = "";
        let stderrRemainder = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        let resolved = false;

        const complete = (res: OcrRunResult) => {
            if (resolved) return;
            resolved = true;
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve(res);
        };

        if (options.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => {
                child.kill();
                stderr += "\n[pi-ocr] Process timed out";
            }, options.timeoutMs);
        }

        const onAbort = () => {
            child.kill();
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stderr += text;

            if (options.onStderrLine) {
                const combined = stderrRemainder + text;
                const lines = combined.split(/\r?\n/);
                stderrRemainder = lines.pop() ?? "";
                for (const line of lines) {
                    if (line.trim()) options.onStderrLine(line);
                }
            }
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") invalidateOcrCmdCache();
            if (options.onStderrLine && stderrRemainder.trim()) {
                options.onStderrLine(stderrRemainder.trim());
            }
            complete({ code: 1, stdout, stderr: `${stderr}\n${err.message}`.trim() });
        });

        child.on("close", (code) => {
            if (options.onStderrLine && stderrRemainder.trim()) {
                options.onStderrLine(stderrRemainder.trim());
            }
            complete({ code: code ?? 1, stdout, stderr });
        });
    });
}

let ocrReady: boolean | undefined = undefined;

export async function ensureOcr(signal?: AbortSignal): Promise<string | undefined> {
    if (ocrReady === true) return undefined;
    if (!isOcrAvailable()) {
        return (
            "Open Code Review CLI ('ocr') is not installed or not in PATH.\n\n" +
            "Install OCR following the official guide:\n" +
            "  Scoop:    scoop bucket add ocr https://github.com/alibaba/open-code-review\n" +
            "            scoop install open-code-review\n" +
            "  npm:      npm install -g @open-code-review/cli\n" +
            "  Homebrew: brew install open-code-review\n\n" +
            "Then run `ocr login` or configure `~/.ocr/config.yaml` with your API key.\n" +
            "Use the `ocr_health` tool to verify the setup."
        );
    }
    const health = await runOcr(["version"], { timeoutMs: 10_000, signal });
    if (health.code !== 0) {
        return (
            `Open Code Review CLI is installed but not functioning properly.\n` +
            `Error: ${health.stderr || "Unknown error"}\n` +
            `Run \`ocr version\` in your terminal or use \`ocr_health\` to diagnose.`
        );
    }
    ocrReady = true;
    return undefined;
}

export function argPusher(target: string[]) {
    return (flag: string, value: unknown) => {
        if (value === undefined || value === null) return;
        if (typeof value === "boolean") {
            if (value) target.push(flag);
        } else {
            target.push(flag, String(value));
        }
    };
}

export interface ReviewToolParams {
    commit?: string;
    from?: string;
    to?: string;
    resume?: string;
    background?: string;
    background_file?: string;
    repo?: string;
    exclude?: string;
    model?: string;
    concurrency?: number;
    timeoutMinutes?: number;
    maxTools?: number;
    maxGitProcesses?: number;
    effort?: string;
    provider?: string;
    rule?: string;
    tools?: string;
    maxTokens?: number;
    maxTokensBudget?: number;
    noFilter?: boolean;
    output?: string;
    preview?: boolean;
}

export function buildReviewArgs(params: ReviewToolParams): string[] {
    const args = ["review", "--audience", "human"];
    if (!params.preview) {
        args.push("--format", "json");
    }
    const push = argPusher(args);
    push("--commit", params.commit);
    push("--from", params.from);
    push("--to", params.to);
    push("--resume", params.resume);
    push("--background", params.background);
    push("--background-file", params.background_file);
    push("--repo", params.repo);
    push("--exclude", params.exclude);
    push("--model", params.model);
    push("--concurrency", params.concurrency);
    push("--timeout", params.timeoutMinutes);
    push("--max-tools", params.maxTools);
    push("--max-git-procs", params.maxGitProcesses);
    push("--effort", params.effort);
    push("--provider", params.provider);
    push("--rule", params.rule);
    push("--tools", params.tools);
    push("--max-tokens", params.maxTokens);
    push("--max-tokens-budget", params.maxTokensBudget);
    push("--output", params.output);
    if (params.preview) args.push("--preview");
    if (params.noFilter) args.push("--no-filter");
    return args;
}

export interface ScanToolParams {
    path?: string;
    exclude?: string;
    model?: string;
    background?: string;
    repo?: string;
    no_plan?: boolean;
    no_dedup?: boolean;
    no_summary?: boolean;
    batch?: string;
    concurrency?: number;
    timeoutMinutes?: number;
    maxTools?: number;
    resume?: string;
    maxGitProcesses?: number;
    provider?: string;
    rule?: string;
    tools?: string;
    maxTokens?: number;
    maxTokensBudget?: number;
    output?: string;
    preview?: boolean;
}

export function buildScanArgs(params: ScanToolParams): string[] {
    const args = ["scan", "--audience", "human"];
    if (!params.preview) {
        args.push("--format", "json");
    }
    const push = argPusher(args);
    push("--path", params.path);
    push("--exclude", params.exclude);
    push("--model", params.model);
    push("--background", params.background);
    push("--repo", params.repo);
    push("--concurrency", params.concurrency);
    push("--timeout", params.timeoutMinutes);
    push("--max-tools", params.maxTools);
    push("--resume", params.resume);
    push("--max-git-procs", params.maxGitProcesses);
    push("--provider", params.provider);
    push("--rule", params.rule);
    push("--tools", params.tools);
    push("--max-tokens", params.maxTokens);
    push("--max-tokens-budget", params.maxTokensBudget);
    push("--output", params.output);
    if (params.no_plan) args.push("--no-plan");
    if (params.no_dedup) args.push("--no-dedup");
    if (params.no_summary) args.push("--no-summary");
    if (params.batch) args.push("--batch", params.batch);
    if (params.preview) args.push("--preview");
    return args;
}

export function formatOcrOutput(
    rawStdout: string,
    preview: boolean,
    onProgress?: (msg: string) => void,
): string {
    if (preview) {
        onProgress?.(rawStdout);
        return rawStdout;
    }
    try {
        const parsed = JSON.parse(rawStdout);
        return JSON.stringify(parsed, null, 2);
    } catch {
        return rawStdout;
    }
}
