/**
 * Open Code Review — Pi native tools wrapping the `ocr` CLI
 *
 * Registers:
 *   ocr_review   — Review workspace changes, a single commit, or a ref range
 *   ocr_scan     — Full-file scan (no diff needed)
 *   ocr_health   — Check OCR installation and LLM connectivity
 *
 * Follows the official Open Code Review agent integration guidelines:
 *   https://github.com/alibaba/open-code-review/tree/main/skills
 *
 * Key behaviors:
 *   - Always uses `--audience agent`
 *   - Uses `--format json` for machine-readable output
 *   - Reports a setup message when the `ocr` CLI is missing (manual install required)
 *   - Reports findings by priority (High/Medium)
 *   - Only applies fixes when the user explicitly requests it
 *   - Never invents or hardcodes API keys
 *
 * Inspired by the community pi-open-code-review package (mshen6666).
 *
 * Security: Spawns node + ocr.js directly (shell:false). No shell
 * metacharacter risk — arguments are passed via process argv.
 */

import fs from "node:fs";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, fail } from "./git-toolkit/helpers.js";
import { stripAnsi } from "./shared/strip-ansi.js";

// ---------------------------------------------------------------------------
// OCR binary resolution — find the ocr binary on PATH (shell:false)
// ---------------------------------------------------------------------------

/**
 * Resolve the OCR binary path via system PATH (`where ocr` or `which ocr`).
 * Works with both standalone compiled binaries (Scoop/GitHub releases)
 * and Node.js npm global scripts.
 *
 * Memoized per process: PATH is probed once, then the result is reused.
 * Positive hits are kept for the process lifetime; negative (null) results
 * re-probe after OCR_CMD_TTL_MS so a mid-session install is picked up.
 * The memo is also invalidated on spawn ENOENT (covers uninstall/move).
 */
let memoizedOcrCmd: string | null | undefined = undefined;
let memoizedOcrCmdAt = 0;
const OCR_CMD_TTL_MS = 60_000;

function invalidateOcrCmdCache(): void {
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

// ---------------------------------------------------------------------------
// Lazy OCR availability check
// ---------------------------------------------------------------------------

let ocrReady: boolean | undefined;

async function ensureOcr(signal?: AbortSignal): Promise<string | null> {
    if (!isOcrAvailable()) {
        ocrReady = false;
        return installFailed();
    }

    if (ocrReady === true) return null;

    // Verify LLM connectivity
    try {
        await runOcr(["llm", "test"], { timeoutMs: 60_000, signal });
    } catch (e) {
        ocrReady = false;
        return [
            "OCR is installed but its LLM provider is not configured or unreachable.",
            "",
            "Configure it manually:",
            "```bash",
            "ocr config provider",
            "ocr config model",
            "ocr llm test",
            "```",
            "",
            "OCR uses its own LLM configuration — it does not reuse Pi's current model or API keys.",
            (e as Error).message ? `\nError: ${(e as Error).message}` : "",
        ].join("\n");
    }

    ocrReady = true;
    return null;
}

function installFailed(detail?: string): string {
    return [
        "Open Code Review CLI (`ocr`) is not installed.",
        "",
        "Install it from the official GitHub repo:",
        "https://github.com/alibaba/open-code-review",
        "",
        "Then configure its LLM provider:",
        "```bash",
        "ocr config provider",
        "ocr config model",
        "ocr llm test",
        "```",
        detail ? `\nError: ${detail}` : "",
    ].join("\n");
}

// ---------------------------------------------------------------------------
// OCR execution — spawns node + ocr.js (shell:false, safe from injection)
// ---------------------------------------------------------------------------

function runOcr(
    args: string[],
    opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
        if (opts.signal?.aborted) {
            return reject(new DOMException("Operation aborted", "AbortError"));
        }

        const bin = resolveOcrCmd();
        if (!bin) {
            return reject(
                new Error(
                    "Open Code Review CLI (`ocr`) is not installed.\nSee: https://github.com/alibaba/open-code-review",
                ),
            );
        }

        // Spawn `ocr` binary directly
        const child = spawn(bin, args, {
            cwd: opts.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

        const abortHandler = () => {
            if (done || child.killed) return;
            child.kill("SIGTERM");
            // Settle through cleanup so done/timers/listeners are consistent;
            // arm SIGKILL escalation after, since cleanup clears the old timer.
            cleanup(() => reject(new DOMException("Operation aborted", "AbortError")));
            forceKillTimer = setTimeout(() => {
                if (!child.killed) child.kill("SIGKILL");
            }, 3000);
        };

        opts.signal?.addEventListener("abort", abortHandler, { once: true });

        const cleanup = (cb: () => void) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(forceKillTimer);
            opts.signal?.removeEventListener("abort", abortHandler);
            cb();
        };

        child.stdout.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk);
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
            if (done) return;
            if (err.code === "ENOENT") invalidateOcrCmdCache();
            const msg =
                err.code === "ENOENT"
                    ? `OCR executable not found at ${bin}`
                    : `Failed to start OCR: ${err.message}`;
            cleanup(() => reject(new Error(msg)));
        });

        child.on("close", (exitCode) => {
            if (done) return;
            cleanup(() => {
                const result = {
                    stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
                    stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
                    code: exitCode ?? 1,
                };
                if (exitCode !== 0) {
                    reject(
                        new Error(
                            result.stderr || result.stdout || `OCR exited with code ${result.code}`,
                        ),
                    );
                } else {
                    resolve(result);
                }
            });
        });

        timer = setTimeout(abortHandler, opts.timeoutMs ?? 15 * 60 * 1000);
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const optionalString = (description: string) => Type.Optional(Type.String({ description }));
const optionalPosInt = (description: string) =>
    Type.Optional(Type.Integer({ description, minimum: 1 }));
const optionalBool = (description: string) => Type.Optional(Type.Boolean({ description }));

/**
 * Build an onUpdate wrapper that transforms a string msg into the
 * proper object format: { content: [{ type: "text", text: msg }], details: {} }
 * Calling onUpdate with a plain string crashes pi.
 */
function wrapUpdate(onUpdate: AgentToolUpdateCallback<unknown> | undefined): (msg: string) => void {
    return (msg: string) => {
        try {
            onUpdate?.({ content: [{ type: "text", text: msg }], details: {} });
        } catch {
            /* safety */
        }
    };
}

// ---------------------------------------------------------------------------
// OCR background jobs
// ---------------------------------------------------------------------------

function resolveJobsDir(): string {
    // Primary: agent/tmp/ocr-jobs next to the extension (agent/extensions/.. = agent/).
    try {
        return fileURLToPath(new URL("../tmp/ocr-jobs", import.meta.url));
    } catch {
        // Fallback: OS temp dir keeps jobs working if import.meta resolution fails.
        return path.join(os.tmpdir(), "pi-ocr-jobs");
    }
}

const JOBS_DIR = resolveJobsDir();
const MAX_RUNNING_JOBS = 3;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

interface OcrJobSidecar {
    id: string;
    kind: "review" | "scan";
    args: string[];
    repo: string;
    pid: number | null;
    status: "running" | "done" | "failed" | "cancelled";
    exitCode: number | null;
    startedAt: number;
    endedAt: number | null;
    note: string;
}

function mintJobId(): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const id = `ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
        try {
            if (!fs.existsSync(path.join(JOBS_DIR, `${id}.json`))) {
                return id;
            }
        } catch {
            return id;
        }
    }
    throw new Error("Failed to mint unique job ID after 3 attempts.");
}

function readSidecar(id: string): OcrJobSidecar | null {
    try {
        const raw = fs.readFileSync(path.join(JOBS_DIR, `${id}.json`), "utf8");
        return JSON.parse(raw) as OcrJobSidecar;
    } catch {
        return null;
    }
}

function writeSidecar(s: OcrJobSidecar): void {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(path.join(JOBS_DIR, `${s.id}.json`), JSON.stringify(s, null, 2), "utf8");
}

function listSidecars(): OcrJobSidecar[] {
    let files: string[];
    try {
        files = fs.readdirSync(JOBS_DIR);
    } catch {
        return [];
    }
    const out: OcrJobSidecar[] = [];
    for (const f of files) {
        if (!f.startsWith("ocr-") || !f.endsWith(".json")) {
            continue;
        }
        const s = readSidecar(f.slice(0, -5));
        if (s) {
            out.push(s);
        }
    }
    return out;
}

function isAlive(pid: number | null): boolean {
    if (pid === null) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function finalizeIfDead(s: OcrJobSidecar): OcrJobSidecar {
    if (s.status !== "running") {
        return s;
    }
    if (isAlive(s.pid)) {
        return s;
    }
    const final: OcrJobSidecar = {
        ...s,
        status: "failed",
        endedAt: Date.now(),
        exitCode: null,
        note: "process gone (reload/crash); exit code unknown",
    };
    try {
        writeSidecar(final);
    } catch {
        /* ignore */
    }
    return final;
}

function reapStaleJobs(): void {
    const now = Date.now();
    for (const s of listSidecars()) {
        if (isAlive(s.pid)) {
            continue;
        }
        const ageBase = s.endedAt ?? s.startedAt;
        if (now - ageBase <= JOB_TTL_MS) {
            continue;
        }
        for (const f of [`${s.id}.json`, `${s.id}.out.log`, `${s.id}.err.log`]) {
            try {
                fs.unlinkSync(path.join(JOBS_DIR, f));
            } catch {
                /* ignore */
            }
        }
    }
}

function tailFile(p: string, maxLines: number): string {
    try {
        const stat = fs.statSync(p);
        let text: string;
        if (stat.size <= 64 * 1024) {
            text = fs.readFileSync(p, "utf8");
        } else {
            const fd = fs.openSync(p, "r");
            try {
                const windowSize = 8192;
                const start = Math.max(0, stat.size - windowSize);
                const len = Math.min(windowSize, stat.size - start);
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, start);
                let chunk = buf.toString("utf8");
                if (start > 0) {
                    const firstNl = chunk.indexOf("\n");
                    if (firstNl !== -1) {
                        chunk = chunk.slice(firstNl + 1);
                    }
                }
                text = chunk;
            } finally {
                fs.closeSync(fd);
            }
        }
        const lines = text.split(/\r?\n/);
        return lines.slice(-maxLines).join("\n").slice(-4096);
    } catch {
        return "";
    }
}

function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }
    if (ms < 60 * 1000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    if (ms < 60 * 60 * 1000) {
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${m}m${s}s`;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h${m}m`;
}

async function startBackgroundJob(
    kind: "review" | "scan",
    args: string[],
    opts: { repo?: string; ctx: any; emit: (msg: string) => void },
): Promise<any> {
    // NOTE: user --output still applies inside the job; job .out.log may be empty — poll reports sizes so this is visible.
    reapStaleJobs();
    for (const s of listSidecars()) {
        if (s.status === "running") {
            finalizeIfDead(s);
        }
    }
    const running = listSidecars().filter((s) => s.status === "running" && isAlive(s.pid));
    if (running.length >= MAX_RUNNING_JOBS) {
        const ids = running.map((s) => s.id).join(", ");
        return fail(
            `Too many running OCR jobs (${running.length}/${MAX_RUNNING_JOBS}): ${ids}. ` +
                "Wait for one, or stop it with ocr_job_cancel.",
        );
    }
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    let id: string;
    try {
        id = mintJobId();
    } catch (e) {
        return fail((e as Error).message ?? String(e));
    }
    const repo = opts.repo ?? opts.ctx?.cwd ?? process.cwd();
    const startedAt = Date.now();
    let sidecar: OcrJobSidecar = {
        id,
        kind,
        args,
        repo,
        pid: null,
        status: "running",
        exitCode: null,
        startedAt,
        endedAt: null,
        note: "",
    };
    const bin = resolveOcrCmd();
    if (!bin) {
        try {
            writeSidecar({ ...sidecar, status: "failed", endedAt: Date.now() });
        } catch {
            /* ignore */
        }
        return fail(installFailed());
    }
    try {
        writeSidecar(sidecar);
    } catch (e) {
        return fail((e as Error).message ?? String(e));
    }
    let outFd: number;
    let errFd: number;
    try {
        outFd = fs.openSync(path.join(JOBS_DIR, `${id}.out.log`), "w");
        errFd = fs.openSync(path.join(JOBS_DIR, `${id}.err.log`), "w");
    } catch (e) {
        try {
            writeSidecar({ ...sidecar, status: "failed", endedAt: Date.now() });
        } catch {
            /* ignore */
        }
        return fail((e as Error).message ?? String(e));
    }
    try {
        const child = spawn(bin, args, {
            cwd: opts.ctx?.cwd,
            detached: true,
            stdio: ["ignore", outFd, errFd],
        });
        sidecar = { ...sidecar, pid: child.pid ?? null };
        try {
            writeSidecar(sidecar);
        } catch {
            /* ignore */
        }
        child.unref();
        try {
            fs.closeSync(outFd);
        } catch {
            /* ignore */
        }
        try {
            fs.closeSync(errFd);
        } catch {
            /* ignore */
        }
        child.on("close", (code) => {
            try {
                const cur = readSidecar(id);
                if (cur && cur.status === "running") {
                    writeSidecar({
                        ...cur,
                        status: code === 0 ? "done" : "failed",
                        endedAt: Date.now(),
                        exitCode: code ?? 1,
                    });
                }
            } catch {
                /* ignore */
            }
            try {
                finishOcrWidget(opts.ctx, id);
            } catch {
                /* ignore */
            }
        });
        child.on("error", () => {
            try {
                const cur = readSidecar(id);
                if (cur && cur.status === "running") {
                    writeSidecar({ ...cur, status: "failed", endedAt: Date.now() });
                }
            } catch {
                /* ignore */
            }
            try {
                finishOcrWidget(opts.ctx, id);
            } catch {
                /* ignore */
            }
        });
        let commit: string | undefined;
        let from: string | undefined;
        let to: string | undefined;
        let scanPath: string | undefined;
        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === "--commit" && args[i + 1] !== undefined) {
                commit = args[i + 1];
            }
            if (args[i] === "--from" && args[i + 1] !== undefined) {
                from = args[i + 1];
            }
            if (args[i] === "--to" && args[i + 1] !== undefined) {
                to = args[i + 1];
            }
            if (args[i] === "--path" && args[i + 1] !== undefined) {
                scanPath = args[i + 1];
            }
        }
        try {
            updateOcrWidget(opts.ctx, id, {
                kind,
                title: jobTitle(kind, { commit, from, to, path: scanPath }),
                startedAt,
            });
        } catch {
            /* ignore */
        }
        opts.emit(`[ocr] Started background ${kind} job ${id} — poll with ocr_job_status.`);
        return ok(
            `OCR ${kind} job started in background.\njobId: ${id}\nPoll: ocr_job_status { "id": "${id}" }`,
        );
    } catch (e) {
        try {
            writeSidecar({ ...sidecar, status: "failed", endedAt: Date.now() });
        } catch {
            /* ignore */
        }
        try {
            finishOcrWidget(opts.ctx, id);
        } catch {
            /* ignore */
        }
        try {
            fs.closeSync(outFd);
        } catch {
            /* ignore */
        }
        try {
            fs.closeSync(errFd);
        } catch {
            /* ignore */
        }
        return fail((e as Error).message ?? String(e));
    }
}

// ---------------------------------------------------------------------------
// OCR live widget
// ---------------------------------------------------------------------------

const OCR_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const OCR_MAX_ROWS = 6;
const OCR_TICK_MS = 500;

const OCR_ANSI = {
    reset: "\x1b[0m",
    bold: "1",
    dim: "2",
    cyan: "36",
    green: "32",
    red: "31",
    yellow: "33",
    blue: "34",
};
const ocrStyled = (code: string, text: string): string => `\x1b[${code}m${text}${OCR_ANSI.reset}`;
const OCR_DOT = ocrStyled(OCR_ANSI.dim, "·");

interface OcrWidgetRow {
    kind: "review" | "scan";
    title: string;
    startedAt: number;
}

const liveOcrJobs = new Map<string, OcrWidgetRow>();
let lastOcrCtx: any;
let ocrWidgetTimer: ReturnType<typeof setInterval> | undefined;

function jobTitle(
    kind: "review" | "scan",
    params: { commit?: string; from?: string; to?: string; path?: string },
): string {
    let base: string;
    if (kind === "review") {
        const scope =
            params.commit ??
            (params.from && params.to ? `${params.from}..${params.to}` : "workspace");
        base = `review ${scope}`;
    } else {
        base = `scan ${params.path ?? "whole repo"}`;
    }
    const words = base.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length <= 5) {
        return base;
    }
    return `${words.slice(0, 5).join(" ")}…`;
}

function styledOcrDuration(ms: number): string {
    return formatDuration(ms).replace(
        /(\d+(?:\.\d+)?)(ms|s|m|h)/g,
        (_, num, unit) => `${ocrStyled(OCR_ANSI.yellow, num)}${ocrStyled(OCR_ANSI.blue, unit)}`,
    );
}

function renderOcrRow(row: OcrWidgetRow, now: number): string {
    const icon = OCR_SPINNER[Math.floor(now / OCR_TICK_MS) % OCR_SPINNER.length];
    const duration = styledOcrDuration(Math.max(0, now - row.startedAt));
    const label = ocrStyled(OCR_ANSI.yellow, row.title || row.kind);
    return `${ocrStyled(OCR_ANSI.cyan, icon)} ${label} ${OCR_DOT} ${duration}`;
}

function stopOcrTimer(): void {
    if (ocrWidgetTimer !== undefined) {
        clearInterval(ocrWidgetTimer);
        ocrWidgetTimer = undefined;
    }
}

function ensureOcrTimer(): void {
    if (ocrWidgetTimer !== undefined) {
        return;
    }
    ocrWidgetTimer = setInterval(() => {
        if (liveOcrJobs.size === 0) {
            stopOcrTimer();
            return;
        }
        paintOcrWidget(lastOcrCtx);
    }, OCR_TICK_MS);
}

function paintOcrWidget(ctx: any): void {
    try {
        const setWidget = ctx?.ui?.setWidget;
        if (!ctx?.hasUI || typeof setWidget !== "function") {
            return;
        }
        const rows = [...liveOcrJobs.values()];
        if (rows.length === 0) {
            try {
                setWidget("ocr", undefined);
            } catch {
                /* non-interactive host — ignore */
            }
            return;
        }
        const now = Date.now();
        const running = rows.length;
        const shown = rows.slice(0, OCR_MAX_ROWS);
        const hasMore = rows.length > OCR_MAX_ROWS;
        const lines = [
            `${ocrStyled(`${OCR_ANSI.bold};${OCR_ANSI.yellow}`, "ocr")} ${OCR_DOT} ${ocrStyled(`${OCR_ANSI.bold};${OCR_ANSI.yellow}`, String(running))} ${ocrStyled(`${OCR_ANSI.bold};${OCR_ANSI.green}`, "running")}`,
            ...shown.map((r, i) => {
                const branch = !hasMore && i === shown.length - 1 ? "└─" : "├─";
                return `${branch} ${renderOcrRow(r, now)}`;
            }),
        ];
        if (hasMore) {
            lines.push(`└─ +${rows.length - OCR_MAX_ROWS} more`);
        }
        try {
            setWidget("ocr", lines);
        } catch {
            /* non-interactive host — ignore */
        }
    } catch {
        /* non-interactive host — ignore */
    }
}

function updateOcrWidget(
    ctx: any,
    id: string,
    patch: { kind: "review" | "scan"; title: string; startedAt: number },
): void {
    liveOcrJobs.set(id, { kind: patch.kind, title: patch.title, startedAt: patch.startedAt });
    lastOcrCtx = ctx;
    ensureOcrTimer();
    paintOcrWidget(ctx);
}

function finishOcrWidget(ctx: any, id: string): void {
    if (!liveOcrJobs.has(id)) {
        return;
    }
    liveOcrJobs.delete(id);
    if (liveOcrJobs.size === 0) {
        stopOcrTimer();
    }
    paintOcrWidget(ctx);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // ---- ocr_review ----
    pi.registerTool({
        name: "ocr_review",
        label: "OCR Review",
        description:
            "Run Open Code Review on workspace changes, a single commit, or a ref range. " +
            "Returns structured line-level findings as JSON. Use preview=true to inspect scope without LLM usage.",
        promptSnippet: "Review code changes with Open Code Review",
        promptGuidelines: [
            "Use ocr_review to get AI-powered code review on changes before committing",
            "Supports reviewing current workspace (staged+unstaged+untracked), a single commit, or a branch range",
            "Set preview=true to see which files would be reviewed without consuming LLM tokens",
            "Provide background context via the `background` parameter to focus the review on specific concerns",
            "After review: classify comments by priority — High (bugs, security, clear mistakes), Medium (reasonable concerns), Low (false positives, nits — discard silently)",
            "Only apply fixes when the user explicitly requested it (e.g. 'review and fix')",
        ],
        parameters: Type.Object({
            commit: optionalString("Review one commit against its parent."),
            from: optionalString(
                "Base ref for a branch/range comparison. Must be paired with 'to'.",
            ),
            to: optionalString(
                "Target ref for a branch/range comparison. Must be paired with 'from'.",
            ),
            resume: optionalString("Resume a previous OCR review session by ID."),
            background: optionalString(
                "Business or requirement context that the implementation should satisfy.",
            ),
            background_file: optionalString("Path to a Markdown file used as review background."),
            repo: optionalString(
                "Root directory of the git repository (default: current working directory).",
            ),
            exclude: optionalString("Comma-separated gitignore-style exclusion patterns."),
            model: optionalString(
                "Override the LLM model for this review (e.g., claude-opus-4-6).",
            ),
            concurrency: optionalPosInt("Maximum concurrent file reviews."),
            timeoutMinutes: optionalPosInt("Per-file OCR timeout in minutes."),
            maxTools: optionalPosInt(
                "Maximum tool-call rounds per file (OCR enforces a minimum of 50).",
            ),
            maxGitProcesses: optionalPosInt("Maximum concurrent Git subprocesses."),
            effort: optionalString("Review effort preset: low | medium | high (default medium)."),
            provider: optionalString("Override the configured LLM provider for this run."),
            rule: optionalString("Path to JSON file with system review rules."),
            tools: optionalString("Path to JSON tools config file."),
            maxTokens: optionalPosInt("Per-group prompt token ceiling (unset = template default)."),
            maxTokensBudget: optionalPosInt(
                "Cap total token usage for this review (unset = unlimited).",
            ),
            noFilter: optionalBool("Keep all review comments without LLM post-filtering."),
            output: optionalString("Write results to a UTF-8 file instead of stdout."),
            preview: optionalBool("List files that would be reviewed without calling an LLM."),
            runInBackground: optionalBool(
                "Run in background and return a job ID immediately; poll with ocr_job_status.",
            ),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            try {
                const emit = wrapUpdate(onUpdate);
                lastOcrCtx = ctx;

                const setupMsg = await ensureOcr(signal);
                if (setupMsg) {
                    emit("[ocr] Setup issue");
                    return fail(setupMsg);
                }

                const args = ["review", "--audience", "agent"];

                if (!params.preview) {
                    args.push("--format", "json");
                }

                const push = (flag: string, value: string | number | undefined) => {
                    if (value !== undefined && value !== "") args.push(flag, String(value));
                };

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

                if (params.runInBackground) {
                    return startBackgroundJob("review", args, { repo: params.repo, ctx, emit });
                }

                emit("[ocr] Starting review...");

                const result = await runOcr(args, { cwd: ctx.cwd, signal });

                if (result.code !== 0) {
                    return fail(
                        result.stderr || result.stdout || `OCR exited with code ${result.code}`,
                    );
                }

                if (result.stdout && params.preview) {
                    for (const line of result.stdout.split(/\r?\n/)) {
                        const t = line.trim();
                        if (t) emit(`[ocr] ${stripAnsi(t)}`);
                    }
                }

                const output = params.preview
                    ? result.stdout
                          .split(/\r?\n/)
                          .map((l) => `[ocr] ${stripAnsi(l)}`)
                          .join("\n")
                    : result.stdout;

                return ok(output);
            } catch (e: unknown) {
                const err = e as Error;
                if (err.name === "AbortError") return fail("Operation cancelled");
                return fail(err.message ?? String(err));
            }
        },
    });

    // ---- ocr_scan ----
    pi.registerTool({
        name: "ocr_scan",
        label: "OCR Scan",
        description:
            "Review entire files without needing a diff. " +
            "Scans the whole repository by default, or target specific paths. " +
            "Useful for auditing unfamiliar code or reviewing files that have no meaningful diff. " +
            "Returns structured line-level findings as JSON when using --format json.",
        promptSnippet: "Scan files with Open Code Review (full-file review, no diff needed)",
        promptGuidelines: [
            "Use ocr_scan for full-file review when there's no meaningful diff to review",
            "Useful for auditing unfamiliar codebases or reviewing specific files",
            "Set preview=true to see which files would be scanned without consuming LLM tokens",
            "After scan: classify comments by priority — High (bugs, security), Medium (reasonable concerns), Low (discard silently)",
        ],
        parameters: Type.Object({
            path: optionalString(
                "Comma-separated repo-relative dirs/files to scan (default: whole repo).",
            ),
            exclude: optionalString("Comma-separated gitignore-style patterns to exclude."),
            model: optionalString("Override the LLM model for this scan."),
            background: optionalString("Business or requirement context for the scan."),
            repo: optionalString(
                "Root directory of the git repository (default: current working directory).",
            ),
            no_plan: optionalBool("Skip the per-file PLAN_TASK pre-pass (faster, less focused)."),
            no_dedup: optionalBool("Skip per-batch DEDUP_TASK (keeps raw comments)."),
            no_summary: optionalBool("Skip the post-run PROJECT_SUMMARY_TASK."),
            batch: optionalString(
                'Override BATCH_STRATEGY: "none" | "by-language" | "by-directory".',
            ),
            concurrency: optionalPosInt("Max concurrent file scans."),
            timeoutMinutes: optionalPosInt("Per-file timeout in minutes."),
            maxTools: optionalPosInt("Max tool call rounds per file."),
            resume: optionalString("Resume a previous scan session by ID."),
            maxGitProcesses: optionalPosInt("Maximum concurrent Git subprocesses."),
            provider: optionalString("Override the configured LLM provider for this scan."),
            rule: optionalString("Path to JSON file with system review rules."),
            tools: optionalString("Path to JSON tools config file."),
            maxTokens: optionalPosInt("Per-file prompt token ceiling (unset = template default)."),
            maxTokensBudget: optionalPosInt(
                "Cap total token usage for this scan (unset = unlimited).",
            ),
            output: optionalString("Write results to a UTF-8 file instead of stdout."),
            preview: optionalBool("Preview which files would be scanned without calling an LLM."),
            runInBackground: optionalBool(
                "Run in background and return a job ID immediately; poll with ocr_job_status.",
            ),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            try {
                const emit = wrapUpdate(onUpdate);
                lastOcrCtx = ctx;

                const setupMsg = await ensureOcr(signal);
                if (setupMsg) {
                    emit("[ocr] Setup issue");
                    return fail(setupMsg);
                }

                const args = ["scan", "--audience", "agent"];

                if (!params.preview) {
                    args.push("--format", "json");
                }

                const push = (flag: string, value: string | number | boolean | undefined) => {
                    if (value !== undefined && value !== "") args.push(flag, String(value));
                };

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

                if (params.runInBackground) {
                    return startBackgroundJob("scan", args, { repo: params.repo, ctx, emit });
                }

                emit("[ocr] Starting scan...");

                const result = await runOcr(args, { cwd: ctx.cwd, signal });

                if (result.code !== 0) {
                    return fail(
                        result.stderr || result.stdout || `OCR exited with code ${result.code}`,
                    );
                }

                if (result.stdout && params.preview) {
                    for (const line of result.stdout.split(/\r?\n/)) {
                        const t = line.trim();
                        if (t) emit(`[ocr] ${stripAnsi(t)}`);
                    }
                }

                const output = params.preview
                    ? result.stdout
                          .split(/\r?\n/)
                          .map((l) => `[ocr] ${stripAnsi(l)}`)
                          .join("\n")
                    : result.stdout;

                return ok(output);
            } catch (e: unknown) {
                const err = e as Error;
                if (err.name === "AbortError") return fail("Operation cancelled");
                return fail(err.message ?? String(err));
            }
        },
    });

    // ---- ocr_health ----
    pi.registerTool({
        name: "ocr_health",
        label: "OCR Health",
        description:
            "Check the installed Open Code Review version and verify its configured LLM connection. " +
            "Use this to diagnose OCR setup issues before running reviews.",
        promptSnippet: "Check Open Code Review status and LLM connectivity",
        promptGuidelines: [
            "Use ocr_health to verify OCR is installed and the LLM is configured before running reviews",
            "Run this first if ocr_review or ocr_scan fail",
        ],
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, signal, onUpdate, ctx) {
            try {
                const emit = wrapUpdate(onUpdate);

                const setupMsg = await ensureOcr(signal);
                if (setupMsg) {
                    emit("[ocr] Setup issue");
                    return fail(setupMsg);
                }

                emit("[ocr] Checking ocr...");

                const [version, llm] = await Promise.allSettled([
                    runOcr(["version"], { cwd: ctx.cwd, signal, timeoutMs: 30_000 }),
                    runOcr(["llm", "test"], { cwd: ctx.cwd, signal, timeoutMs: 60_000 }),
                ]);

                const rejected = [version, llm].find(
                    (r): r is PromiseRejectedResult => r.status === "rejected",
                );
                if (signal?.aborted && rejected) return fail("Operation cancelled");

                const parts: string[] = [];
                if (version.status === "fulfilled") {
                    parts.push(version.value.stdout);
                } else {
                    parts.push(
                        `\u26a0 Version check: ${(version.reason as Error)?.message ?? "unknown"}`,
                    );
                }
                if (llm.status === "fulfilled") {
                    parts.push("---");
                    parts.push(llm.value.stdout);
                    if (llm.value.stderr) parts.push(llm.value.stderr);
                } else {
                    parts.push("---");
                    parts.push(`\u26a0 LLM test: ${(llm.reason as Error)?.message ?? "unknown"}`);
                }

                return ok(parts.filter(Boolean).join("\n"));
            } catch (e: unknown) {
                const err = e as Error;
                if (err.name === "AbortError") return fail("Operation cancelled");
                return fail(err.message ?? String(err));
            }
        },
    });

    // ---- ocr_job_status ----
    pi.registerTool({
        name: "ocr_job_status",
        label: "OCR Job Status",
        description:
            "Poll an OCR background job started with runInBackground, or list all jobs. " +
            "Returns status plus a capped stdout tail, never full logs.",
        promptSnippet: "Check OCR background job status",
        promptGuidelines: [
            "Use ocr_job_status to poll jobs started with runInBackground",
            "Omit id to list all jobs; pass tailLines to control the stdout tail (max 100)",
            "After review: classify comments by priority — High (bugs, security, clear mistakes), Medium (reasonable concerns), Low (false positives, nits — discard silently)",
        ],
        parameters: Type.Object({
            id: optionalString("Job ID; omit to list all jobs."),
            tailLines: optionalPosInt("Stdout tail lines (default 40, max 100)."),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            try {
                lastOcrCtx = ctx;
                reapStaleJobs();
                if (!params.id) {
                    const jobs = listSidecars();
                    if (jobs.length === 0) {
                        return ok("No OCR background jobs.");
                    }
                    jobs.sort((a, b) => {
                        const aRunning = a.status === "running" ? 0 : 1;
                        const bRunning = b.status === "running" ? 0 : 1;
                        if (aRunning !== bRunning) {
                            return aRunning - bRunning;
                        }
                        return b.startedAt - a.startedAt;
                    });
                    const lines = jobs.map((s) => {
                        const elapsed =
                            s.status === "running"
                                ? Date.now() - s.startedAt
                                : (s.endedAt ?? Date.now()) - s.startedAt;
                        let outBytes = 0;
                        try {
                            outBytes = fs.statSync(path.join(JOBS_DIR, `${s.id}.out.log`)).size;
                        } catch {
                            /* ignore */
                        }
                        return `${s.id} · ${s.kind} · ${s.status} · ${formatDuration(elapsed)} · ${outBytes} bytes`;
                    });
                    return ok(lines.join("\n"));
                }
                const raw = readSidecar(params.id);
                if (!raw) {
                    return fail(`Job ${params.id} not found.`);
                }
                const s = finalizeIfDead(raw);
                if (s.status === "running") {
                    let commit: string | undefined;
                    let from: string | undefined;
                    let to: string | undefined;
                    let scanPath: string | undefined;
                    for (let i = 0; i < s.args.length; i += 1) {
                        if (s.args[i] === "--commit" && s.args[i + 1] !== undefined) {
                            commit = s.args[i + 1];
                        }
                        if (s.args[i] === "--from" && s.args[i + 1] !== undefined) {
                            from = s.args[i + 1];
                        }
                        if (s.args[i] === "--to" && s.args[i + 1] !== undefined) {
                            to = s.args[i + 1];
                        }
                        if (s.args[i] === "--path" && s.args[i + 1] !== undefined) {
                            scanPath = s.args[i + 1];
                        }
                    }
                    try {
                        updateOcrWidget(ctx, s.id, {
                            kind: s.kind,
                            title: jobTitle(s.kind, { commit, from, to, path: scanPath }),
                            startedAt: s.startedAt,
                        });
                    } catch {
                        /* ignore */
                    }
                } else {
                    try {
                        finishOcrWidget(ctx, s.id);
                    } catch {
                        /* ignore */
                    }
                }
                const outLog = path.join(JOBS_DIR, `${s.id}.out.log`);
                const errLog = path.join(JOBS_DIR, `${s.id}.err.log`);
                let outBytes = 0;
                let errBytes = 0;
                try {
                    outBytes = fs.statSync(outLog).size;
                } catch {
                    /* ignore */
                }
                try {
                    errBytes = fs.statSync(errLog).size;
                } catch {
                    /* ignore */
                }
                const n = Math.min(params.tailLines ?? 40, 100);
                const tail = stripAnsi(tailFile(outLog, n));
                const elapsed =
                    s.status === "running"
                        ? Date.now() - s.startedAt
                        : (s.endedAt ?? Date.now()) - s.startedAt;
                const exit = s.exitCode ?? "unknown";
                return ok(
                    `job ${s.id} · ${s.kind} · ${s.status}\n` +
                        `exit: ${exit}\n` +
                        `elapsed: ${formatDuration(elapsed)}\n` +
                        `stdout: ${outBytes} bytes (${s.id}.out.log)\n` +
                        `stderr: ${errBytes} bytes (${s.id}.err.log)\n` +
                        `--- tail (last ${n} lines) ---\n` +
                        `${tail}`,
                );
            } catch (e: unknown) {
                const err = e as Error;
                return fail(err.message ?? String(err));
            }
        },
    });

    // ---- ocr_job_cancel ----
    pi.registerTool({
        name: "ocr_job_cancel",
        label: "OCR Job Cancel",
        description: "Stop a running OCR background job started with runInBackground.",
        promptSnippet: "Cancel an OCR background job",
        promptGuidelines: [
            "Use ocr_job_cancel to stop a running background job",
            "Pass the job id; already-finished jobs report their status without changes",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "Job ID to stop." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            try {
                lastOcrCtx = ctx;
                reapStaleJobs();
                const s = readSidecar(params.id);
                if (!s) {
                    return fail(`Job ${params.id} not found.`);
                }
                if (s.status !== "running") {
                    try {
                        finishOcrWidget(ctx, s.id);
                    } catch {
                        /* ignore */
                    }
                    return ok(`Job ${s.id} already ${s.status}.`);
                }
                if (!isAlive(s.pid)) {
                    const final = finalizeIfDead(s);
                    try {
                        finishOcrWidget(ctx, final.id);
                    } catch {
                        /* ignore */
                    }
                    return ok(`Job ${final.id} already ${final.status}.`);
                }
                try {
                    if (s.pid !== null) {
                        process.kill(s.pid, "SIGTERM");
                    }
                } catch {
                    const final = finalizeIfDead({ ...s, pid: null });
                    try {
                        finishOcrWidget(ctx, final.id);
                    } catch {
                        /* ignore */
                    }
                    return ok(`Job ${final.id} already ${final.status}.`);
                }
                const cancelled: OcrJobSidecar = { ...s, status: "cancelled", endedAt: Date.now() };
                try {
                    writeSidecar(cancelled);
                } catch {
                    /* ignore */
                }
                try {
                    finishOcrWidget(ctx, s.id);
                } catch {
                    /* ignore */
                }
                return ok(`Job ${s.id} cancelled.`);
            } catch (e: unknown) {
                const err = e as Error;
                return fail(err.message ?? String(err));
            }
        },
    });
}
