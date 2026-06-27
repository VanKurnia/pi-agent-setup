import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { DEFAULT_MAX_CONCURRENCY, discoverAgents, loadEnv } from "./src/config.js";
import { SettingsManager } from "./src/settings.js";
import { refreshAgents } from "./src/registry.js";
import { buildSubagentExecute } from "./dispatch.js";
import { renderSubagentToolCall, renderSubagentToolResult } from "./render.js";
import { SUBAGENT_EVENTS, type SubagentCreatedEvent, type SubagentCompletedEvent, type SubagentFailedEvent } from "./src/types.js";

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
	const settings = new SettingsManager();
	settings.load();
	const maxConcurrency = settings.maxConcurrent;

	pi.registerCommand("reload-agents", {
		description: "Re-discover agent files from ~/.pi/agent/agents/",
		handler: async (_args: string, ctx: any) => {
			const configs = discoverAgents(ctx.cwd, "user").agents;
			refreshAgents(configs);
			ctx.ui?.notify?.(`Reloaded ${configs.length} agents`, "info");
		},
	});

	pi.registerCommand("subagents:settings", {
		description: "Configure subagent settings (model per agent, max concurrency)",
		handler: async (_args: string, ctx: any) => {
			while (true) {
				const agents = discoverAgents(ctx.cwd, "user").agents;

				// Step 1: pick agent or concurrency — show current model info
				const agentOptions = [
					"[max concurrency]",
					...agents.map(a => {
						const m = settings.getAgentModel(a.name);
						return m ? `${a.name} — ${m}` : a.name;
					}),
				];
				const selectedAgent = await ctx.ui.select(
					"Select agent to configure (or pick max concurrency):",
					agentOptions
				);
				if (!selectedAgent) return;

				// Extract agent name (strip appended model info)
				const agentName = selectedAgent.startsWith("[") ? selectedAgent : selectedAgent.split(" — ")[0];

				if (agentName === "[max concurrency]") {
					const current = settings.maxConcurrent;
					const answer = await ctx.ui.input(
						`Current max concurrent agents: ${current}`,
						"Enter a value 1-1024, or leave empty"
					);
					if (answer) {
						const trimmed = answer.trim();
						const n = parseInt(trimmed, 10);
						if (!isNaN(n) && n >= 1 && n <= 1024) {
							const toast = settings.applyMaxConcurrent(n);
							ctx.ui.notify?.(toast.message, toast.level);
						} else {
							ctx.ui.notify?.("Must be 1-1024.", "warning");
						}
					}
					continue;
				}

				// Step 2: pick model via scrollable TUI modal
				const allModels = ctx.modelRegistry.getAvailable();
				const currentModel = settings.getAgentModel(agentName);

				const modelItems: SelectItem[] = [
					{ value: "__reset__", label: "[reset to default]", description: "Use agent file's default model" },
				];
				for (const m of allModels) {
					modelItems.push({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` });
				}

				const title = currentModel
					? `Model for "${agentName}" (current: ${currentModel})`
					: `Model for "${agentName}":`;

				const selectedValue = await (ctx.ui as any).custom(
					(tui: any, theme: any, _kb: any, done: any) => {
						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

						const list = new SelectList(modelItems, Math.min(14, modelItems.length), {
							selectedPrefix: (t: string) => theme.fg("accent", t),
							selectedText: (t: string) => theme.fg("accent", t),
							description: (t: string) => theme.fg("dim", t),
							scrollInfo: (t: string) => theme.fg("dim", t),
							noMatch: (t: string) => theme.fg("warning", t),
						});
						list.onSelect = (item) => done(item.value);
						list.onCancel = () => done(null);
						container.addChild(list);

						container.addChild(
							new Text(theme.fg("dim", "↑↓ navigate • enter select • esc close"), 1, 0)
						);
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						return {
							render: (w: number) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data: string) => {
								list.handleInput(data);
								tui.requestRender();
							},
						};
					},
					{ overlay: true }
				);
				if (!selectedValue) continue;

				if (selectedValue === "__reset__") {
					settings.setAgentModel(agentName, undefined);
				} else {
					settings.setAgentModel(agentName, selectedValue);
				}

				const saved = settings.save();
				const label = selectedValue === "__reset__" ? "default" : selectedValue;
				ctx.ui.notify?.(
					saved
						? `Model for "${agentName}" set to ${label}`
						: `Set to ${label} (session only; failed to persist)`,
					saved ? "info" : "warning"
				);
				// Loop back — user sees updated model info in agent list
			}
		},
	});

	const execute = buildSubagentExecute(maxConcurrency, settings);

	// Wire lifecycle events via pi.events
	const executeWithEvents = async (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => {
		const mode = params.chain ? "chain" : params.tasks ? "parallel" : "single";

		// Emit CREATED event for each agent in this invocation
		if (params.agent) {
			pi.events.emit(SUBAGENT_EVENTS.CREATED, {
				agentId: toolCallId,
				agentName: params.agent,
				task: params.task || "",
				mode,
				agentScope: params.agentScope ?? "user",
				timestamp: Date.now(),
			} satisfies SubagentCreatedEvent);
		} else if (params.tasks) {
			for (const t of params.tasks) {
				pi.events.emit(SUBAGENT_EVENTS.CREATED, {
					agentId: `${toolCallId}-${t.agent}`,
					agentName: t.agent,
					task: t.task || "",
					mode,
					agentScope: params.agentScope ?? "user",
					timestamp: Date.now(),
				} satisfies SubagentCreatedEvent);
			}
		} else if (params.chain) {
			for (const s of params.chain) {
				pi.events.emit(SUBAGENT_EVENTS.CREATED, {
					agentId: `${toolCallId}-${s.agent}`,
					agentName: s.agent,
					task: s.task || "",
					mode: "chain",
					agentScope: params.agentScope ?? "user",
					timestamp: Date.now(),
				} satisfies SubagentCreatedEvent);
			}
		}

		const result = await execute(toolCallId, params, signal, onUpdate, ctx);

		// Emit completed/failed events per result
		if (result?.details?.results) {
			for (const r of result.details.results) {
				if (r.exitCode === 0 && !r.progress?.error) {
					pi.events.emit(SUBAGENT_EVENTS.COMPLETED, {
						agentId: `${toolCallId}-${r.agent}`,
						agentName: r.agent,
						task: r.task,
						output: r.output || "",
						usage: r.usage || { input: 0, output: 0, turns: 0, cost: 0 },
						durationMs: r.progress?.durationMs || 0,
						timestamp: Date.now(),
					} satisfies SubagentCompletedEvent);
				} else {
					pi.events.emit(SUBAGENT_EVENTS.FAILED, {
						agentId: `${toolCallId}-${r.agent}`,
						agentName: r.agent,
						task: r.task,
						error: r.progress?.error || r.output || "Unknown error",
						durationMs: r.progress?.durationMs || 0,
						timestamp: Date.now(),
					} satisfies SubagentFailedEvent);
				}
			}
		}

		return result;
	};

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
		execute: executeWithEvents,
		renderCall: renderSubagentToolCall,
		renderResult: renderSubagentToolResult,
	});
}