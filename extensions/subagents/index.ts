
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import { DEFAULT_MAX_CONCURRENCY, loadAgents, loadEnv } from "./src/config.js";
import { executeParallel, executeSingle } from "./src/execute.js";
import { getAgents, setAgents } from "./src/registry.js";
import type { Details } from "./src/types.js";
import { formatDuration, formatTokens, truncLine } from "./src/utils.js";
import { getTermWidth, renderAgentProgress } from "./src/ui.js";

export default function (pi: ExtensionAPI) {
	loadEnv();
	const maxConcurrency = parseInt(process.env.SUBAGENTS_MAX_CONCURRENCY ?? "") || DEFAULT_MAX_CONCURRENCY;
	setAgents(loadAgents());

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
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx.cwd;

			if (params.tasks && params.tasks.length > 0) {
				return executeParallel(params.tasks, maxConcurrency, cwd, signal, ctx, onUpdate);
			} else if (params.agent && params.task) {
				return executeSingle(params.agent, params.task, params.cwd ?? cwd, signal, ctx, onUpdate);
			} else {
				throw new Error("Provide either (agent + task) for single mode, or tasks[] for parallel mode.");
			}
		},

		// ── Render: tool call header ──
		renderCall(args, theme, _context) {
			if (args.tasks && args.tasks.length > 0) {
				const agentNames = args.tasks.map((t: any) => t.agent).join(", ");
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks: ${agentNames})`)}`,
					0, 0,
				);
			}
			if (args.agent) {
				const taskPreview = args.task
					? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task).replace(/\n/g, " ")
					: "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}`,
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

			if (details.mode === "parallel") {
				// Parallel summary header
				const ok = details.results.filter((r) => r.exitCode === 0).length;
				const running = details.results.filter((r) => r.progress?.status === "running").length;
				const totalIcon = running > 0
					? theme.fg("warning", "⟳")
					: ok === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

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
