/**
 * Shared agent state: config types, the agent registry, persisted settings,
 * and agent discovery.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { registerExtensionApi } from "../../shared/cross-extension-api.js";

// ── Agent config types ──────────────────────────────────────────────────
export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";

export interface AgentConfig {
    name: string;
    description: string;
    tools: string[];
    model: string;
    thinkingLevel?: ThinkingLevel;
    systemPrompt: string;
    filePath: string;
    source?: AgentSource;
}

export interface ToolEvent {
    tool: string;
    args: string; // preview string (backward compat)
    argsObj?: Record<string, unknown>; // full args object for richer rendering
}

export interface AgentProgress {
    agent: string;
    status: "pending" | "running" | "completed" | "failed";
    task: string;
    currentTool?: string;
    currentToolArgs?: string;
    currentToolArgsObj?: Record<string, unknown>; // full args object for richer rendering
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
    title?: string;
    output: string;
    exitCode: number;
    progress: AgentProgress;
    model?: string;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        turns: number;
    };
    step?: number;
}

export type HybridCollect = "all" | "first";

/** One unit of subagent work — full task plus optional short UI label and cwd. */
export interface TaskSpec {
    agent: string;
    task: string;
    cwd?: string;
    title?: string;
}

/** A single phase in a hybrid execution — can be single, parallel, or chain */
export type HybridPhase =
    | ({ mode: "single" } & TaskSpec)
    | {
          mode: "parallel";
          tasks: TaskSpec[];
          collect?: HybridCollect;
      }
    | { mode: "chain"; tasks: TaskSpec[] };

export interface Details {
    mode: "single" | "parallel" | "chain" | "hybrid";
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

/**
 * API that the plan-artifact extension exposes to other extensions.
 * Registered via `ExtensionAPI.registerExtensionApi('plan-artifact', ...)`.
 */
export interface PlanArtifactApi {
    /** Whether the plan server is currently running. */
    isRunning: () => boolean;
    /** The browser URL for the current plan, or null if not running. */
    getUrl: () => string | null;
    /** The plan summary, or null if no proposal. */
    getSummary: () => string | null;
    /** The plan status: "pending" | "accepted" | "revising", or null if no proposal. */
    getStatus: () => string | null;
    /** The raw plan markdown content, or null if no proposal. */
    getPlanContent: () => string | null;
}

/**
 * API that the update-setup extension exposes to other extensions.
 * Registered via `ExtensionAPI.registerExtensionApi('update-setup', ...)`,
 */
export interface UpdateSetupApi {
    /** Run the update script and return output. */
    runUpdate: () => Promise<string>;
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
    mode: "single" | "parallel" | "chain" | "hybrid";
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

// ── Agent registry ──────────────────────────────────────────────────────
let agents: AgentConfig[] = [];

export function registerAgent(config: AgentConfig): void {
    if (agents.find((a) => a.name === config.name)) {
        throw new Error(`Agent already registered: ${config.name}`);
    }
    agents.push(config);
}

export function unregisterAgent(name: string): void {
    agents = agents.filter((a) => a.name !== name);
}

export function getAgents(): readonly AgentConfig[] {
    return agents;
}

/** Replace the registry wholesale, e.g. after re-reading agent files. */
export function refreshAgents(newAgents: AgentConfig[]): void {
    agents = newAgents;
}

// Expose registration functions via the cross-extension API registry so other
// extensions (loaded via jiti, which creates separate module instances) can
// access the shared agents array.
registerExtensionApi<SubagentsApi>("subagents", { registerAgent, unregisterAgent });

// ── Persisted settings ──────────────────────────────────────────────────
export interface SubagentsSettings {
    maxConcurrent?: number;
    agentModels?: Record<string, string>;
    agentThinking?: Record<string, ThinkingLevel>;
}

export const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENT_CEILING = 1024;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

function sanitize(raw: unknown): SubagentsSettings {
    if (!raw || typeof raw !== "object") return {};
    const r = raw as Record<string, unknown>;
    const out: SubagentsSettings = {};
    if (
        typeof r.maxConcurrent === "number" &&
        Number.isInteger(r.maxConcurrent) &&
        r.maxConcurrent >= 1 &&
        r.maxConcurrent <= MAX_CONCURRENT_CEILING
    ) {
        out.maxConcurrent = r.maxConcurrent;
    }
    if (typeof r.agentModels === "object" && r.agentModels !== null) {
        const validated: Record<string, string> = {};
        for (const [name, model] of Object.entries(r.agentModels)) {
            if (typeof model === "string" && model.includes("/")) {
                validated[name] = model;
            }
        }
        if (Object.keys(validated).length > 0) {
            out.agentModels = validated;
        }
    }
    if (typeof r.agentThinking === "object" && r.agentThinking !== null) {
        const validated: Record<string, ThinkingLevel> = {};
        for (const [name, level] of Object.entries(r.agentThinking)) {
            if (
                typeof level === "string" &&
                (THINKING_LEVELS as readonly string[]).includes(level)
            ) {
                validated[name] = level as ThinkingLevel;
            }
        }
        if (Object.keys(validated).length > 0) {
            out.agentThinking = validated;
        }
    }
    return out;
}

export function settingsPath(agentDir: string): string {
    return path.join(agentDir, "subagents.json");
}

/** Load settings from global config. */
export function loadSettings(agentDir: string): SubagentsSettings {
    const settingsFile = settingsPath(agentDir);
    try {
        const raw = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
        return sanitize(raw);
    } catch (err) {
        // A missing file is normal: it is created on the first subagent invocation.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn(
                `[subagents] Failed to load ${settingsFile}: ${(err as Error)?.message ?? String(err)}; using defaults.`,
            );
        }
        return {};
    }
}

/** Write global settings. Returns true on success. */
export function saveSettings(s: SubagentsSettings, agentDir: string): boolean {
    const file = settingsPath(agentDir);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(s, null, 2), "utf-8");
        return true;
    } catch {
        return false;
    }
}

/**
 * SettingsManager — owns in-memory settings with load/save lifecycle.
 */
export class SettingsManager {
    private _maxConcurrent: number = DEFAULT_MAX_CONCURRENCY;
    private _agentModels: Record<string, string> = {};
    private _agentThinking: Record<string, ThinkingLevel> = {};
    private _loaded = false;
    private readonly agentDir: string;

    constructor() {
        this.agentDir = getAgentDir();
    }

    get maxConcurrent(): number {
        this.ensureLoaded();
        return this._maxConcurrent;
    }

    set maxConcurrent(n: number) {
        this.ensureLoaded();
        this._maxConcurrent = Math.max(1, Math.min(n, MAX_CONCURRENT_CEILING));
    }

    getAgentModel(agentName: string): string | undefined {
        this.ensureLoaded();
        return this._agentModels[agentName];
    }

    setAgentModel(agentName: string, modelId: string | undefined): void {
        this.ensureLoaded();
        if (modelId) {
            this._agentModels[agentName] = modelId;
        } else {
            delete this._agentModels[agentName];
        }
    }

    getAllAgentModels(): Readonly<Record<string, string>> {
        this.ensureLoaded();
        return this._agentModels;
    }

    getAgentThinking(agentName: string): ThinkingLevel | undefined {
        this.ensureLoaded();
        return this._agentThinking[agentName];
    }

    setAgentThinking(agentName: string, level: ThinkingLevel | undefined): void {
        this.ensureLoaded();
        if (level) {
            this._agentThinking[agentName] = level;
        } else {
            delete this._agentThinking[agentName];
        }
    }

    getAllAgentThinking(): Readonly<Record<string, ThinkingLevel>> {
        this.ensureLoaded();
        return this._agentThinking;
    }

    /**
     * Read the config file once, on first access. Keeps extension boot free of disk I/O.
     * The reset-then-apply order evicts keys deleted from the file since the last load.
     */
    private ensureLoaded(): void {
        if (this._loaded) return;
        this._loaded = true;

        const settings = loadSettings(this.agentDir);
        this._maxConcurrent = settings.maxConcurrent ?? DEFAULT_MAX_CONCURRENCY;
        this._agentModels = { ...(settings.agentModels ?? {}) };
        this._agentThinking = { ...(settings.agentThinking ?? {}) };
    }

    /** Force a re-read from disk (e.g. after wizard saves). */
    reload(): void {
        this._loaded = false;
        this.ensureLoaded();
    }

    /**
     * Write the config file when it is missing, seeded from the caller's defaults, then sync
     * in-memory state. No-op when the file exists.
     */
    ensureSeeded(payload: SubagentsSettings): void {
        if (fs.existsSync(settingsPath(this.agentDir))) return;
        if (saveSettings(payload, this.agentDir)) this.reload();
    }

    /** Save global settings (writes only non-default fields). */
    save(): boolean {
        this.ensureLoaded();
        const payload: SubagentsSettings = {};
        payload.maxConcurrent = this._maxConcurrent;
        if (Object.keys(this._agentModels).length > 0) {
            payload.agentModels = { ...this._agentModels };
        }
        if (Object.keys(this._agentThinking).length > 0) {
            payload.agentThinking = { ...this._agentThinking };
        }
        return saveSettings(payload, this.agentDir);
    }

    /** Apply a new concurrency value, persist, return toast message. */
    applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
        this.maxConcurrent = n;
        const persisted = this.save();
        return persisted
            ? { message: `Max concurrency set to ${this._maxConcurrent}`, level: "info" }
            : {
                  message: `Max concurrency set to ${this._maxConcurrent} (session only; failed to persist)`,
                  level: "warning",
              };
    }
}

// ── Agent discovery ─────────────────────────────────────────────────────

const AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Expand `${VAR}` and `$VAR` from process.env, leaving unknowns intact. */
export function substituteEnv(s: string): string {
    return s
        .replace(/\${([^}]+)}/g, (_, name) => {
            const val = process.env[name];
            return val !== undefined ? val : `\${${name}}`;
        })
        .replace(/\$([A-Z_a-z0-9]+)/g, (_, name) => {
            const val = process.env[name];
            return val !== undefined ? val : `$${name}`;
        });
}

/**
 * Load agent .md files from a single directory.
 * Returns an empty array if the directory does not exist.
 */
export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
    const agents: AgentConfig[] = [];
    if (!fs.existsSync(dir)) return agents;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return agents;
    }
    for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const filePath = path.join(dir, entry.name);
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }
        const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
        if (!frontmatter.name) continue;

        const tools = (frontmatter.tools || "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);

        let model = frontmatter.model || "anthropic/claude-sonnet-4-6";
        model = substituteEnv(model);

        agents.push({
            name: frontmatter.name,
            description: frontmatter.description || "",
            tools,
            model,
            systemPrompt: body,
            filePath,
            source,
        });
    }
    return agents;
}

/**
 * Walk up from `cwd` looking for a `.pi/agents/` directory (project-local agents).
 */
export function findNearestProjectAgentsDir(cwd: string): string | null {
    let currentDir = cwd;
    while (true) {
        const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
        if (isDirectory(candidate)) return candidate;
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) return null;
        currentDir = parentDir;
    }
}

/**
 * Result of discoverAgents().
 */
export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectAgentsDir: string | null;
}

// Module-level cache for discoverAgents() — agent files don't change mid-session.
// Bounded with FIFO eviction so long sessions with many cwds can't grow it.
const MAX_AGENT_DISCOVERY_CACHE_ENTRIES = 32;
const agentDiscoveryCache = new Map<string, AgentDiscoveryResult>();

function setAgentDiscoveryCache(key: string, value: AgentDiscoveryResult): void {
    if (
        !agentDiscoveryCache.has(key) &&
        agentDiscoveryCache.size >= MAX_AGENT_DISCOVERY_CACHE_ENTRIES
    ) {
        const oldest = agentDiscoveryCache.keys().next().value;
        if (oldest !== undefined) agentDiscoveryCache.delete(oldest);
    }
    agentDiscoveryCache.set(key, value);
}

export function clearAgentCache(): void {
    agentDiscoveryCache.clear();
}

/**
 * Discover agents from the standard user directory (~/.pi/agent/agents/)
 * and optionally from a project-local .pi/agents/ directory.
 *
 * Later sources win by name, so priority runs: extension built-ins, then the
 * user directory, then project-local files.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
    const cacheKey = `${cwd}:${scope}`;
    const cached = agentDiscoveryCache.get(cacheKey);
    if (cached) return cached;

    const userDir = path.join(getAgentDir(), "agents");
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);

    const sources: AgentConfig[][] = [];
    if (scope !== "project") {
        // Built-in agents shipped with the extension, lowest priority.
        if (userDir !== AGENTS_DIR) sources.push(loadAgentsFromDir(AGENTS_DIR, "user"));
        sources.push(loadAgentsFromDir(userDir, "user"));
    }
    if (scope !== "user" && projectAgentsDir) {
        sources.push(loadAgentsFromDir(projectAgentsDir, "project"));
    }

    const byName = new Map<string, AgentConfig>();
    for (const source of sources) {
        for (const agent of source) byName.set(agent.name, agent);
    }

    const result: AgentDiscoveryResult = {
        agents: Array.from(byName.values()),
        projectAgentsDir,
    };
    setAgentDiscoveryCache(cacheKey, result);
    return result;
}

/**
 * Resolve a model string (e.g. "anthropic/claude-sonnet-4-6") to a Model object
 * via the shared ExtensionContext model registry.
 * Returns undefined if the model cannot be resolved.
 */
export async function resolveAgentModel(
    modelId: string,
    registry: { find(provider: string, modelId: string): Model<any> | undefined },
): Promise<Model<any> | undefined> {
    const slashIdx = modelId.indexOf("/");
    if (slashIdx === -1) return undefined;
    const provider = modelId.slice(0, slashIdx);
    const name = modelId.slice(slashIdx + 1);
    try {
        return registry.find(provider, name);
    } catch (err) {
        // Warn, then report unknown-model: the cause (bad auth/models file)
        // is otherwise invisible to the caller.
        console.warn(
            `[subagents] Failed to resolve model '${modelId}': ${(err as Error)?.message ?? String(err)}`,
        );
        return undefined;
    }
}
