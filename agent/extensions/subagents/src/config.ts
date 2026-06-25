import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope, AgentSource } from "./types.js";

// ── Config ─────────────────────────────────────────────────────────────
// Config is read from .env (SUBAGENTS_MAX_CONCURRENCY) at the pi root.
// See loadEnv() below for .env parsing.

export const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const AGENTS_DIR = path.join(EXT_DIR, "..", "agents");
export const TOOLS_DIR = path.join(EXT_DIR, "..", "tools");
export const DEFAULT_MAX_CONCURRENCY = 4;

const EXT_BASE = path.join(EXT_DIR, "..", "..");

export function loadEnv(): void {
	const envPath = path.join(EXT_BASE, "..", ".env");
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
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[key] = val;
		}
	} catch {}
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
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
		model = model.replace(/\${([^}]+)}/g, (_, name) => {
			const val = process.env[name];
			return val !== undefined ? val : `\${${name}}`;
		});
		model = model.replace(/\$([A-Z_a-z0-9]+)/g, (_, name) => {
			const val = process.env[name];
			return val !== undefined ? val : `$${name}`;
		});

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

/**
 * Discover agents from the standard user directory (~/.pi/agent/agents/)
 * and optionally from a project-local .pi/agents/ directory.
 *
 * For "user" scope, also falls back to the extension's own agents/ directory
 * for built-in agents shipped with the subagents extension.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
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

		const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

		if (scope === "both") {
			for (const a of merged) agentMap.set(a.name, a);
			for (const a of projectAgents) agentMap.set(a.name, a);
			return { agents: Array.from(agentMap.values()), projectAgentsDir };
		}
		return { agents: merged, projectAgentsDir };
	}

	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	if (scope === "both") {
		for (const a of userAgents) agentMap.set(a.name, a);
		for (const a of projectAgents) agentMap.set(a.name, a);
	} else if (scope === "user") {
		for (const a of userAgents) agentMap.set(a.name, a);
	} else {
		for (const a of projectAgents) agentMap.set(a.name, a);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * Backward-compatible wrapper: loads agents from the standard user directory
 * via discoverAgents(), falling back to the extension's own agents/ directory.
 */
export function loadAgents(): AgentConfig[] {
	loadEnv();
	return discoverAgents(process.cwd(), "user").agents;
}

export function resolvePiBinary(): { command: string; baseArgs: string[] } {
	// Resolve the pi entry point from process.argv[1]
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {}
	}
	return { command: "pi", baseArgs: [] };
}
