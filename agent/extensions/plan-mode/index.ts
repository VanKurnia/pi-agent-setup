/**
 * Plan mode — enhanced read-only mode with bash allowlist, plan extraction,
 * and step tracking via [DONE:n] markers.
 *
 * Two modes:
 *   /read-only      -> legacy hard-enforced read-only (blocks all tools outside allowlist)
 *   /plan           -> enhanced plan mode (bash allowlist, plan extraction, step tracking)
 *
 * Usage:
 *   /read-only        -> toggle legacy read-only mode
 *   /read-only on     -> enable
 *   /read-only off    -> disable
 *   /read-only status -> show current state
 *   /plan             -> toggle plan mode
 *   /plan status      -> show plan mode state and todos
 *
 * Plan mode features:
 * - Bash allowlist: read-only commands (cat, grep, ls, etc.) allowed;
 *   destructive commands (rm, git commit, sudo, etc.) blocked
 * - Extracts numbered plan steps from "Plan:" sections in assistant messages
 * - [DONE:n] markers to track step completion
 * - Widget showing todo progress during execution
 * - Execution mode: after plan review, user can switch to execution (restores write tools)
 * - State persisted via pi.appendEntry()
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isSafeCommand,
	extractTodoItems,
	markCompletedSteps,
	type TodoItem,
} from "./utils.js";

const COMMAND_NAME = "read-only";
const PLAN_COMMAND_NAME = "plan";
const STATUS_KEY = "read-only-mode";
const WIDGET_KEY = "read-only-mode";
const PLAN_TODOS_WIDGET_KEY = "plan-todos";
const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/** Tools available in plan mode (read-only tools + bash with allowlist) */
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"] as const;

/** Tools disabled in plan mode */
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);

/** All tools managed by plan mode (used when restoring) */
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, "edit", "write"]);

export function getReadOnlyToolNames(pi: ExtensionAPI): string[] {
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	return READ_ONLY_TOOL_NAMES.filter((name) => allToolNames.has(name));
}

function updateUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	readOnlyEnabled: boolean,
	planModeEnabled: boolean,
	executionMode: boolean,
	todoItems: TodoItem[],
): void {
	// Legacy read-only status (backward compat)
	if (readOnlyEnabled && !planModeEnabled) {
		const tools = getReadOnlyToolNames(pi).join(", ");
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "🔒 read-only"));
		ctx.ui.setWidget(WIDGET_KEY, [ctx.ui.theme.fg("muted", `🔒 ${tools || "(none)"}`)]);
	} else if (planModeEnabled) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "⏸ plan"));
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	} else if (executionMode) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "▶ executing"));
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	} else {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	// Plan todos widget (shown in execution mode)
	if (executionMode && todoItems.length > 0) {
		const completed = todoItems.filter((t) => t.completed).length;
		const lines = todoItems.map((item) => {
			if (item.completed) {
				return (
					ctx.ui.theme.fg("success", "☑ ") +
					ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
				);
			}
			return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
		});
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		ctx.ui.setWidget(PLAN_TODOS_WIDGET_KEY, lines);
	} else if (planModeEnabled && todoItems.length > 0) {
		// Show plan steps without completion markers
		const lines = todoItems.map((item) => {
			return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
		});
		ctx.ui.setWidget(PLAN_TODOS_WIDGET_KEY, lines);
	} else {
		ctx.ui.setWidget(PLAN_TODOS_WIDGET_KEY, undefined);
	}
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

function getPlanModeTools(activeToolNames: string[]): string[] {
	return uniqueToolNames([
		...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
		...PLAN_MODE_TOOLS,
	]);
}

function getNormalModeTools(activeToolNames: string[]): string[] {
	return uniqueToolNames([
		"read", "bash", "edit", "write",
		...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
	]);
}

export function applyReadOnlyTools(pi: ExtensionAPI): void {
	pi.setActiveTools(getReadOnlyToolNames(pi));
}

export function restoreTools(pi: ExtensionAPI, toolsBeforeReadOnly?: string[]): void {
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const toolNames = (toolsBeforeReadOnly ?? pi.getAllTools().map((tool) => tool.name)).filter((toolName) =>
		allToolNames.has(toolName),
	);
	pi.setActiveTools(toolNames);
}

export default function readOnlyModeExtension(pi: ExtensionAPI) {
	// State
	let readOnlyEnabled = false;
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	// ── persistence ──

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			readOnlyEnabled,
			planModeEnabled,
			executionMode,
			todos: todoItems,
			toolsBeforePlanMode,
		});
	}

	// ── legacy read-only mode ──

	function enableReadOnlyMode(ctx: ExtensionContext): void {
		if (readOnlyEnabled) {
			updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
			ctx.ui.notify("Read-only mode is already enabled.", "info");
			return;
		}

		// Disable plan mode if active (they conflict)
		if (planModeEnabled) {
			planModeEnabled = false;
			executionMode = false;
			todoItems = [];
		}

		readOnlyEnabled = true;
		toolsBeforePlanMode = pi.getActiveTools();
		applyReadOnlyTools(pi);
		updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);

		const tools = getReadOnlyToolNames(pi).join(", ");
		ctx.ui.notify(`Read-only mode enabled. Tools: ${tools || "(none)"}.`, "info");
		persistState();
	}

	function disableReadOnlyMode(ctx: ExtensionContext): void {
		if (!readOnlyEnabled) {
			updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
			ctx.ui.notify("Read-only mode is already disabled.", "info");
			return;
		}

		readOnlyEnabled = false;
		restoreTools(pi, toolsBeforePlanMode);
		toolsBeforePlanMode = undefined;
		updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
		ctx.ui.notify("Read-only mode disabled. Previous tool access restored.", "info");
		persistState();
	}

	function toggleReadOnlyMode(ctx: ExtensionContext): void {
		if (readOnlyEnabled) disableReadOnlyMode(ctx);
		else enableReadOnlyMode(ctx);
	}

	// ── plan mode ──

	function enablePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) return;

		// Disable legacy read-only if active
		if (readOnlyEnabled) {
			readOnlyEnabled = false;
		}

		planModeEnabled = true;
		executionMode = false;

		toolsBeforePlanMode = pi.getActiveTools();
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
		updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
		ctx.ui.notify("Plan mode enabled. Write tools disabled; bash is restricted to read-only commands.");
		persistState();
	}

	function disablePlanMode(ctx: ExtensionContext): void {
		if (!planModeEnabled && !executionMode) return;

		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
		updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
		ctx.ui.notify("Plan mode disabled. Full access restored.");
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled || executionMode) {
			disablePlanMode(ctx);
		} else {
			enablePlanMode(ctx);
		}
	}

	// ── commands ──

	pi.registerCommand(COMMAND_NAME, {
		description: "Toggle hard-enforced read-only mode",
		getArgumentCompletions(prefix) {
			const actions = ["toggle", "on", "off", "status"];
			const items = actions
				.filter((action) => action.startsWith(prefix.toLowerCase()))
				.map((action) => ({ value: action, label: action }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			switch (action) {
				case "":
				case "toggle":
					toggleReadOnlyMode(ctx);
					return;
				case "on":
				case "enable":
					enableReadOnlyMode(ctx);
					return;
				case "off":
				case "disable":
					disableReadOnlyMode(ctx);
					return;
				case "status": {
					updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
					if (readOnlyEnabled) {
						const tools = getReadOnlyToolNames(pi).join(", ");
						ctx.ui.notify(
							`Read-only mode is ON. Allowed tools: ${tools || "(none)"}.`,
							"info",
						);
					} else {
						ctx.ui.notify("Read-only mode is OFF.", "info");
					}
					return;
				}
				default:
					ctx.ui.notify(`Usage: /${COMMAND_NAME} [on|off|toggle|status]`, "warning");
			}
		},
	});

	pi.registerCommand(PLAN_COMMAND_NAME, {
		description: "Toggle plan mode (read-only exploration with bash allowlist, plan extraction, and step tracking)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "status") {
				if (planModeEnabled) {
					const todoCount = todoItems.length;
					const completed = todoItems.filter((t) => t.completed).length;
					ctx.ui.notify(
						`Plan mode is ON. Todos: ${completed}/${todoCount}. Execution mode: ${executionMode ? "yes" : "no"}.`,
						"info",
					);
				} else {
					ctx.ui.notify("Plan mode is OFF.", "info");
				}
				return;
			}

			if (action === "off" || action === "disable") {
				disablePlanMode(ctx);
				return;
			}

			togglePlanMode(ctx);
		},
	});

	// ── before_agent_start: inject system prompt ──

	pi.on("before_agent_start", async (event, ctx) => {
		if (readOnlyEnabled && !planModeEnabled) {
			// Legacy read-only mode
			applyReadOnlyTools(pi);
			updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);

			const tools = getReadOnlyToolNames(pi).join(", ") || "(none)";
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\n[Read-only mode is active]\n` +
					`- You may only use these tools: ${tools}.\n` +
					`- You must not attempt any action that changes local files, processes, git state, dependencies, databases, remote systems, or any other external state.\n` +
					`- If the user asks for any write or side-effecting action, explain that read-only mode is enabled and tell them to run /${COMMAND_NAME} off first.`,
			};
		}

		if (planModeEnabled) {
			// Plan mode: inject planning instructions with bash allowlist
			pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode ?? pi.getActiveTools()));
			updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);

			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Bash is restricted to an allowlist of read-only commands (cat, grep, ls, find, git status/log/diff, etc.)
- Destructive commands (rm, mv, sudo, npm install, git commit, etc.) are blocked

Instructions:
- Ask clarifying questions using the questionnaire tool if needed
- Create a detailed numbered plan under a "Plan:" header when asked:

Plan:
1. First step description
2. Second step description
...

- Do NOT attempt to make changes - just describe what you would do
- The user can choose to execute the plan later`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			// Execution mode: full tool access, track progress
			pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
			updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);

			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response where n is the step number.`,
					display: false,
				},
			};
		}

		// Normal mode: clean up UI
		updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
	});

	// ── tool_call: block tools based on mode ──

	pi.on("tool_call", async (event) => {
		if (readOnlyEnabled && !planModeEnabled) {
			// Legacy read-only mode: block everything outside allowlist
			const allowedToolNames = new Set(getReadOnlyToolNames(pi));
			if (allowedToolNames.has(event.toolName)) return;

			return {
				block: true,
				reason:
					`Read-only mode is active. Tool "${event.toolName}" is blocked. ` +
					`Allowed tools: ${Array.from(allowedToolNames).join(", ") || "(none)"}. ` +
					`Use /${COMMAND_NAME} off to restore full tool access.`,
			};
		}

		if (planModeEnabled) {
			// Plan mode: block disabled tools and unsafe bash
			if (PLAN_MODE_DISABLED_TOOLS.has(event.toolName)) {
				return {
					block: true,
					reason:
						`Plan mode is active. Tool "${event.toolName}" is disabled in plan mode. ` +
						`Use /plan to disable plan mode.`,
				};
			}

			if (event.toolName === "bash") {
				const command = event.input?.command as string;
				if (!command || !isSafeCommand(command)) {
					return {
						block: true,
						reason:
							`Plan mode: bash command blocked (not allowlisted). ` +
							`Use /plan to disable plan mode first.\nCommand: ${command}`,
					};
				}
			}

			return;
		}

		// Execution mode or normal: allow everything
	});

	// ── filter stale plan-mode context from non-plan messages ──

	pi.on("context", async (event) => {
		if (planModeEnabled || executionMode) return;

		return {
			messages: event.messages.filter((m: any) => {
				if (m.customType === "plan-mode-context") return false;
				if (m.customType === "plan-execution-context") return false;
				if (m.role !== "user") return true;

				const content = m.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c: any) => c.type === "text" && c.text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// ── turn_end: track [DONE:n] markers ──

	pi.on("turn_end", async (_event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;

		// Use the event message to check for DONE markers
		const msg = _event.message;
		if (!msg || msg.role !== "assistant") return;

		const text = extractTextFromMessage(msg);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
		}
		persistState();
	});

	// ── agent_end: extract plan, prompt for execution ──

	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{
						customType: "plan-complete",
						content: `**Plan Complete!** ✓\n\n${completedList}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = findLastAssistantMessage(event.messages);
		if (lastAssistant) {
			const extracted = extractTodoItems(extractTextFromMessage(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		if (todoItems.length === 0) return;
		persistState();
		updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);

		// Show plan steps and prompt for next action
		const todoListText = todoItems.map((t) => `${t.step}. ☐ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (!firstTodoItem) return;

			planModeEnabled = false;
			executionMode = true;
			pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
			updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
			persistState();

			const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}
After completing a step, include a [DONE:n] tag in your response.`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// ── session_start: restore state ──

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { readOnlyEnabled?: boolean; planModeEnabled?: boolean; executionMode?: boolean; todos?: TodoItem[]; toolsBeforePlanMode?: string[] } } | undefined;

		if (planModeEntry?.data) {
			readOnlyEnabled = planModeEntry.data.readOnlyEnabled ?? false;
			planModeEnabled = planModeEntry.data.planModeEnabled ?? false;
			executionMode = planModeEntry.data.executionMode ?? false;
			todoItems = planModeEntry.data.todos ?? [];
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode;
		}

		// On resume: re-scan messages to rebuild completion state
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry) {
					const msg = (entry as any).message;
					if (msg?.role === "assistant") {
						markCompletedSteps(extractTextFromMessage(msg), todoItems);
					}
				}
			}
		}

		if (readOnlyEnabled && !planModeEnabled) {
			applyReadOnlyTools(pi);
		} else if (planModeEnabled) {
			toolsBeforePlanMode = toolsBeforePlanMode ?? pi.getActiveTools();
			pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
		} else if (executionMode) {
			pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		}

		updateUi(pi, ctx, readOnlyEnabled, planModeEnabled, executionMode, todoItems);
	});
}

// ── helpers ──

function findLastAssistantMessage(messages: any[]): any {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			return messages[i];
		}
	}
	return null;
}

function extractTextFromMessage(msg: any): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join("\n");
	}
	return "";
}
