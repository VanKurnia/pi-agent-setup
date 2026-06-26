import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { DEFAULT_MAX_CONCURRENCY, discoverAgents, loadEnv } from "./src/config.js";
import { refreshAgents } from "./src/registry.js";
import { buildSubagentExecute } from "./dispatch.js";
import { renderSubagentToolCall, renderSubagentToolResult } from "./render.js";

export const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (SINGLE mode)" }),
	),
	task: Type.Optional(Type.String({ description: "Task description (SINGLE mode)" })),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Name of the agent to invoke" }),
				task: Type.String({ description: "Task description" }),
				cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
			}),
			{ description: "PARALLEL mode: array of {agent, task} objects" },
		),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, { description: "CHAIN mode: sequential {agent, task} steps with {previous} placeholder support" }),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function registerSubagent(pi: ExtensionAPI) {
	loadEnv();
	const maxConcurrency = parseInt(process.env.SUBAGENTS_MAX_CONCURRENCY ?? "") || DEFAULT_MAX_CONCURRENCY;

	pi.registerCommand("reload-agents", {
		description: "Re-discover agent files from ~/.pi/agent/agents/",
		handler: async (_args: string, ctx: any) => {
			const configs = discoverAgents(ctx.cwd, "user").agents;
			refreshAgents(configs);
			ctx.ui?.notify?.(`Reloaded ${configs.length} agents`, "info");
		},
	});

	const execute = buildSubagentExecute(maxConcurrency);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a subagent to complete a task. Subagents have NO context from the current conversation — include all necessary context in the task description.",
		promptSnippet: "Run subagents for delegated tasks",
		promptGuidelines: [
			"Parallel tool calls are your primary parallelism mechanism — put multiple independent read/fetch/search calls in one function_calls block. Don't use subagents to parallelize simple I/O.",
			"Use subagent to delegate *reasoning and decisions*: codebase exploration (scout), web research (researcher), or isolated code changes (worker)",
			"For multiple independent subagent tasks, use parallel mode with tasks[] array",
			"Subagents have NO context from the current conversation — include ALL necessary context in the task description",
		],
		parameters: SubagentParams,
		execute,
		renderCall: renderSubagentToolCall,
		renderResult: renderSubagentToolResult,
	});
}