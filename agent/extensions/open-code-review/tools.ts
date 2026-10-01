/**
 * Open Code Review — tool registrations over one shared arg shape per tool.
 *
 * buildReviewArgs/buildScanArgs pin the exact CLI flag order; the handlers
 * below compose them with runOcr. A throwaway harness in tmp/ asserts the
 * arrays so a future reorder is caught mechanically.
 */

import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ok, fail } from "../git-toolkit/helpers.js";
import { ensureOcr, runOcr, argPusher, formatOcrOutput } from "./cli.js";
import { reviewParams, scanParams, healthParams } from "./params.js";
import { createRunState, applyProgressLine, applyResult, describeScope } from "./progress.js";
import { updateOcrWidget, finishOcrWidget } from "./widget.js";

/**
 * Build an onUpdate emitter that carries the live run state in details.
 * Calling onUpdate with a plain string crashes pi, so msg is required text.
 */
function makeEmitter(onUpdate: AgentToolUpdateCallback<unknown> | undefined) {
    return (msg: string, details?: unknown) => {
        try {
            onUpdate?.({ content: [{ type: "text", text: msg }], details: details ?? {} });
        } catch {
            /* safety */
        }
    };
}

interface ReviewToolParams {
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

/** Exact argv for `ocr review`, in CLI flag order. */
function buildReviewArgs(params: ReviewToolParams): string[] {
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

interface ScanToolParams {
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

/** Exact argv for `ocr scan`, in CLI flag order. */
function buildScanArgs(params: ScanToolParams): string[] {
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

function registerOcrTools(pi: ExtensionAPI): void {
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
        parameters: reviewParams,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const runState = createRunState("review", describeScope("review", params));
            const emit = makeEmitter(onUpdate);
            try {
                const setupMsg = await ensureOcr(signal);
                if (setupMsg) {
                    emit("[ocr] Setup issue");
                    return fail(setupMsg);
                }

                const args = buildReviewArgs(params);

                updateOcrWidget(ctx, toolCallId, runState);
                emit("[ocr] Starting review...");

                const result = await runOcr(args, {
                    cwd: ctx.cwd,
                    signal,
                    onStderrLine: (line) => {
                        applyProgressLine(runState, line);
                        emit(line, runState);
                    },
                });

                if (result.code !== 0) {
                    return fail(
                        result.stderr || result.stdout || `OCR exited with code ${result.code}`,
                    );
                }

                if (params.preview === true) {
                    // Preview stdout is plain text, not JSON — never parse it.
                    runState.phase = "done";
                    runState.finishedMs = Date.now() - runState.startedAt;
                    return ok(formatOcrOutput(result.stdout, true, emit), runState);
                }

                applyResult(runState, JSON.parse(result.stdout));
                runState.finishedMs = Date.now() - runState.startedAt;
                return ok(formatOcrOutput(result.stdout, false, emit), runState);
            } catch (e: unknown) {
                const err = e as Error;
                runState.phase = "failed";
                runState.finishedMs = Date.now() - runState.startedAt;
                if (err.name === "AbortError") {
                    runState.error = "Operation cancelled";
                    return fail("Operation cancelled", runState);
                }
                runState.error = err.message ?? String(err);
                return fail(err.message ?? String(err), runState);
            } finally {
                finishOcrWidget(ctx, toolCallId);
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
        parameters: scanParams,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const runState = createRunState("scan", describeScope("scan", params));
            const emit = makeEmitter(onUpdate);
            try {
                const setupMsg = await ensureOcr(signal);
                if (setupMsg) {
                    emit("[ocr] Setup issue");
                    return fail(setupMsg);
                }

                const args = buildScanArgs(params);

                updateOcrWidget(ctx, toolCallId, runState);
                emit("[ocr] Starting scan...");

                const result = await runOcr(args, {
                    cwd: ctx.cwd,
                    signal,
                    onStderrLine: (line) => {
                        applyProgressLine(runState, line);
                        emit(line, runState);
                    },
                });

                if (result.code !== 0) {
                    return fail(
                        result.stderr || result.stdout || `OCR exited with code ${result.code}`,
                    );
                }

                if (params.preview === true) {
                    // Preview stdout is plain text, not JSON — never parse it.
                    runState.phase = "done";
                    runState.finishedMs = Date.now() - runState.startedAt;
                    return ok(formatOcrOutput(result.stdout, true, emit), runState);
                }

                applyResult(runState, JSON.parse(result.stdout));
                runState.finishedMs = Date.now() - runState.startedAt;
                return ok(formatOcrOutput(result.stdout, false, emit), runState);
            } catch (e: unknown) {
                const err = e as Error;
                runState.phase = "failed";
                runState.finishedMs = Date.now() - runState.startedAt;
                if (err.name === "AbortError") {
                    runState.error = "Operation cancelled";
                    return fail("Operation cancelled", runState);
                }
                runState.error = err.message ?? String(err);
                return fail(err.message ?? String(err), runState);
            } finally {
                finishOcrWidget(ctx, toolCallId);
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
        parameters: healthParams,
        async execute(_toolCallId, _params, signal, onUpdate, ctx) {
            try {
                const emit = makeEmitter(onUpdate);

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
}

export { registerOcrTools, buildReviewArgs, buildScanArgs };
export type { ReviewToolParams, ScanToolParams };
