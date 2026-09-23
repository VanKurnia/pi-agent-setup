import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    ModelRuntime,
    parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentScope, AgentSource } from "./types.js";

let envLoaded = false;

// ── Config ─────────────────────────────────────────────────────────────

export const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const AGENTS_DIR = path.join(EXT_DIR, "..", "agents");
export const TOOLS_DIR = path.join(EXT_DIR, "..", "tools");
export { DEFAULT_MAX_CONCURRENCY } from "./settings.js";

export function loadEnv(force = false): void {
    if (envLoaded && !force) return;
    envLoaded = true;
    const envPath = path.join(getAgentDir(), "..", ".env");
    if (!fs.existsSync(envPath)) return;
    try {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const index = trimmed.indexOf("=");
            if (index === -1) continue;
            const key = trimmed.slice(0, index).trim();
            let val = trimmed.slice(index + 1).trim();
            if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
            ) {
                val = val.slice(1, -1);
            }
            process.env[key] = val;
        }
    } catch (err) {
        // Warn, then continue with whatever parsed.
        console.warn(
            `[subagents] Failed to load ${envPath}: ${(err as Error)?.message ?? String(err)}; using partial env.`,
        );
    }
}

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
 * For "user" scope, also falls back to the extension's own agents/ directory
 * for built-in agents shipped with the subagents extension.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
    const cacheKey = `${cwd}:${scope}`;
    const cached = agentDiscoveryCache.get(cacheKey);
    if (cached) return cached;

    const userDir = path.join(getAgentDir(), "agents");
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);

    const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");

    // Fallback: also check the extension's own agents/ dir for built-in agents
    if (scope !== "project" && userDir !== AGENTS_DIR) {
        const extAgents = loadAgentsFromDir(AGENTS_DIR, "user");
        // Merge: standard location takes priority over extension fallback
        const agentMap = new Map<string, AgentConfig>();
        for (const a of extAgents) agentMap.set(a.name, a);
        for (const a of userAgents) agentMap.set(a.name, a);
        const merged = Array.from(agentMap.values());

        const projectAgents =
            scope === "user" || !projectAgentsDir
                ? []
                : loadAgentsFromDir(projectAgentsDir, "project");

        if (scope === "both") {
            for (const a of merged) agentMap.set(a.name, a);
            for (const a of projectAgents) agentMap.set(a.name, a);
            const result: AgentDiscoveryResult = {
                agents: Array.from(agentMap.values()),
                projectAgentsDir,
            };
            setAgentDiscoveryCache(cacheKey, result);
            return result;
        }
        const result2: AgentDiscoveryResult = { agents: merged, projectAgentsDir };
        setAgentDiscoveryCache(cacheKey, result2);
        return result2;
    }

    const projectAgents =
        scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

    const agentMap = new Map<string, AgentConfig>();
    if (scope === "both") {
        for (const a of userAgents) agentMap.set(a.name, a);
        for (const a of projectAgents) agentMap.set(a.name, a);
    } else if (scope === "user") {
        for (const a of userAgents) agentMap.set(a.name, a);
    } else {
        for (const a of projectAgents) agentMap.set(a.name, a);
    }

    const result: AgentDiscoveryResult = {
        agents: Array.from(agentMap.values()),
        projectAgentsDir,
    };
    setAgentDiscoveryCache(cacheKey, result);
    return result;
}

/**
 * Backward-compatible wrapper: loads agents from the standard user directory
 * via discoverAgents(), falling back to the extension's own agents/ directory.
 */
export function loadAgents(): AgentConfig[] {
    loadEnv();
    return discoverAgents(process.cwd(), "user").agents;
}

/**
 * Create a private ModelRuntime for agent model resolution.
 * Per-call construction (local file reads only, no network).
 */
export async function createAgentRuntime(agentDir: string): Promise<ModelRuntime> {
    return ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
        modelsStorePath: path.join(agentDir, "models-store.json"),
        allowModelNetwork: false,
    });
}

/**
 * Resolve a model string (e.g. "anthropic/claude-sonnet-4-6") to a Model object.
 * Returns undefined if the model cannot be resolved.
 */
export async function resolveAgentModel(
    modelId: string,
    agentDir: string,
): Promise<Model<any> | undefined> {
    const slashIdx = modelId.indexOf("/");
    if (slashIdx === -1) return undefined;
    const provider = modelId.slice(0, slashIdx);
    const name = modelId.slice(slashIdx + 1);
    try {
        const runtime = await createAgentRuntime(agentDir);
        const model = runtime.getModel(provider, name);
        return model ?? undefined;
    } catch (err) {
        // Warn, then report unknown-model: the cause (bad auth/models file)
        // is otherwise invisible to the caller.
        console.warn(
            `[subagents] Failed to resolve model '${modelId}': ${(err as Error)?.message ?? String(err)}`,
        );
        return undefined;
    }
}
