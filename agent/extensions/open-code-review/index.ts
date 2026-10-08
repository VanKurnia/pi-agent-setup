/**
 * Open Code Review — Pi native tools wrapping the `ocr` CLI
 *
 * Registers:
 *   ocr_review   — Review workspace changes, a single commit, or a ref range
 *   ocr_scan     — Full-file scan (no diff needed)
 *   ocr_health   — Check OCR installation and LLM connectivity
 *
 * Declarations, the TUI widget, and the shared run pipeline live here.
 * Process execution and progress parsing are lazily loaded from `./engine.js`.
 */

import type {
    AgentToolUpdateCallback,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ANSI, DOT, SPINNER, TICK_MS, styled, styledDuration } from "../shared/widget-kit.js";
import type { OcrRunState } from "./engine.js";

// `engine.js` pulls in child_process, so it must stay off the boot path. It is
// loaded lazily everywhere it is needed. `invalidateOcrCmdCache` lives in
// engine.ts alongside the cache it clears, so the only way to reach it is to
// import the module - which is exactly what we are avoiding at boot.
//
// The session_start reset therefore registers a hook instead of importing
// eagerly: once engine.js has actually been loaded (so the memoized `where ocr`
// lookup could be dirty), the hook becomes available and resetOcrWidgetState
// uses it. Before that the cache is still undefined and there is nothing to
// invalidate, so skipping the call is exact rather than approximate.
let invalidateOcrCache: (() => void) | undefined;

async function loadEngine(): Promise<typeof import("./engine.js")> {
    const engine = await import("./engine.js");
    invalidateOcrCache = engine.invalidateOcrCmdCache;
    return engine;
}

// =============================================================================
// Parameter Schemas
// =============================================================================

const optionalString = (description: string) => Type.Optional(Type.String({ description }));
const optionalPosInt = (description: string) =>
    Type.Optional(Type.Integer({ description, minimum: 1 }));
const optionalBool = (description: string) => Type.Optional(Type.Boolean({ description }));

export const reviewParams = Type.Object({
    commit: optionalString("Review one commit against its parent."),
    from: optionalString("Base ref for a branch/range comparison. Must be paired with 'to'."),
    to: optionalString("Target ref for a branch/range comparison. Must be paired with 'from'."),
    resume: optionalString("Resume a previous OCR review session by ID."),
    background: optionalString(
        "Business or requirement context that the implementation should satisfy.",
    ),
    background_file: optionalString("Path to a Markdown file used as review background."),
    repo: optionalString(
        "Root directory of the git repository (default: current working directory).",
    ),
    exclude: optionalString("Comma-separated gitignore-style exclusion patterns."),
    model: optionalString("Override the LLM model for this review (e.g., claude-opus-4-6)."),
    concurrency: optionalPosInt("Number of parallel review threads (default: CPU cores)."),
    timeoutMinutes: optionalPosInt("Overall review timeout in minutes."),
    maxTools: optionalPosInt("Maximum tool executions during analysis."),
    maxGitProcesses: optionalPosInt("Maximum concurrent git processes (default: 4)."),
    effort: optionalString("Reasoning effort for thinking models (low, medium, high)."),
    provider: optionalString("Force a specific LLM provider for the review."),
    rule: optionalString("Path to custom review instructions file or directory."),
    tools: optionalString("Comma-separated list of tools available to OCR during review."),
    maxTokens: optionalPosInt("Context window size override."),
    maxTokensBudget: optionalPosInt("Maximum token spend limit for the review."),
    noFilter: optionalBool("Disable file filtering — review all changed files."),
    output: optionalString("Path to write the review output."),
    preview: optionalBool(
        "Generate and display review prompts without making LLM calls. Useful for inspecting the review scope.",
    ),
});

export const scanParams = Type.Object({
    path: optionalString("Target directory or file to scan (default: whole repository)."),
    exclude: optionalString("Comma-separated gitignore-style exclusion patterns."),
    model: optionalString("Override the LLM model for this scan."),
    background: optionalString("Business context for the scan."),
    repo: optionalString("Root directory of the git repository."),
    no_plan: optionalBool("Skip review plan generation."),
    no_dedup: optionalBool("Disable deduplication of review comments."),
    no_summary: optionalBool("Disable executive summary generation."),
    batch: optionalString("Batch strategy: smart, count=<n>, tokens=<n>, single, or none."),
    concurrency: optionalPosInt("Number of parallel scan threads."),
    timeoutMinutes: optionalPosInt("Overall scan timeout in minutes."),
    maxTools: optionalPosInt("Maximum tool executions during analysis."),
    resume: optionalString("Resume a previous OCR scan session by ID."),
    maxGitProcesses: optionalPosInt("Maximum concurrent git processes."),
    provider: optionalString("Force a specific LLM provider."),
    rule: optionalString("Path to custom review instructions file."),
    tools: optionalString("Comma-separated list of tools available to OCR."),
    maxTokens: optionalPosInt("Context window size override."),
    maxTokensBudget: optionalPosInt("Maximum token spend limit."),
    output: optionalString("Path to write the scan output."),
    preview: optionalBool("Preview the scan scope without calling the LLM."),
});

export const healthParams = Type.Object({
    model: optionalString("LLM model to test connectivity with (optional)."),
});

// =============================================================================
// Status Widget
// =============================================================================

const MAX_ROWS = 6;
const MAX_FINISHED = 128;
const MAX_SCOPE = 60;

const live = new Map<string, OcrRunState>();
const finished = new Set<string>();
let lastCtx: ExtensionContext | undefined;
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

function paint(ctx: ExtensionContext | undefined): void {
    const setWidget = ctx?.ui?.setWidget;
    if (!ctx?.hasUI || typeof setWidget !== "function") return;

    if (live.size === 0) {
        try {
            setWidget("ocr", undefined);
        } catch {}
        return;
    }

    const now = Date.now();
    const rows = Array.from(live.values());
    const running = rows.filter((r) => r.phase === "running").length;
    const shown = rows.slice(0, MAX_ROWS);
    const hasMore = rows.length > MAX_ROWS;

    const lines = [
        `${styled(`${ANSI.bold};${ANSI.yellow}`, "Open Code Review")} ${DOT} ${styled(`${ANSI.bold};${ANSI.yellow}`, String(running))} ${styled(`${ANSI.bold};${ANSI.green}`, "running")}`,
        ...shown.map((r, i) => {
            const branch = !hasMore && i === shown.length - 1 ? "└─" : "├─";
            const spinner = SPINNER[Math.floor(now / TICK_MS) % SPINNER.length];
            const elapsed = styledDuration(now - r.startedAt);
            const scope =
                r.scope.length > MAX_SCOPE ? `${r.scope.slice(0, MAX_SCOPE - 1)}…` : r.scope;
            return `${branch} ${styled(ANSI.cyan, spinner)} ${r.mode} ${DOT} ${scope} ${DOT} ${elapsed}`;
        }),
    ];
    if (hasMore) lines.push(`└─ +${rows.length - MAX_ROWS} more`);

    try {
        setWidget("ocr", lines);
    } catch {}
}

export function updateOcrWidget(
    ctx: ExtensionContext | undefined,
    toolCallId: string,
    state: OcrRunState,
): void {
    if (finished.has(toolCallId)) return;
    live.set(toolCallId, state);
    lastCtx = ctx;
    ensureTimer();
    paint(ctx);
}

export function finishOcrWidget(ctx: ExtensionContext | undefined, toolCallId: string): void {
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

export function resetOcrWidgetState(_ctx?: ExtensionContext): void {
    live.clear();
    finished.clear();
    stopTimer();
    lastCtx = undefined;
    invalidateOcrCache?.();
}

// =============================================================================
// Tool Helpers
// =============================================================================

function ok(text: string, details?: unknown) {
    return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

function fail(message: string, details?: unknown) {
    return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true as const,
        details: details ?? {},
    };
}

function makeEmitter(onUpdate: AgentToolUpdateCallback<unknown> | undefined) {
    return (msg: string, details?: unknown) => {
        try {
            onUpdate?.({ content: [{ type: "text", text: msg }], details: details ?? {} });
        } catch {}
    };
}

/** Fields that identify which slice of the workspace a run covers. */
interface OcrToolParams {
    preview?: boolean;
    commit?: string;
    from?: string;
    to?: string;
    path?: string;
}

/**
 * Shared body of `ocr_review` and `ocr_scan`: both tools run the same
 * setup → spawn → stream → parse pipeline and differ only in CLI arguments.
 */
async function runOcrTool<P extends OcrToolParams>(
    mode: "review" | "scan",
    params: P,
    buildArgs: (params: P) => string[],
    toolCallId: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
) {
    const {
        ensureOcr,
        runOcr,
        formatOcrOutput,
        createRunState,
        applyProgressLine,
        applyPreviewResult,
        applyResult,
        describeScope,
    } = await loadEngine();

    const runState = createRunState(mode, describeScope(mode, params));
    const emit = makeEmitter(onUpdate);
    const failRun = (message: string) => {
        runState.phase = "failed";
        runState.finishedMs = Date.now() - runState.startedAt;
        runState.error = message;
        return fail(message, runState);
    };

    try {
        const setupMsg = await ensureOcr(signal);
        if (signal?.aborted) return failRun("Operation cancelled");
        if (setupMsg) {
            emit("[ocr] Setup issue");
            return failRun(setupMsg);
        }

        updateOcrWidget(ctx, toolCallId, runState);
        emit(`[ocr] Starting ${mode}...`);

        const result = await runOcr(buildArgs(params), {
            cwd: ctx.cwd,
            signal,
            onStderrLine: (line) => {
                applyProgressLine(runState, line);
                emit(line, runState);
            },
        });

        if (result.code !== 0) {
            const errMsg = result.stderr || result.stdout || `OCR exited with code ${result.code}`;
            return failRun(errMsg.trim());
        }

        if (params.preview === true) {
            applyPreviewResult(runState, result.stdout);
            return ok(formatOcrOutput(result.stdout, true, emit), runState);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(result.stdout);
        } catch {
            const rawOutput = (result.stdout || result.stderr || "(empty)").trim();
            return failRun(`OCR returned invalid JSON output:\n${rawOutput}`);
        }

        applyResult(runState, parsed);
        return ok(formatOcrOutput(result.stdout, false, emit), runState);
    } catch (e: unknown) {
        const err = e as Error;
        if (err.name === "AbortError") return failRun("Operation cancelled");
        return failRun(err.message ?? String(err));
    } finally {
        finishOcrWidget(ctx, toolCallId);
    }
}

// =============================================================================
// Tool Registration
// =============================================================================

export default function openCodeReview(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
        resetOcrWidgetState(ctx);
    });

    // ---- ocr_review ----
    pi.registerTool({
        name: "ocr_review",
        label: "OCR Review",
        annotations: { readOnlyHint: true },
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
        execute: (toolCallId, params, signal, onUpdate, ctx) =>
            loadEngine().then(({ buildReviewArgs }) =>
                runOcrTool("review", params, buildReviewArgs, toolCallId, ctx, signal, onUpdate),
            ),
    });

    // ---- ocr_scan ----
    pi.registerTool({
        name: "ocr_scan",
        label: "OCR Scan",
        annotations: { readOnlyHint: true },
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
        execute: (toolCallId, params, signal, onUpdate, ctx) =>
            loadEngine().then(({ buildScanArgs }) =>
                runOcrTool("scan", params, buildScanArgs, toolCallId, ctx, signal, onUpdate),
            ),
    });

    // ---- ocr_health ----
    pi.registerTool({
        name: "ocr_health",
        label: "OCR Health",
        annotations: { readOnlyHint: true, idempotentHint: true },
        description:
            "Check the installed Open Code Review version and verify its configured LLM connection. " +
            "Use this to diagnose OCR setup issues before running reviews.",
        promptSnippet: "Check Open Code Review status and LLM connectivity",
        promptGuidelines: [
            "Use ocr_health to verify OCR is installed and the LLM is configured before running reviews",
            "Run this first if ocr_review or ocr_scan fail",
        ],
        parameters: healthParams,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const { ensureOcr, runOcr } = await loadEngine();
            const emit = makeEmitter(onUpdate);

            const setupMsg = await ensureOcr(signal);
            if (setupMsg) {
                emit("[ocr] Setup issue");
                return fail(setupMsg);
            }
            emit("[ocr] Checking ocr...");

            const llmArgs = ["llm", "test"];
            if (params.model) llmArgs.push("--model", params.model);

            const [version, llm] = await Promise.all([
                runOcr(["version"], { cwd: ctx.cwd, signal, timeoutMs: 30_000 }),
                runOcr(llmArgs, { cwd: ctx.cwd, signal, timeoutMs: 60_000 }),
            ]);
            if (signal?.aborted) return fail("Operation cancelled");

            return ok([version.stdout, "---", llm.stdout, llm.stderr].filter(Boolean).join("\n"));
        },
    });
}
