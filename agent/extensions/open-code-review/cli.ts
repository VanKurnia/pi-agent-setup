/**
 * Open Code Review — OCR binary resolution and process spawning.
 *
 * Resolves the `ocr` binary via PATH (memoized) and spawns it with
 * shell:false, buffering stdout/stderr. No shell metacharacter risk —
 * arguments are passed via process argv.
 */

import fs from "node:fs";
import { spawn, execSync } from "node:child_process";
import { stripAnsi } from "../shared/strip-ansi.js";

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
    opts: {
        cwd?: string;
        signal?: AbortSignal;
        timeoutMs?: number;
        onStderrLine?: (line: string) => void;
    } = {},
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
        let pending = "";
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
            // Progress lines stream here while stdout stays a single JSON
            // document; split into lines so the widget sees each action.
            pending += chunk.toString("utf8");
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            for (const part of parts) {
                opts.onStderrLine?.(part.replace(/\r$/, ""));
            }
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
                if (pending.length > 0) {
                    opts.onStderrLine?.(pending.replace(/\r$/, ""));
                    pending = "";
                }
                const result = {
                    stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
                    stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
                    code: exitCode ?? 1,
                };
                if (exitCode !== 0) {
                    // The full buffer is a wall of progress; the tail is the
                    // error. Fall back to stdout, then the exit code.
                    const tail = result.stderr.split(/\r?\n/).slice(-15).join("\n");
                    reject(
                        new Error(tail || result.stdout || `OCR exited with code ${result.code}`),
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
// CLI arg helpers
// ---------------------------------------------------------------------------

/** Collect optional CLI flags, skipping unset and empty values. */
function argPusher(args: string[]): (flag: string, value: unknown) => void {
    return (flag, value) => {
        if (value === undefined || value === "") return;
        args.push(flag, String(value));
    };
}

/** Preview runs are annotated line by line; JSON runs pass through unchanged. */
function formatOcrOutput(stdout: string, preview: boolean, emit: (msg: string) => void): string {
    if (!preview) return stdout;
    if (stdout) {
        for (const line of stdout.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed) emit(`[ocr] ${stripAnsi(trimmed)}`);
        }
    }
    return stdout
        .split(/\r?\n/)
        .map((line) => `[ocr] ${stripAnsi(line)}`)
        .join("\n");
}

export {
    resolveOcrCmd,
    invalidateOcrCmdCache,
    isOcrAvailable,
    ensureOcr,
    installFailed,
    runOcr,
    argPusher,
    formatOcrOutput,
};
