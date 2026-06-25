
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
