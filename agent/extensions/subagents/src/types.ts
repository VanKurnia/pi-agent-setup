
export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	model: string;
	systemPrompt: string;
	filePath: string;
	source?: AgentSource;
}

export interface ToolEvent {
	tool: string;
	args: string;  // preview string (backward compat)
	argsObj?: Record<string, unknown>;  // full args object for richer rendering
}

export interface AgentProgress {
	agent: string;
	status: "pending" | "running" | "completed" | "failed";
	task: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolArgsObj?: Record<string, unknown>;  // full args object for richer rendering
	recentTools: ToolEvent[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	lastMessage: string;
	error?: string;
}

export interface AgentResult {
	agent: string;
	task: string;
	output: string;
	exitCode: number;
	progress: AgentProgress;
	model?: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
	step?: number;
}

export interface Details {
	mode: "single" | "parallel" | "chain";
	results: AgentResult[];
	agentScope?: AgentScope;
	projectAgentsDir?: string | null;
}

export type SubagentEvent =
	| { type: "tool_execution_start"; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_end" }
	| { type: "tool_result_end" }
	| { type: "message_end"; message: any }
	| { type: "ask_user_question_pending"; id: string; question: string; context?: string; mode: string; options?: any[]; answerFile: string };

export const KNOWN_EVENT_TYPES = new Set([
	"tool_execution_start", "tool_execution_end", "tool_result_end",
	"message_end", "ask_user_question_pending",
]);

/**
 * API that the filechanges extension exposes to subagents.
 * Registered via `ExtensionAPI.registerExtensionApi('filechanges', ...)`.
 */
export interface FilechangesApi {
    trackFile: (
        ctx: any,
        relPath: string,
        absPath: string,
        originalContent: string | null,
    ) => Promise<void>;
}

/**
 * API that the subagents extension exposes to other extensions.
 * Registered via `ExtensionAPI.registerExtensionApi('subagents', ...)`.
 */
export interface SubagentsApi {
    registerAgent: (config: AgentConfig) => void;
    unregisterAgent: (name: string) => void;
}
