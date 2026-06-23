
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

// ── Config ─────────────────────────────────────────────────────────────
// Config is read from .env (SUBAGENTS_MAX_CONCURRENCY) at the pi root.
// See loadEnv() below for .env parsing.

export const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const AGENTS_DIR = path.join(EXT_DIR, "..", "agents");
export const TOOLS_DIR = path.join(EXT_DIR, "..", "tools");
export const DEFAULT_MAX_CONCURRENCY = 4;

// Built-in tools that pi provides natively (no extension needed)
export const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

// Custom tools that require loading an extension into the subagent process
const EXT_BASE = path.join(EXT_DIR, "..", "..");
export const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
	ninerouter_web_fetch: "npm:pi-9router-ext",
	ninerouter_web_search: "npm:pi-9router-ext",
	safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
	git_status: path.join(EXT_BASE, "git-toolkit.ts"),
	git_diff_unstaged: path.join(EXT_BASE, "git-toolkit.ts"),
	git_diff_staged: path.join(EXT_BASE, "git-toolkit.ts"),
	git_diff: path.join(EXT_BASE, "git-toolkit.ts"),
	git_add: path.join(EXT_BASE, "git-toolkit.ts"),
	git_commit: path.join(EXT_BASE, "git-toolkit.ts"),
	git_reset: path.join(EXT_BASE, "git-toolkit.ts"),
	git_log: path.join(EXT_BASE, "git-toolkit.ts"),
	git_create_branch: path.join(EXT_BASE, "git-toolkit.ts"),
	git_checkout: path.join(EXT_BASE, "git-toolkit.ts"),
	git_show: path.join(EXT_BASE, "git-toolkit.ts"),
	git_branch: path.join(EXT_BASE, "git-toolkit.ts"),
	query_sqlite: path.join(EXT_BASE, "db-viewer", "index.ts"),
	query_mysql: path.join(EXT_BASE, "db-viewer", "index.ts"),
	browser_start: path.join(EXT_BASE, "browser-tools", "src", "index.ts"),
	browser_nav: path.join(EXT_BASE, "browser-tools", "src", "index.ts"),
	browser_eval: path.join(EXT_BASE, "browser-tools", "src", "index.ts"),
	browser_screenshot: path.join(EXT_BASE, "browser-tools", "src", "index.ts"),
	browser_content: path.join(EXT_BASE, "browser-tools", "src", "index.ts"),
	browser_cookies: path.join(EXT_BASE, "browser-tools", "src", "index.ts"),
	browser_pick: path.join(EXT_BASE, "browser-tools", "src", "index.ts"),
	ask_user_question: path.join(EXT_BASE, "ask-user-question.ts"),
};

// Validate all tool extension paths at startup
for (const [tool, ext] of Object.entries(CUSTOM_TOOL_EXTENSIONS)) {
  if (ext.startsWith("npm:")) continue;
  if (!fs.existsSync(ext)) {
    console.warn(`[subagents] Tool "${tool}" extension not found: ${ext}`);
  }
}

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

export function loadAgents(): AgentConfig[] {
	loadEnv();
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(AGENTS_DIR)) return agents;
	for (const entry of fs.readdirSync(AGENTS_DIR)) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(AGENTS_DIR, entry);
		const content = fs.readFileSync(filePath, "utf-8");
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
		});
	}
	return agents;
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
