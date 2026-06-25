import type { AgentResult, Details } from "./types.js";
import { runSubagent } from "./process.js";
import { computeWorkerDiffs } from "./diff.js";
import { mapConcurrent, throttle } from "./utils.js";
import { getAgents } from "./registry.js";

function emptyResult(agent: string, task: string, model?: string, status: "pending" | "running" = "running"): AgentResult {
	return {
		agent,
		task,
		output: "",
		exitCode: -1,
		model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			agent, task, status,
			recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "",
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
): Promise<{ content: any[]; details: Details; isError?: boolean }> {
	const agents = getAgents();
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => a.name).join(", ") || "none";
		throw new Error(`Unknown agent: ${agentName}. Available agents: ${available}`);
	}

	const liveResult = emptyResult(agentName, task, agent.model, "running");
	const result = await runSubagent(agent, task, cwd, signal, (progress) => {
		liveResult.progress = progress;
		onUpdate?.({
			content: [{ type: "text", text: "(running...)" }],
			details: { mode: "single" as const, results: [liveResult] },
		});
	}, ctx);

	// Compute post-hoc file diffs for worker subagent results
	if (agent.name === "worker" && result.output) {
		const diffs = computeWorkerDiffs(result.output, cwd, ctx);
		if (diffs) {
			result.output += diffs;
		}
	}

	const isError = result.exitCode !== 0 || !!result.progress.error;
	return {
		content: [{ type: "text", text: result.output || "(no output)" }],
		details: { mode: "single" as const, results: [result] },
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
): Promise<{ content: any[]; details: Details }> {
	const agents = getAgents();
	// Validate all agents
	const available = agents.map((a) => a.name).join(", ") || "none";
	for (const t of taskList) {
		if (!agents.find((a) => a.name === t.agent)) {
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
			},
		});
	};
	const fireParallelUpdate = throttle(flushParallelUpdate, 150);

	const results = await mapConcurrent(taskList, maxConcurrency, async (t, idx) => {
		const agent = agents.find((a) => a.name === t.agent)!;
		const result = await runSubagent(agent, t.task, t.cwd ?? cwd, signal, (progress) => {
			allResults[idx].progress = progress;
			fireParallelUpdate();
		}, ctx);

		// Compute post-hoc file diffs for worker subagent results
		if (agent.name === "worker" && result.output) {
			const diffs = computeWorkerDiffs(result.output, t.cwd ?? cwd, ctx);
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
		details: { mode: "parallel" as const, results },
	};
}
