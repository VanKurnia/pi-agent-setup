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
	/** Cached rendered Markdown component for the output (performance optimization) */
	_renderedOutput?: any; // Markdown instance, cached to avoid re-parse per frame
}

export interface Details {
	mode: "single" | "parallel" | "chain";
	results: AgentResult[];
	agentScope?: AgentScope;
	projectAgentsDir?: string | null;
}



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

/** Subagent lifecycle event channels emitted via pi.events */
export const SUBAGENT_EVENTS = {
  CREATED: "subagents:created",
  COMPLETED: "subagents:completed",
  FAILED: "subagents:failed",
} as const;

/** Payload for subagents:created event */
export interface SubagentCreatedEvent {
  agentId: string;
  agentName: string;
  task: string;
  mode: "single" | "parallel" | "chain";
  agentScope: string;
  timestamp: number;
}

/** Payload for subagents:completed event */
export interface SubagentCompletedEvent {
  agentId: string;
  agentName: string;
  task: string;
  output: string;
  usage: { input: number; output: number; turns: number; cost: number };
  durationMs: number;
  timestamp: number;
}

/** Payload for subagents:failed event */
export interface SubagentFailedEvent {
  agentId: string;
  agentName: string;
  task: string;
  error: string;
  durationMs: number;
  timestamp: number;
}
