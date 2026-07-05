import type { AgentConfig, AgentResult, Details, AgentScope, HybridPhase } from "./types.js";
import { runSubagent } from "./process.js";
import { computeWorkerDiffs } from "./diff.js";
import { mapConcurrent, throttle } from "./utils.js";
import { discoverAgents } from "./config.js";

function emptyResult(
    agent: string,
    task: string,
    model?: string,
    status: "pending" | "running" = "running",
): AgentResult {
    return {
        agent,
        task,
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

export async function executeSingle(
    agentName: string,
    task: string,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx: any,
    onUpdate: any,
    agentScope: AgentScope = "user",
    agents?: AgentConfig[],
): Promise<{ content: any[]; details: Details; isError?: boolean }> {
    const agentConfigs = agents ?? discoverAgents(cwd, agentScope).agents;
    const agent = agentConfigs.find((a) => a.name === agentName);
    if (!agent) {
        const available = agentConfigs.map((a) => a.name).join(", ") || "none";
        throw new Error(`Unknown agent: ${agentName}. Available agents: ${available}`);
    }

    const liveResult = emptyResult(agentName, task, agent.model, "running");
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

    // Compute post-hoc file diffs for worker subagent results
    if (agent.name === "worker" && result.output) {
        const diffs = await computeWorkerDiffs(result.output, cwd, ctx);
        if (diffs) {
            result.output += diffs;
        }
    }

    const isError = result.exitCode !== 0 || !!result.progress.error;
    return {
        content: [{ type: "text", text: result.output || "(no output)" }],
        details: { mode: "single" as const, results: [result], agentScope },
        ...(isError ? { isError: true } : {}),
    };
}

export async function executeParallel(
    taskList: Array<{ agent: string; task: string; cwd?: string }>,
    maxConcurrency: number,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx: any,
    onUpdate: any,
    agentScope: AgentScope = "user",
    agents?: AgentConfig[],
): Promise<{ content: any[]; details: Details }> {
    const agentConfigs = agents ?? discoverAgents(cwd, agentScope).agents;
    // Validate all agents
    const available = agentConfigs.map((a) => a.name).join(", ") || "none";
    for (const t of taskList) {
        if (!agentConfigs.find((a) => a.name === t.agent)) {
            throw new Error(`Unknown agent: ${t.agent}. Available agents: ${available}`);
        }
    }

    const allResults: AgentResult[] = [];

    // Initialize all result slots as pending
    for (let i = 0; i < taskList.length; i++) {
        allResults[i] = emptyResult(taskList[i].agent, taskList[i].task, undefined, "pending");
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
    chainSteps: Array<{ agent: string; task: string; cwd?: string }>,
    _maxConcurrency: number,
    cwd: string,
    signal: AbortSignal | undefined,
    ctx: any,
    onUpdate: any,
    agentScope: AgentScope = "user",
    agents?: AgentConfig[],
): Promise<{ content: any[]; details: Details; isError?: boolean }> {
    const agentConfigs = agents ?? discoverAgents(cwd, agentScope).agents;
    const allResults: AgentResult[] = [];
    let previousOutput = "";

    for (let i = 0; i < chainSteps.length; i++) {
        const step = chainSteps[i];
        const agent = agentConfigs.find((a) => a.name === step.agent);
        if (!agent) {
            const available = agentConfigs.map((a) => a.name).join(", ") || "none";
            throw new Error(`Unknown agent: ${step.agent}. Available agents: ${available}`);
        }

        const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

        // Create an update callback that shows chain progress with step number
        const emitChainUpdate = (progress: any) => {
            const liveResult: AgentResult = {
                ...emptyResult(step.agent, taskWithContext, agent.model, "running"),
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
): Promise<{ content: any[]; details: Details; isError?: boolean }> {
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

        // Resolve {previous} in task strings
        const resolvePrevious = (task: string) => task.replace(/\{previous\}/g, previousOutput);

        if (phase.mode === "single") {
            const task = resolvePrevious(phase.task);
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
                task: resolvePrevious(t.task),
                cwd: t.cwd,
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
                task: resolvePrevious(s.task),
                cwd: s.cwd,
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
