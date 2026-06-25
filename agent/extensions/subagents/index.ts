import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { DEFAULT_MAX_CONCURRENCY, discoverAgents, loadAgents, loadEnv } from "./src/config.js";
import { executeChain, executeParallel, executeSingle } from "./src/execute.js";
import { getAgents, refreshAgents, setAgents } from "./src/registry.js";
import type { AgentScope, Details } from "./src/types.js";
import { formatDuration, formatTokens, truncLine } from "./src/utils.js";
import { getTermWidth, renderAgentProgress } from "./src/ui.js";

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export default function (pi: ExtensionAPI) {
	loadEnv();
	const maxConcurrency = parseInt(process.env.SUBAGENTS_MAX_CONCURRENCY ?? "") || DEFAULT_MAX_CONCURRENCY;
	setAgents(loadAgents());

	// Command to reload agents without restarting pi
	pi.registerCommand("reload-agents", {
		description: "Re-discover agent files from ~/.pi/agent/agents/",
		handler: async (_args: string, ctx: any) => {
			const configs = discoverAgents(ctx.cwd, "user").agents;
			refreshAgents(configs);
			ctx.ui?.notify?.(`Reloaded ${configs.length} agents`, "info");
		},
	});

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
		parameters: Type.Object({
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
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx.cwd;
			const agentScope: AgentScope = params.agentScope ?? "user";
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			// Confirm project agents if needed
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const s of params.chain) requestedAgentNames.add(s.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				if (requestedAgentNames.size > 0) {
					const { agents } = discoverAgents(ctx.cwd, agentScope);
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
				return executeChain(params.chain, maxConcurrency, cwd, signal, ctx, onUpdate, agentScope);
			} else if (params.tasks && params.tasks.length > 0) {
				return executeParallel(params.tasks, maxConcurrency, cwd, signal, ctx, onUpdate, agentScope);
			} else if (params.agent && params.task) {
				return executeSingle(params.agent, params.task, params.cwd ?? cwd, signal, ctx, onUpdate, agentScope);
			} else {
				const { agents } = discoverAgents(cwd, "user");
				const available = agents.map((a) => a.name).join(", ") || "none";
				throw new Error(`Provide chain[], agent+task (single), or tasks[] (parallel). Available agents: ${available}`);
			}
		},

		// ── Render: tool call header ──
		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const scopeText = scope !== "user" ? theme.fg("warning", ` [${scope}]`) : "";

			if (args.chain && args.chain.length > 0) {
				const agentNames = args.chain.map((s: any) => s.agent).join(" → ");
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "chain")} ${theme.fg("dim", `(${args.chain.length} steps: ${agentNames})`)}${scopeText}`,
					0, 0,
				);
			}
			if (args.tasks && args.tasks.length > 0) {
				const agentNames = args.tasks.map((t: any) => t.agent).join(", ");
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks: ${agentNames})`)}${scopeText}`,
					0, 0,
				);
			}
			if (args.agent) {
				const taskPreview = args.task
					? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task).replace(/\n/g, " ")
					: "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}${scopeText}`,
					0, 0,
				);
			}
			return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
		},

		// ── Render: result ──
		renderResult(result, options, theme, context) {
			const details = result.details as Details | undefined;
			if (!details?.results?.length) {
				const t = result.content[0];
				const text = t?.type === "text" ? t.text : "(no output)";
				return new Text(text.slice(0, 200), 0, 0);
			}

			const w = getTermWidth() - 4;
			const expanded = options.expanded;
			const c = new Container();

			if (details.mode === "chain") {
				// Chain summary header
				const ok = details.results.filter((r) => r.exitCode === 0).length;
				const failed = details.results.filter((r) => r.exitCode !== 0).length;
				const totalIcon = failed === 0
					? theme.fg("success", "")
					: theme.fg("error", "");

				c.addChild(
					new Text(
						truncLine(
							`${totalIcon} ${theme.fg("toolTitle", theme.bold("chain"))} ${ok}/${details.results.length} steps`,
							w,
						),
						0, 0,
					),
				);
				c.addChild(new Spacer(1));

				for (let i = 0; i < details.results.length; i++) {
					const r = details.results[i];
					// Step header
					const stepIcon = r.exitCode === 0
						? theme.fg("success", "")
						: r.progress?.status === "running"
							? theme.fg("warning", "󱦟")
							: theme.fg("error", "");
					c.addChild(
						new Text(
							truncLine(`${stepIcon} ${theme.fg("accent", `Step ${r.step ?? i + 1}: ${r.agent}`)}`, w),
							0, 0,
						),
					);
					c.addChild(renderAgentProgress(r, theme, expanded, w));
					if (i < details.results.length - 1) c.addChild(new Spacer(1));
				}
			} else if (details.mode === "parallel") {
				// Parallel summary header
				const ok = details.results.filter((r) => r.exitCode === 0).length;
				const running = details.results.filter((r) => r.progress?.status === "running").length;
				const totalIcon = running > 0
					? theme.fg("warning", "󱦟")
					: ok === details.results.length
						? theme.fg("success", "")
						: theme.fg("error", "");

				const totalDuration = Math.max(...details.results.map((r) => r.progress?.durationMs || 0));
				const totalTokens = details.results.reduce((s, r) => s + (r.progress?.tokens || 0), 0);
				c.addChild(
					new Text(
						truncLine(
							`${totalIcon} ${theme.fg("toolTitle", theme.bold("parallel"))} ${ok}/${details.results.length} completed · ${formatTokens(totalTokens)} tok · ${formatDuration(totalDuration)}`,
							w,
						),
						0, 0,
					),
				);
				c.addChild(new Spacer(1));

				for (let i = 0; i < details.results.length; i++) {
					const r = details.results[i];
					c.addChild(renderAgentProgress(r, theme, expanded, w));
					if (i < details.results.length - 1) c.addChild(new Spacer(1));
				}
			} else {
				// Single agent
				const r = details.results[0];
				c.addChild(renderAgentProgress(r, theme, expanded, w));
			}

			return c;
		},
	});
}
