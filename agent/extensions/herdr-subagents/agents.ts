/**
 * Agent discovery for the herdr backend: loads agent `.md` files
 * (frontmatter + persona body) the same way the sibling extension does,
 * without importing from it.
 */
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { projectKey } from "./session.ts";

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

export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectAgentsDir: string | null;
}

const AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

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
 * Discover agents from this extension's `agents/` directory, the user
 * directory (`~/.pi/agent/agents/`), and optionally a project-local
 * `.pi/agents/` directory. Later sources win by name.
 *
 * Deliberately no cache: each tool call re-reads a couple of small files,
 * so agent edits are picked up without a reload command.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
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

    return { agents: Array.from(byName.values()), projectAgentsDir };
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SubagentsSettings {
    agentModels?: Record<string, string>;
    agentThinking?: Record<string, ThinkingLevel>;
}

// Model ids are interpolated into a shell command, so only shell-safe
// characters pass, plus the CLI's optional `:thinking` suffix.
const MODEL_PATTERN = /^[A-Za-z0-9_./-]+(:[A-Za-z0-9_.-]+)?$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
}

// Shared by the reader and the writers: what can be stored is exactly what
// can be read back.
function isValidModel(value: unknown): value is string {
    return typeof value === "string" && value.includes("/") && MODEL_PATTERN.test(value);
}

function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
    return (THINKING_LEVELS as readonly unknown[]).includes(value);
}

function sanitizeSettings(raw: unknown): SubagentsSettings {
    const r = asRecord(raw);
    if (!r) return {};
    const out: SubagentsSettings = {};
    const models = asRecord(r.agentModels);
    if (models) {
        const validated: Record<string, string> = {};
        for (const [name, model] of Object.entries(models)) {
            if (isValidModel(model)) validated[name] = model;
        }
        if (Object.keys(validated).length > 0) out.agentModels = validated;
    }
    const thinking = asRecord(r.agentThinking);
    if (thinking) {
        const validated: Record<string, ThinkingLevel> = {};
        for (const [name, level] of Object.entries(thinking)) {
            if (isValidThinkingLevel(level)) validated[name] = level;
        }
        if (Object.keys(validated).length > 0) out.agentThinking = validated;
    }
    return out;
}

export function settingsPath(agentDir: string): string {
    return path.join(agentDir, "subagents.json");
}

// A missing or malformed file yields {}; callers fall back to agent defaults.
export function loadSubagentsSettings(agentDir: string): SubagentsSettings {
    try {
        return sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath(agentDir), "utf-8")));
    } catch {
        return {};
    }
}

// Fallback for agents the settings file has no entry for.
export function defaultThinkingForAgent(name: string): ThinkingLevel | undefined {
    if (name === "worker") return "high";
    if (name === "scout") return "low";
    return undefined;
}

// Flag values are interpolated into a pane shell command, so every value is quoted.
function flag(name: string, value: string): string {
    return ` --${name} "${value}"`;
}

/**
 * Trust flags take no value, so `flag()` cannot build them: `--approve ""`
 * would become a positional message. The parent's decision is mirrored so the
 * child loads exactly the project resources the parent loaded, and never stops
 * at a trust prompt the dispatch pipeline cannot answer.
 */
export function buildTrustFlag(projectTrusted: boolean): string {
    return projectTrusted ? " --approve" : " --no-approve";
}

export function resolveAgentFlags(
    agent: { name: string; model: string },
    settings: SubagentsSettings,
): { modelFlag: string; thinkingFlag: string } {
    const model = settings.agentModels?.[agent.name] ?? agent.model;
    const thinking = settings.agentThinking?.[agent.name] ?? defaultThinkingForAgent(agent.name);
    return {
        modelFlag: flag("model", model),
        thinkingFlag: thinking ? flag("thinking", thinking) : "",
    };
}

export interface AppendSystemPromptInput {
    agent: Pick<AgentConfig, "name" | "systemPrompt">;
    cwd: string;
    agentDir: string;
    /** `ctx.isProjectTrusted()` — the child runs in the same cwd. */
    projectTrusted: boolean;
    tmpDir: string;
}

/**
 * Boot-time `--append-system-prompt` flags for a child: the agent persona plus
 * the APPEND_SYSTEM.md the child would otherwise discover. Passing the flag
 * replaces pi's own discovery of that file, so it is resolved here the same
 * way: trusted project file first, agent directory second.
 *
 * The values are paths, never inline text: the command is typed into a pane
 * shell, and persona markdown is full of backticks. The persona file is
 * content-hashed, so an edit creates a new file instead of rewriting one that a
 * running child may re-read.
 */
export function buildAppendSystemPromptFlags(input: AppendSystemPromptInput): string {
    const { agent, cwd, agentDir, projectTrusted, tmpDir } = input;

    const projectFile = path.join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
    const addendum =
        projectTrusted && fs.existsSync(projectFile)
            ? projectFile
            : path.join(agentDir, "APPEND_SYSTEM.md");

    const flags: string[] = [];
    if (fs.existsSync(addendum)) flags.push(flag("append-system-prompt", addendum));

    const persona = agent.systemPrompt.replace(/^\n+|\n+$/g, "");
    if (persona.length > 0) {
        const dir = path.join(tmpDir, "herdr-subagent-system");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `agent-${agent.name}-${projectKey(persona)}.md`);
        if (!fs.existsSync(file)) fs.writeFileSync(file, persona, "utf-8");
        flags.push(flag("append-system-prompt", file));
    }

    return flags.join("");
}

// Read-modify-write of the raw file: only the one entry changes, every other
// key keeps its value. `undefined` deletes the entry, and a section left
// without entries is dropped.
function patchSettingsFile(
    agentDir: string,
    section: "agentModels" | "agentThinking",
    agentName: string,
    value: string | undefined,
): boolean {
    let raw: Record<string, unknown> = {};
    try {
        raw = asRecord(JSON.parse(fs.readFileSync(settingsPath(agentDir), "utf-8"))) ?? {};
    } catch {
        // Missing or malformed file: start from an empty one.
    }
    const record = asRecord(raw[section]) ?? {};
    if (value === undefined) {
        delete record[agentName];
    } else {
        record[agentName] = value;
    }
    if (Object.keys(record).length > 0) {
        raw[section] = record;
    } else {
        delete raw[section];
    }
    try {
        fs.mkdirSync(path.dirname(settingsPath(agentDir)), { recursive: true });
        fs.writeFileSync(settingsPath(agentDir), JSON.stringify(raw, null, 2), "utf-8");
        return true;
    } catch {
        return false;
    }
}

export function writeAgentModel(
    agentDir: string,
    agentName: string,
    model: string | undefined,
): boolean {
    if (model !== undefined && !isValidModel(model)) return false;
    return patchSettingsFile(agentDir, "agentModels", agentName, model);
}

export function writeAgentThinking(
    agentDir: string,
    agentName: string,
    level: ThinkingLevel | undefined,
): boolean {
    if (level !== undefined && !isValidThinkingLevel(level)) return false;
    return patchSettingsFile(agentDir, "agentThinking", agentName, level);
}
