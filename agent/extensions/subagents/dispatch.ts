import { discoverAgents } from "./src/config.js";
import { executeChain, executeParallel, executeSingle } from "./src/execute.js";
import type { AgentScope } from "./src/types.js";

export function buildSubagentExecute(maxConcurrency: number) {
	return async (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => {
		const cwd = ctx.cwd;
		const agentScope: AgentScope = params.agentScope ?? "user";
		const confirmProjectAgents = params.confirmProjectAgents ?? true;

		// Discover agents once, share across confirmation + dispatch
		const { agents } = discoverAgents(ctx.cwd, agentScope);

		// Confirm project agents if needed
		if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
			const requestedAgentNames = new Set<string>();
			if (params.chain) for (const s of params.chain) requestedAgentNames.add(s.agent);
			if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
			if (params.agent) requestedAgentNames.add(params.agent);

			if (requestedAgentNames.size > 0) {
				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is any => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a: any) => a.name).join(", ");
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: { mode: "single" as const, results: [], agentScope },
						};
					}
				}
			}
		}

		// Dispatch: chain, parallel, single
		if (params.chain && params.chain.length > 0) {
			return executeChain(params.chain, maxConcurrency, cwd, signal, ctx, onUpdate, agentScope, agents);
		} else if (params.tasks && params.tasks.length > 0) {
			return executeParallel(params.tasks, maxConcurrency, cwd, signal, ctx, onUpdate, agentScope, agents);
		} else if (params.agent && params.task) {
			return executeSingle(params.agent, params.task, params.cwd ?? cwd, signal, ctx, onUpdate, agentScope, agents);
		} else {
			const available = agents.map((a) => a.name).join(", ") || "none";
			throw new Error(`Provide chain[], agent+task (single), or tasks[] (parallel). Available agents: ${available}`);
		}
	};
}
