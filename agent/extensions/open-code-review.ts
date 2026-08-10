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
 *   - Auto-installs the `ocr` CLI if missing
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
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// OCR binary resolution — find the ocr binary on PATH (shell:false)
// ---------------------------------------------------------------------------

/**
 * Resolve the OCR binary path via system PATH (`where ocr` or `which ocr`).
 * Works with both standalone compiled binaries (Scoop/GitHub releases)
 * and Node.js npm global scripts.
 */
function resolveOcrCmd(): string | null {
  try {
    const isWin = process.platform === "win32";
    const findCmd = isWin ? "where ocr" : "which ocr";
    const findOutput = execSync(findCmd, { encoding: "utf8", timeout: 10_000 });
    const lines = findOutput.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let binPath = lines.find((l) => l.endsWith(".exe") || l.endsWith(".cmd") || l.endsWith(".bat")) || lines[0];
    if (binPath && fs.existsSync(binPath)) return binPath;

    return null;
  } catch {
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
      return reject(new Error(
        "Open Code Review CLI (`ocr`) is not installed.\nSee: https://github.com/alibaba/open-code-review",
      ));
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
      forceKillTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3000);
      reject(new DOMException("Operation aborted", "AbortError"));
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
      const msg = err.code === "ENOENT"
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
          reject(new Error(result.stderr || result.stdout || `OCR exited with code ${result.code}`));
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

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
    details: {},
  };
}

/** Strip ANSI escape codes */
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");

const optionalString = (description: string) => Type.Optional(Type.String({ description }));
const optionalPosInt = (description: string) => Type.Optional(Type.Integer({ description, minimum: 1 }));
const optionalBool = (description: string) => Type.Optional(Type.Boolean({ description }));

/**
 * Build an onUpdate wrapper that transforms a string msg into the
 * proper object format: { content: [{ type: "text", text: msg }], details: {} }
 * Calling onUpdate with a plain string crashes pi.
 */
function wrapUpdate(onUpdate: AgentToolUpdateCallback<unknown> | undefined): (msg: string) => void {
  return (msg: string) => {
    try { onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }); } catch { /* safety */ }
  };
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
      from: optionalString("Base ref for a branch/range comparison. Must be paired with 'to'."),
      to: optionalString("Target ref for a branch/range comparison. Must be paired with 'from'."),
      resume: optionalString("Resume a previous OCR review session by ID."),
      background: optionalString("Business or requirement context that the implementation should satisfy."),
      background_file: optionalString("Path to a Markdown file used as review background."),
      repo: optionalString("Root directory of the git repository (default: current working directory)."),
      exclude: optionalString("Comma-separated gitignore-style exclusion patterns."),
      model: optionalString("Override the LLM model for this review (e.g., claude-opus-4-6)."),
      concurrency: optionalPosInt("Maximum concurrent file reviews."),
      timeoutMinutes: optionalPosInt("Per-file OCR timeout in minutes."),
      maxTools: optionalPosInt("Maximum tool-call rounds per file (OCR enforces a minimum of 10)."),
      maxGitProcesses: optionalPosInt("Maximum concurrent Git subprocesses."),
      preview: optionalBool("List files that would be reviewed without calling an LLM."),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const emit = wrapUpdate(onUpdate);

        const setupMsg = await ensureOcr(signal);
        if (setupMsg) { emit("[ocr] Setup issue"); return fail(setupMsg); }

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

        if (params.preview) args.push("--preview");

        emit("[ocr] Starting review...");

        const result = await runOcr(args, { cwd: ctx.cwd, signal });

        if (result.code !== 0) {
          return fail(result.stderr || result.stdout || `OCR exited with code ${result.code}`);
        }

        if (result.stdout && params.preview) {
          for (const line of result.stdout.split(/\r?\n/)) {
            const t = line.trim();
            if (t) emit(`[ocr] ${stripAnsi(t)}`);
          }
        }

        const output = params.preview
          ? result.stdout.split(/\r?\n/).map((l) => `[ocr] ${stripAnsi(l)}`).join("\n")
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
      path: optionalString("Comma-separated repo-relative dirs/files to scan (default: whole repo)."),
      exclude: optionalString("Comma-separated gitignore-style patterns to exclude."),
      model: optionalString("Override the LLM model for this scan."),
      background: optionalString("Business or requirement context for the scan."),
      repo: optionalString("Root directory of the git repository (default: current working directory)."),
      no_plan: optionalBool("Skip the per-file PLAN_TASK pre-pass (faster, less focused)."),
      no_dedup: optionalBool("Skip per-batch DEDUP_TASK (keeps raw comments)."),
      no_summary: optionalBool("Skip the post-run PROJECT_SUMMARY_TASK."),
      batch: optionalString('Override BATCH_STRATEGY: "none" | "by-language" | "by-directory".'),
      concurrency: optionalPosInt("Max concurrent file scans."),
      timeoutMinutes: optionalPosInt("Per-file timeout in minutes."),
      maxTools: optionalPosInt("Max tool call rounds per file."),
      preview: optionalBool("Preview which files would be scanned without calling an LLM."),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const emit = wrapUpdate(onUpdate);

        const setupMsg = await ensureOcr(signal);
        if (setupMsg) { emit("[ocr] Setup issue"); return fail(setupMsg); }

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

        if (params.no_plan) args.push("--no-plan");
        if (params.no_dedup) args.push("--no-dedup");
        if (params.no_summary) args.push("--no-summary");
        if (params.batch) args.push("--batch", params.batch);
        if (params.preview) args.push("--preview");

        emit("[ocr] Starting scan...");

        const result = await runOcr(args, { cwd: ctx.cwd, signal });

        if (result.code !== 0) {
          return fail(result.stderr || result.stdout || `OCR exited with code ${result.code}`);
        }

        if (result.stdout && params.preview) {
          for (const line of result.stdout.split(/\r?\n/)) {
            const t = line.trim();
            if (t) emit(`[ocr] ${stripAnsi(t)}`);
          }
        }

        const output = params.preview
          ? result.stdout.split(/\r?\n/).map((l) => `[ocr] ${stripAnsi(l)}`).join("\n")
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
        if (setupMsg) { emit("[ocr] Setup issue"); return fail(setupMsg); }

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
          parts.push(`\u26a0 Version check: ${(version.reason as Error)?.message ?? "unknown"}`);
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
}
