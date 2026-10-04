/**
 * Running a subagent: diff capture, one agent run, the four execution modes,
 * and the dispatcher that selects between them.
 */
import {
    DEFAULT_MAX_CONCURRENCY,
    discoverAgents,
    getAgents,
    resolveAgentModel,
    type AgentConfig,
    type AgentProgress,
    type AgentResult,
    type AgentScope,
    type Details,
    type FilechangesApi,
    type HybridPhase,
    type SettingsManager,
    type TaskSpec,
} from "./core.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import {
    createAgentSession,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    getAgentDir,
    SessionManager,
    truncateTail,
    type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getExtensionApi } from "../../shared/cross-extension-api.js";

// ── Concurrency helpers ─────────────────────────────────────────────────

/** Rate-limits `fn` to at most one call per `ms`, trailing call included. */
function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
    let lastCall = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return ((...args: any[]) => {
        const now = Date.now();
        const remaining = ms - (now - lastCall);
        if (remaining <= 0) {
            lastCall = now;
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            fn(...args);
        } else if (!timer) {
            timer = setTimeout(() => {
                lastCall = Date.now();
                timer = undefined;
                fn(...args);
            }, remaining);
        }
    }) as T;
}

/** Maps `items` through `fn` with at most `concurrency` calls in flight, preserving order. */
async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i], i);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

// ── Diff capture ────────────────────────────────────────────────────────
const execFileAsync = promisify(execFile);

// Heuristic: a "file path" inside backticks has at least one / or \\
// plus an extension (dot followed by alphanumeric). This excludes things
// like `npm test`, `hello`, or variable names while catching both
// relative paths (extensions/foo.ts) and absolute paths (C:/Users/...).
const FILE_PATH_IN_TICKS = /`([^`]+[/\\][^`]+\.[a-zA-Z0-9_]+)`/g;

function makeRelPath(raw: string, cwd: string): string {
    // Normalize backslashes
    const p = raw.replace(/\\/g, "/");
    // If absolute Windows path (e.g. C:/Users/...), make relative to cwd
    if (p.match(/^[a-zA-Z]:\//)) {
        const rel = path.relative(cwd, p);
        // path.relative normalizes to / but may produce \\ on Windows
        return rel.replace(/\\/g, "/");
    }
    return p;
}

function extractFilePaths(output: string): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();

    // Strategy 1: bullet points in ## Changes Made section (most reliable)
    const changesMatch = output.match(/## Changes Made[\s\S]*?(?=## |$)/);
    if (changesMatch) {
        for (const line of changesMatch[0].split("\n")) {
            const m = line.match(/^-\s+`([^`]+)`/);
            if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                paths.push(m[1]);
            }
        }
    }

    // Strategy 2: scan all lines for backtick-wrapped file paths
    // Only if no paths found via strategy 1 (worker may not have used format)
    if (paths.length === 0) {
        for (const line of output.split("\n")) {
            if (line.startsWith("#") || line.startsWith("\`\`\`")) continue;
            const matches = line.matchAll(FILE_PATH_IN_TICKS);
            for (const m of matches) {
                if (!seen.has(m[1])) {
                    seen.add(m[1]);
                    paths.push(m[1]);
                }
            }
        }
    }

    return paths;
}

async function getFileDiff(filePath: string, cwd: string): Promise<string> {
    const relPath = makeRelPath(filePath, cwd);

    let isTracked = false;
    try {
        await execFileAsync("git", ["cat-file", "-e", `HEAD:${relPath}`], { cwd });
        isTracked = true;
    } catch {}

    let raw: string;
    if (isTracked) {
        const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", relPath], {
            cwd,
            maxBuffer: 1024 * 64,
        });
        raw = stdout;
    } else {
        const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
        try {
            const { stdout } = await execFileAsync(
                "git",
                ["diff", "--no-index", nullDevice, relPath],
                {
                    cwd,
                    maxBuffer: 1024 * 64,
                },
            );
            raw = stdout;
        } catch (err: any) {
            // git diff --no-index exits with code 1 when differences exist.
            if (err?.code === 1 && typeof err?.stdout === "string") {
                raw = err.stdout;
            } else {
                throw err;
            }
        }
    }

    return (raw || "").trim();
}

export async function computeWorkerDiffs(output: string, cwd: string, ctx?: any): Promise<string> {
    const filePaths = extractFilePaths(output);
    const parts: string[] = [];

    const filechanges = getExtensionApi<FilechangesApi>("filechanges");

    for (const filePath of filePaths) {
        try {
            const relPath = makeRelPath(filePath, cwd);
            const absPath = path.resolve(cwd, relPath);

            // Register with filechanges so users can accept/decline the
            // worker's modifications. We read the pre-worker baseline from git
            // because computeWorkerDiffs runs *after* the worker finished.
            if (filechanges) {
                try {
                    const isTracked = await execFileAsync(
                        "git",
                        ["cat-file", "-e", `HEAD:${relPath}`],
                        { cwd },
                    )
                        .then(() => true)
                        .catch(() => false);
                    // originalContent for tracked files = git HEAD;
                    // for new files = null (didn't exist before)
                    const orig = isTracked
                        ? (
                              await execFileAsync("git", ["show", `HEAD:${relPath}`], { cwd }).then(
                                  (r) => r.stdout,
                              )
                          ).trimEnd()
                        : null;
                    await filechanges.trackFile(ctx, relPath, absPath, orig);
                } catch {
                    /* non-fatal */
                }
            }

            const diff = await getFileDiff(filePath, cwd);
            if (diff) {
                parts.push(`### ${filePath}

\`\`\`diff
${diff}
\`\`\``);
            }
        } catch {
            // File might have been deleted or path invalid — skip
        }
    }

    return parts.length
        ? `

## File changes

${parts.join("\n\n")}`
        : "";
}

// ── One agent run ──────────────────────────────────────────────────────
function extractTextFromContent(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
    }
    return "";
}

function extractToolArgsPreview(args: Record<string, unknown>): string {
    if (args.command) return String(args.command).slice(0, 100);
    if (args.path) return String(args.path);
    if (args.query) return `"${String(args.query).slice(0, 80)}"`;
    if (args.url) return String(args.url);
    if (args.pattern) return String(args.pattern);
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

async function runAttempt(
    agent: AgentConfig,
    task: string,
    cwd: string,
    agentDir: string,
    model: Model<any> | undefined,
    signal: AbortSignal | undefined,
    onUpdate?: (progress: AgentProgress) => void,
): Promise<AgentResult> {
    // Omit unsupported thinking levels (null map entry): fall back to the model default.
    let thinkingLevel: ThinkingLevel | undefined = agent.thinkingLevel;
    const levelMap = model?.thinkingLevelMap;
    if (thinkingLevel && levelMap && levelMap[thinkingLevel] === null) thinkingLevel = undefined;
    const result: AgentResult = {
        agent: agent.name,
        task,
        output: "",
        exitCode: 0,
        model: model ? `${model.provider}/${model.id}` : agent.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        progress: {
            agent: agent.name,
            status: "running",
            task,
            recentTools: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
            lastMessage: "",
        },
    };

    const startTime = Date.now();
    const progress = result.progress;
    const fireUpdate = throttle(() => {
        progress.durationMs = Date.now() - startTime;
        onUpdate?.(progress);
    }, 150);

    // Create in-process session
    let session: AgentSession;
    try {
        const sessionResult = await createAgentSession({
            cwd,
            agentDir,
            tools: agent.tools.length > 0 ? agent.tools : undefined,
            model,
            thinkingLevel,
            sessionManager: SessionManager.inMemory(cwd), // ponytail: subagents are one-shot, never resumed — in-memory avoids orphaned session .jsonl files
        });
        session = sessionResult.session;
    } catch (err: any) {
        result.exitCode = 1;
        progress.error = `Failed to create session: ${err?.message || String(err)}`;
        progress.status = "failed";
        progress.durationMs = Date.now() - startTime;
        return result;
    }

    // Subscribe to session events for progress
    const unsubscribe = session.subscribe((event) => {
        progress.durationMs = Date.now() - startTime;

        switch (event.type) {
            case "tool_execution_start": {
                progress.toolCount++;
                progress.currentTool = event.toolName;
                progress.currentToolArgs = extractToolArgsPreview(
                    (event.args || {}) as Record<string, unknown>,
                );
                progress.currentToolArgsObj = (event.args || {}) as Record<string, unknown>;
                fireUpdate();
                break;
            }
            case "tool_execution_end": {
                if (progress.currentTool) {
                    progress.recentTools.push({
                        tool: progress.currentTool,
                        args: progress.currentToolArgs || "",
                        argsObj: progress.currentToolArgsObj,
                    });
                    if (progress.recentTools.length > 20) {
                        progress.recentTools.splice(0, progress.recentTools.length - 20);
                    }
                }
                progress.currentTool = undefined;
                progress.currentToolArgs = undefined;
                progress.currentToolArgsObj = undefined;
                fireUpdate();
                break;
            }
            case "agent_end": {
                // The run can end on a tool result; only assistant text is the answer.
                for (let i = event.messages.length - 1; i >= 0; i--) {
                    const msg = event.messages[i] as any;
                    if (msg?.role !== "assistant") continue;
                    const text = extractTextFromContent(msg.content);
                    if (text) result.output = text;
                    break;
                }
                break;
            }
            case "message_end": {
                if ((event.message as any)?.role === "assistant") {
                    const msg = event.message as any;
                    result.usage.turns++;
                    const u = msg.usage;
                    if (u) {
                        result.usage.input += u.input || 0;
                        result.usage.output += u.output || 0;
                        result.usage.cacheRead += u.cacheRead || 0;
                        result.usage.cacheWrite += u.cacheWrite || 0;
                        result.usage.cost += u.cost?.total || 0;
                        progress.tokens = result.usage.input + result.usage.output;
                    }
                    if (msg.model) result.model = msg.model;
                    if (msg.errorMessage) progress.error = msg.errorMessage;
                    const text = extractTextFromContent(msg.content);
                    if (text) {
                        result.output = text;
                        const proseLines: string[] = [];
                        let inCodeBlock = false;
                        for (const line of text.split("\n")) {
                            if (line.trimStart().startsWith("```")) {
                                inCodeBlock = !inCodeBlock;
                                continue;
                            }
                            if (!inCodeBlock && line.trim()) proseLines.push(line.trim());
                        }
                        if (proseLines.length > 0)
                            progress.lastMessage = proseLines.slice(0, 3).join(" ");
                    }
                }
                fireUpdate();
                break;
            }
        }
    });

    // Wire up abort signal to abort the session
    const abortSession = () => {
        session.abort().catch(() => {});
    };
    if (signal?.aborted) abortSession();
    else signal?.addEventListener("abort", abortSession, { once: true });

    try {
        // Run the agent with the task as prompt
        await session.prompt(task);
    } catch (err: any) {
        result.exitCode = 1;
        progress.error = err?.message || String(err);
        progress.status = "failed";
    } finally {
        unsubscribe();
        signal?.removeEventListener("abort", abortSession);
        session.dispose();
    }

    // Handle abort signal
    if (signal?.aborted) {
        result.exitCode = 1;
        progress.status = "failed";
        progress.error = "Aborted";
    }

    // Determine final status
    if (progress.status !== "failed") {
        progress.status = result.exitCode === 0 && !progress.error ? "completed" : "failed";
    }
    progress.durationMs = Date.now() - startTime;

    // Truncate output if very large
    if (result.output.length > DEFAULT_MAX_BYTES) {
        const trunc = truncateTail(result.output, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
        });
        result.output = trunc.content;
        if (trunc.truncated) {
            result.output = "[Output truncated \u2014 beginning omitted]\n\n" + result.output;
        }
    }

    return result;
}

// Retry budget: 3 attempts on the selected model, then 2 on the fallback.
const SELECTED_ATTEMPTS = 3;
const FALLBACK_ATTEMPTS = 2;

export async function runSubagent(
    agent: AgentConfig,
    task: string,
    cwd: string,
    signal: AbortSignal | undefined,
    onUpdate?: (progress: AgentProgress) => void,
    ctx?: any,
): Promise<AgentResult> {
    const agentDir = getAgentDir();

    // Unknown models fail closed (not retried): the name is wrong, not the call.
    let selectedModel = undefined;
    if (agent.model) {
        selectedModel = await resolveAgentModel(agent.model, ctx?.modelRegistry);
        if (!selectedModel) {
            throw new Error(
                `Unknown agent model '${agent.model}' for agent '${agent.name}'. Pick an installed model via /subagents:settings.`,
            );
        }
    }

    // Fallback is the main session model: its credentials demonstrably work.
    const phases: Array<{ model: Model<any> | undefined; attempts: number }> = [
        { model: selectedModel, attempts: SELECTED_ATTEMPTS },
    ];
    if (ctx?.model) phases.push({ model: ctx.model, attempts: FALLBACK_ATTEMPTS });

    let lastResult: AgentResult | undefined;
    for (const phase of phases) {
        for (let i = 0; i < phase.attempts; i++) {
            const r = await runAttempt(agent, task, cwd, agentDir, phase.model, signal, onUpdate);
            if (r.exitCode === 0 && !r.progress.error) return r;
            if (signal?.aborted) return r;
            lastResult = r;
        }
    }
    return lastResult!;
}

// ── Execution modes ─────────────────────────────────────────────────────
/** Fill `{previous}` with the prior step's output, treating it as literal text. */
function fillPrevious(task: string, previous: string): string {
    return task.replace(/\{previous\}/g, () => previous);
}

/** Look up one agent, throwing a shared error that lists what is available. */
function requireAgent(agentConfigs: readonly AgentConfig[], name: string): AgentConfig {
    const agent = agentConfigs.find((a) => a.name === name);
    if (!agent) {
        const available = agentConfigs.map((a) => a.name).join(", ") || "none";
        throw new Error(`Unknown agent: ${name}. Available agents: ${available}`);
    }
    return agent;
}

function emptyResult(
    agent: string,
    task: string,
    model: string | undefined,
    status: "pending" | "running",
    title?: string,
): AgentResult {
    return {
        agent,
        task,
        title,
        output: "",
        exitCode: -1,
        model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        progress: {
            agent,
            task,
            status,
            recentTools: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
            lastMessage: "",
        },
    };
}

/** Shaped tool output shared by every execution mode. */
interface SubagentToolOutput {
    content: { type: "text"; text: string }[];
    details: Details;
    isError?: boolean;
}

/** Report which agents the caller asked for, for the project-agent trust prompt. */
function requestedAgentNames(params: any): Set<string> {
    const names = new Set<string>();
    if (params.agent) names.add(params.agent);
    for (const t of params.tasks ?? []) names.add(t.agent);
    for (const s of params.chain ?? []) names.add(s.agent);
    for (const phase of params.hybrid ?? []) {
        if (phase.mode === "single") names.add(phase.agent);
        else for (const t of phase.tasks) names.add(t.agent);
    }
    return names;
}

export async function executeSingle(
    agentName: string,
    task: string,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx: any,
    onUpdate: any,
    agentScope: AgentScope = "user",
    agents?: AgentConfig[],
    title?: string,
): Promise<SubagentToolOutput> {
    const agentConfigs = agents ?? discoverAgents(cwd, agentScope).agents;
    const agent = requireAgent(agentConfigs, agentName);

    const liveResult = emptyResult(agentName, task, agent.model, "running", title);
    const result = await runSubagent(
        agent,
        task,
        cwd,
        signal,
        (progress) => {
            liveResult.progress = progress;
            onUpdate?.({
                content: [{ type: "text", text: "(running...)" }],
                details: { mode: "single" as const, results: [liveResult], agentScope },
            });
        },
        ctx,
    );
    if (title !== undefined) result.title = title;

    // Compute post-hoc file diffs for worker subagent results
    if (agent.name === "worker" && result.output) {
        const diffs = await computeWorkerDiffs(result.output, cwd, ctx);
        if (diffs) {
            result.output += diffs;
        }
    }

    const isError = result.exitCode !== 0 || !!result.progress.error;
    const errorMsg = result.progress.error
        ? `[Subagent error: ${result.progress.error}]`
        : "(no output)";
    return {
        content: [{ type: "text", text: result.output || errorMsg }],
        details: { mode: "single" as const, results: [result], agentScope },
        ...(isError ? { isError: true } : {}),
    };
}

export async function executeParallel(
    taskList: TaskSpec[],
    maxConcurrency: number,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx: any,
    onUpdate: any,
    agentScope: AgentScope = "user",
    agents?: AgentConfig[],
): Promise<SubagentToolOutput> {
    const agentConfigs = agents ?? discoverAgents(cwd, agentScope).agents;
    for (const t of taskList) {
        requireAgent(agentConfigs, t.agent);
    }

    const allResults: AgentResult[] = [];

    // Initialize all result slots as pending
    for (let i = 0; i < taskList.length; i++) {
        allResults[i] = emptyResult(
            taskList[i].agent,
            taskList[i].task,
            undefined,
            "pending",
            taskList[i].title,
        );
    }

    const flushParallelUpdate = () => {
        onUpdate?.({
            content: [{ type: "text", text: `Running ${taskList.length} tasks...` }],
            details: {
                mode: "parallel" as const,
                results: [...allResults],
                agentScope,
            },
        });
    };
    const fireParallelUpdate = throttle(flushParallelUpdate, 150);

    const results = await mapConcurrent(taskList, maxConcurrency, async (t, idx) => {
        const agent = agentConfigs.find((a) => a.name === t.agent)!;
        const result = await runSubagent(
            agent,
            t.task,
            t.cwd ?? cwd,
            signal,
            (progress) => {
                allResults[idx].progress = progress;
                fireParallelUpdate();
            },
            ctx,
        );
        if (t.title !== undefined) result.title = t.title;

        // Compute post-hoc file diffs for worker subagent results
        if (agent.name === "worker" && result.output) {
            const diffs = await computeWorkerDiffs(result.output, t.cwd ?? cwd, ctx);
            if (diffs) {
                result.output += diffs;
            }
        }

        // Update allResults with the completed result so the UI reflects it immediately
        allResults[idx] = result;
        flushParallelUpdate();

        return result;
    });

    // Build final output text
    const outputParts = results.map((r) => {
        const header = `## ${r.agent}${r.exitCode !== 0 ? " (FAILED)" : ""}`;
        return `${header}\n\n${r.output || "(no output)"}`;
    });

    return {
        content: [{ type: "text", text: outputParts.join("\n\n---\n\n") }],
        details: { mode: "parallel" as const, results, agentScope },
    };
}

/**
 * Execute a chain of subagent steps sequentially.
 * Each step can reference the previous step's output via `{previous}` placeholder.
 * Stops on first failure and returns `isError: true`.
 */
export async function executeChain(
    chainSteps: TaskSpec[],
    _maxConcurrency: number,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx: any,
    onUpdate: any,
    agentScope: AgentScope = "user",
    agents?: AgentConfig[],
): Promise<SubagentToolOutput> {
    const agentConfigs = agents ?? discoverAgents(cwd, agentScope).agents;
    const allResults: AgentResult[] = [];
    let previousOutput = "";

    for (let i = 0; i < chainSteps.length; i++) {
        const step = chainSteps[i];
        const agent = requireAgent(agentConfigs, step.agent);

        const taskWithContext = fillPrevious(step.task, previousOutput);

        // Create an update callback that shows chain progress with step number
        const emitChainUpdate = (progress: any) => {
            const liveResult: AgentResult = {
                ...emptyResult(step.agent, taskWithContext, agent.model, "running", step.title),
                step: i + 1,
            };
            liveResult.progress = progress;
            onUpdate?.({
                content: [
                    {
                        type: "text",
                        text: `Chain step ${i + 1}/${chainSteps.length}: ${step.agent}...`,
                    },
                ],
                details: {
                    mode: "chain" as const,
                    results: [...allResults, liveResult],
                    agentScope,
                },
            });
        };

        const result = await runSubagent(
            agent,
            taskWithContext,
            step.cwd ?? cwd,
            signal,
            emitChainUpdate,
            ctx,
        );
        result.step = i + 1;
        if (step.title !== undefined) result.title = step.title;
        allResults.push(result);

        // Stop on failure
        if (result.exitCode !== 0 || !!result.progress.error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Chain stopped at step ${i + 1} (${step.agent}): ${result.output || result.progress.error || "(no output)"}`,
                    },
                ],
                details: { mode: "chain" as const, results: allResults, agentScope },
                isError: true,
            };
        }

        previousOutput = result.output || previousOutput;
    }

    const last = allResults[allResults.length - 1];
    return {
        content: [{ type: "text", text: last?.output || "(no output)" }],
        details: { mode: "chain" as const, results: allResults, agentScope },
    };
}

/**
 * Merge parallel phase outputs into a structured string for {previous} context.
 * Each agent's output gets a heading; failed agents are marked.
 */
function mergeParallelOutputs(results: AgentResult[]): string {
    return results
        .map((r) => {
            const failMark = r.exitCode !== 0 ? " (FAILED)" : "";
            return `## ${r.agent}${failMark}

${r.output || "(no output)"}`;
        })
        .join("\n\n---\n\n");
}

/**
 * Execute a hybrid sequence of phases — an ordered mix of single, parallel, and chain modes.
 * Phases execute sequentially; each phase's output feeds the next via {previous} placeholder.
 * Parallel phase outputs are merged into a structured string; chain/single pass raw output.
 * Partial failures in parallel phases are tolerated; chain failures stop the hybrid.
 */
export async function executeHybrid(
    phases: HybridPhase[],
    maxConcurrency: number,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx: any,
    onUpdate: any,
    agentScope: AgentScope = "user",
    agents?: AgentConfig[],
): Promise<SubagentToolOutput> {
    const allResults: AgentResult[] = [];
    let previousOutput = "";
    const totalPhases = phases.length;

    const fireHybridUpdate = (phaseIdx: number, phaseLabel: string, results: AgentResult[]) => {
        onUpdate?.({
            content: [
                {
                    type: "text",
                    text: `Hybrid phase ${phaseIdx + 1}/${totalPhases}: ${phaseLabel}...`,
                },
            ],
            details: {
                mode: "hybrid" as const,
                results: [...allResults, ...results],
                agentScope,
            },
        });
    };

    for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];

        if (phase.mode === "single") {
            const task = fillPrevious(phase.task, previousOutput);
            fireHybridUpdate(i, `single: ${phase.agent}`, []);

            const result = await executeSingle(
                phase.agent,
                task,
                phase.cwd ?? cwd,
                signal,
                ctx,
                (upd: any) => {
                    // Re-broadcast phase updates with hybrid context
                    if (upd?.details?.results) {
                        fireHybridUpdate(i, `single: ${phase.agent}`, upd.details.results);
                    }
                },
                agentScope,
                agents,
                phase.title,
            );

            const phaseResult = result.details.results[0];
            allResults.push(phaseResult);
            previousOutput = phaseResult.output || previousOutput;

            if (result.isError) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Hybrid stopped at phase ${i + 1} (single: ${phase.agent}): ${phaseResult.output || phaseResult.progress.error || "(no output)"}`,
                        },
                    ],
                    details: { mode: "hybrid" as const, results: allResults, agentScope },
                    isError: true,
                };
            }
        } else if (phase.mode === "parallel") {
            const tasksWithContext = phase.tasks.map((t) => ({
                agent: t.agent,
                task: fillPrevious(t.task, previousOutput),
                cwd: t.cwd,
                title: t.title,
            }));

            fireHybridUpdate(i, `parallel (${tasksWithContext.length} tasks)`, []);

            const result = await executeParallel(
                tasksWithContext,
                maxConcurrency,
                cwd,
                signal,
                ctx,
                (upd: any) => {
                    if (upd?.details?.results) {
                        fireHybridUpdate(
                            i,
                            `parallel (${tasksWithContext.length} tasks)`,
                            upd.details.results,
                        );
                    }
                },
                agentScope,
                agents,
            );

            for (const r of result.details.results) {
                allResults.push(r);
            }

            // Merge all parallel outputs for context passing
            previousOutput = mergeParallelOutputs(result.details.results);

            // Check collect mode: "first" means we already got one result, so proceed
            // For "all", check if all failed
            const collect = phase.collect ?? "all";
            const completedOk = result.details.results.filter((r) => r.exitCode === 0).length;

            if (collect === "first" && completedOk === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Hybrid stopped at phase ${i + 1} (parallel): all tasks failed with collect:"first"`,
                        },
                    ],
                    details: { mode: "hybrid" as const, results: allResults, agentScope },
                    isError: true,
                };
            }
            // "all" mode tolerates partial failures — other tasks' partial output still flows
        } else if (phase.mode === "chain") {
            const stepsWithContext = phase.tasks.map((s) => ({
                agent: s.agent,
                task: fillPrevious(s.task, previousOutput),
                cwd: s.cwd,
                title: s.title,
            }));

            fireHybridUpdate(i, `chain (${stepsWithContext.length} steps)`, []);

            const result = await executeChain(
                stepsWithContext,
                maxConcurrency,
                cwd,
                signal,
                ctx,
                (upd: any) => {
                    if (upd?.details?.results) {
                        fireHybridUpdate(
                            i,
                            `chain (${stepsWithContext.length} steps)`,
                            upd.details.results,
                        );
                    }
                },
                agentScope,
                agents,
            );

            for (const r of result.details.results) {
                allResults.push(r);
            }

            const lastResult = result.details.results[result.details.results.length - 1];
            previousOutput = lastResult?.output || previousOutput;

            if (result.isError) {
                return {
                    content: result.content,
                    details: { mode: "hybrid" as const, results: allResults, agentScope },
                    isError: true,
                };
            }
        }
    }

    // Return the last phase's output as final content
    const last = allResults[allResults.length - 1];
    return {
        content: [{ type: "text", text: last?.output || "(no output)" }],
        details: { mode: "hybrid" as const, results: allResults, agentScope },
    };
}

// ── Dispatcher ──────────────────────────────────────────────────────────
/** Built-in thinking default per agent. Unlisted agents inherit the model default. */
export function defaultThinkingForAgent(name: string): ThinkingLevel | undefined {
    if (name === "worker") return "high";
    if (name === "scout") return "low";
    return undefined;
}

interface ActiveModel {
    provider: string;
    id: string;
}

/** The session model seeds the config; the tool context is untyped at this boundary. */
function activeModelOf(ctx: any): ActiveModel | undefined {
    const model = ctx?.model;
    return typeof model?.provider === "string" && typeof model?.id === "string"
        ? { provider: model.provider, id: model.id }
        : undefined;
}

/** Point every discovered agent at the active session model when the config file is absent. */
function seedSettings(
    settings: SettingsManager,
    agents: AgentConfig[],
    activeModel: ActiveModel | undefined,
): void {
    if (!activeModel) return;
    const agentModels: Record<string, string> = {};
    const agentThinking: Record<string, ThinkingLevel> = {};
    for (const a of agents) {
        agentModels[a.name] = `${activeModel.provider}/${activeModel.id}`;
        const thinking = defaultThinkingForAgent(a.name);
        if (thinking) agentThinking[a.name] = thinking;
    }
    settings.ensureSeeded({
        maxConcurrent: DEFAULT_MAX_CONCURRENCY,
        agentModels,
        agentThinking,
    });
}

export function buildSubagentExecute(settings: SettingsManager) {
    return async (
        _toolCallId: string,
        params: any,
        signal: AbortSignal | undefined,
        onUpdate: any,
        ctx: any,
    ) => {
        const cwd = ctx.cwd;
        const agentScope: AgentScope = params.agentScope ?? "user";
        const confirmProjectAgents = params.confirmProjectAgents ?? true;

        // Discover agents once, share across confirmation + dispatch
        let { agents } = discoverAgents(ctx.cwd, agentScope);

        // Merge dynamically registered agents (from cross-extension API)
        // Dynamic registrations intentionally override file-based agents
        const dynamicAgents = getAgents();
        if (dynamicAgents.length > 0) {
            const agentMap = new Map<string, any>();
            for (const a of agents) agentMap.set(a.name, a);
            for (const a of dynamicAgents) agentMap.set(a.name, a);
            agents = Array.from(agentMap.values());
        }

        // Apply per-agent model and thinking overrides; settings load lazily on first access.
        seedSettings(settings, agents, activeModelOf(ctx));
        const overrides = settings.getAllAgentModels();
        const agentThinking = settings.getAllAgentThinking();
        agents = agents.map((a) => ({
            ...a,
            model: overrides[a.name] ?? a.model,
            thinkingLevel:
                agentThinking[a.name] ?? defaultThinkingForAgent(a.name) ?? a.thinkingLevel,
        }));

        // Confirm project agents if needed
        if (
            (agentScope === "project" || agentScope === "both") &&
            confirmProjectAgents &&
            ctx.hasUI
        ) {
            const projectAgentsRequested = [...requestedAgentNames(params)]
                .map((name) => agents.find((a) => a.name === name))
                .filter((a) => a?.source === "project")
                .filter((a): a is AgentConfig => a !== undefined);

            if (projectAgentsRequested.length > 0) {
                const names = projectAgentsRequested.map((a) => a.name).join(", ");
                const ok = await ctx.ui.confirm(
                    "Run project-local agents?",
                    `Agents: ${names}\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
                );
                if (!ok) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: "Canceled: project-local agents not approved.",
                            },
                        ],
                        details: { mode: "single" as const, results: [], agentScope },
                    };
                }
            }
        }

        // Dispatch: hybrid, chain, parallel, single.
        // Read concurrency live: the wizard can change it after registration.
        const effectiveConcurrency = settings.maxConcurrent;
        if (params.hybrid && params.hybrid.length > 0) {
            return executeHybrid(
                params.hybrid,
                effectiveConcurrency,
                cwd,
                signal,
                ctx,
                onUpdate,
                agentScope,
                agents,
            );
        } else if (params.chain && params.chain.length > 0) {
            return executeChain(
                params.chain,
                effectiveConcurrency,
                cwd,
                signal,
                ctx,
                onUpdate,
                agentScope,
                agents,
            );
        } else if (params.tasks && params.tasks.length > 0) {
            return executeParallel(
                params.tasks,
                effectiveConcurrency,
                cwd,
                signal,
                ctx,
                onUpdate,
                agentScope,
                agents,
            );
        } else if (params.agent && params.task) {
            return executeSingle(
                params.agent,
                params.task,
                params.cwd ?? cwd,
                signal,
                ctx,
                onUpdate,
                agentScope,
                agents,
                params.title,
            );
        } else {
            const available = agents.map((a) => a.name).join(", ") || "none";
            throw new Error(
                `Provide hybrid[], chain[], agent+task (single), or tasks[] (parallel). Available agents: ${available}`,
            );
        }
    };
}
