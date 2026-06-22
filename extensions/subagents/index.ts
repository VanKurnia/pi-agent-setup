/**
 * Minimal subagents extension.
 *
 * Registers a single `subagent` tool with three agents: scout, researcher, worker.
 * Supports single and parallel execution. Output is verbal only (no file handoff).
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, parseFrontmatter, truncateHead, withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";

// ── Types ──────────────────────────────────────────────────────────────

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	model: string;
	systemPrompt: string;
	filePath: string;
}

interface ToolEvent {
	tool: string;
	args: string;
}

interface AgentProgress {
	agent: string;
	status: "pending" | "running" | "completed" | "failed";
	task: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentTools: ToolEvent[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	lastMessage: string;
	error?: string;
}

interface AgentResult {
	agent: string;
	task: string;
	output: string;
	exitCode: number;
	progress: AgentProgress;
	model?: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
}

interface Details {
	mode: "single" | "parallel";
	results: AgentResult[];
}

// ── Config ─────────────────────────────────────────────────────────────
// Config is read from .env (SUBAGENTS_MAX_CONCURRENCY) at the pi root.
// See loadEnv() below for .env parsing.

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(EXT_DIR, "agents");
const TOOLS_DIR = path.join(EXT_DIR, "tools");
const DEFAULT_MAX_CONCURRENCY = 4;

// Built-in tools that pi provides natively (no extension needed)
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

// Custom tools that require loading an extension into the subagent process
const EXT_BASE = path.join(EXT_DIR, "..");
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
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

// ── Agent Discovery & Registration ────────────────────────────────────

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

// Expose registration functions globally so other extensions loaded via jiti
// (which creates separate module instances) can access the shared agents array.
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent };

function loadEnv(): void {
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

function loadAgents(): AgentConfig[] {
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

// ── Pi Binary Resolution ──────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
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

// ── Formatting Utilities ──────────────────────────────────────────────

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	let result = "";
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		// Skip ANSI escape sequences — zero visible width
		if (ch === "\x1b") {
			const rest = text.slice(i);
			const match = rest.match(/^\x1b\[[0-9;]*m/);
			if (match) {
				result += match[0];
				i += match[0].length - 1;
				continue;
			}
		}
		if (width >= maxWidth - 1) {
			return result + "…";
		}
		result += ch;
		width++;
	}
	return result;
}

// ── Subagent Execution ────────────────────────────────────────────────

async function buildPiArgs(
	agent: AgentConfig,
	task: string,
	cwd: string,
): Promise<{ args: string[]; tempDir: string }> {
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	// Write system prompt to temp file
	const promptPath = path.join(tempDir, `${agent.name}.md`);
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	const args = [...piBin.baseArgs, "--mode", "json", "-p", "--no-session", "--no-skills"];

	// Separate builtin tools from custom tools
	const builtinTools: string[] = [];
	const extensionPaths = new Set<string>();

	for (const tool of agent.tools) {
		if (BUILTIN_TOOLS.has(tool)) {
			builtinTools.push(tool);
		} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
			extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
		}
	}

	// Use --no-extensions then add only what we need
	args.push("--no-extensions");

	// Include all tool names so the model knows they're available
	// (builtin tools are native, extension tools are registered via --extension)
	const allToolNames = [...agent.tools];
	if (allToolNames.length > 0) {
		args.push("--tools", allToolNames.join(","));
	} else {
		args.push("--no-tools");
	}

	for (const extPath of extensionPaths) {
		args.push("--extension", extPath);
	}

	args.push("--models", agent.model);
	args.push("--append-system-prompt", promptPath);

	// Handle long tasks by writing to file
	const TASK_LIMIT = 8000;
	if (task.length > TASK_LIMIT) {
		const taskPath = path.join(tempDir, "task.md");
		await withFileMutationQueue(taskPath, async () => {
			await fs.promises.writeFile(taskPath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
		});
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	return { args: [piBin.command, ...args], tempDir };
}

function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

function extractToolArgsPreview(args: Record<string, unknown>): string {
	if (args.command) return String(args.command).slice(0, 100);
	if (args.path) return String(args.path);
	if (args.query) return `"${String(args.query).slice(0, 80)}"`;
	if (args.url) return String(args.url);
	if (args.pattern) return String(args.pattern);
	const s = JSON.stringify(args);
	return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

/**
 * Relay a user question from a headless subagent to the user
 * via the main session's UI context, and write the answer back.
 */
async function relayQuestion(ctx: any, evt: any): Promise<void> {
  const { question, context, mode, options, answerFile } = evt;

  let answers: any[];

  try {
    if (mode === "text") {
      const answer = await ctx.ui.editor(context
        ? `${question}\n\n${context}`
        : question);
      if (answer === undefined) {
        answers = [];
      } else {
        answers = [{ type: "text", label: answer.trim(), value: answer.trim() }];
      }
    } else if (mode === "multi-select") {
      // ctx.ui.select expects an array of label strings, not objects
      const labels = (options || []).map((o: any) => o.label);
      const selected = await ctx.ui.select(question, labels, {
        multiSelect: true,
        message: context,
      });
      if (!selected || selected.length === 0) {
        answers = [];
      } else {
        answers = selected.map((s: string) => {
          const opt = (options || []).find((o: any) => o.label === s);
          const idx = (options || []).findIndex((o: any) => o.label === s);
          return {
            type: "option" as const,
            label: s,
            value: opt?.value || s,
            index: idx + 1,
          };
        });
      }
    } else {
      // single-select — ctx.ui.select expects label strings, returns the chosen string
      const labels = (options || []).map((o: any) => o.label);
      const selected = await ctx.ui.select(question, labels, {
        message: context,
      });
      if (!selected) {
        answers = [];
      } else {
        const opt = (options || []).find((o: any) => o.label === selected);
        const idx = (options || []).findIndex((o: any) => o.label === selected);
        answers = [{
          type: "option" as const,
          label: selected,
          value: opt?.value || selected,
          index: idx + 1,
        }];
      }
    }
  } catch (err) {
    // If UI interaction fails, write empty answer
    answers = [];
  }

  // Write answer to the shared answer file
  try {
    await fs.promises.writeFile(answerFile, JSON.stringify({ answers }), "utf-8");
  } catch (err) {
    console.error("[subagents] failed to write answer file:", answerFile, err);
  }
}

/** Shared relay handler with error logging — used from stdout, stderr, and close handlers. */
function relayOrLog(ctx: any, evt: any): void {
  relayQuestion(ctx, evt).catch((err) => {
    console.error("[subagents] relayQuestion failed:", err);
  });
}

// ── Subagent Event Stream ──────────────────────────────────────────

type SubagentEvent =
	| { type: "tool_execution_start"; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_end" }
	| { type: "tool_result_end" }
	| { type: "message_end"; message: any }
	| { type: "ask_user_question_pending"; id: string; question: string; context?: string; mode: string; options?: any[]; answerFile: string };

const KNOWN_EVENT_TYPES = new Set([
	"tool_execution_start", "tool_execution_end", "tool_result_end",
	"message_end", "ask_user_question_pending",
]);

function isSubagentEvent(raw: any): raw is SubagentEvent {
	return raw && typeof raw === "object" && KNOWN_EVENT_TYPES.has(raw.type);
}

class SubagentEventStream {
	private buf = "";
	private onEvent: (evt: SubagentEvent) => void;

	constructor(onEvent: (evt: SubagentEvent) => void) {
		this.onEvent = onEvent;
	}

	feed(data: string): void {
		this.buf += data;
		const lines = this.buf.split("\n");
		this.buf = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line);
				if (isSubagentEvent(parsed)) {
					this.onEvent(parsed);
				}
			} catch {
				// Non-JSON lines are expected (stray log output)
			}
		}
	}

	drain(): void {
		if (this.buf.trim()) {
			this.feed("\n");  // flush final line
		}
	}
}

/** Returns 'relay' if the line was a relay event (already handled), 'stderr' otherwise. */
function classifyStderrLine(line: string, ctx?: any): 'relay' | 'stderr' {
	try {
		const evt = JSON.parse(line) as any;
		if (evt.type === "ask_user_question_pending" && ctx?.hasUI) {
			relayOrLog(ctx, evt);
			return 'relay';
		}
	} catch {}
	return 'stderr';
}

async function runSubagent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (progress: AgentProgress) => void,
	ctx?: any,
): Promise<AgentResult> {
	const { args, tempDir } = await buildPiArgs(agent, task, cwd);
	const command = args[0];
	const spawnArgs = args.slice(1);

	const result: AgentResult = {
		agent: agent.name,
		task,
		output: "",
		exitCode: 0,
		model: agent.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			agent: agent.name,
			status: "running",
			task,
			recentTools: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			lastMessage: "",
		},
	};

	const startTime = Date.now();
	const progress = result.progress;

	const fireUpdate = throttle(() => {
		progress.durationMs = Date.now() - startTime;
		onUpdate?.(progress);
	}, 150);

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(command, spawnArgs, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_ANSWER_DIR: tempDir },
		});

		let stderrBuf = "";
		let stderrLineBuf = "";

		const eventStream = new SubagentEventStream((evt) => {
			progress.durationMs = Date.now() - startTime;

			switch (evt.type) {
				case "tool_execution_start":
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
					fireUpdate();
					break;
				case "tool_execution_end":
					if (progress.currentTool) {
						progress.recentTools.push({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
						});
						if (progress.recentTools.length > 20) {
							progress.recentTools.splice(0, progress.recentTools.length - 20);
						}
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					fireUpdate();
					break;
				case "tool_result_end":
					fireUpdate();
					break;
				case "message_end":
					if (evt.message?.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							progress.tokens = result.usage.input + result.usage.output;
						}
						if (evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) progress.error = evt.message.errorMessage;
						const text = extractTextFromContent(evt.message.content);
						if (text) {
							result.output = text;
							const proseLines: string[] = [];
							let inCodeBlock = false;
							for (const line of text.split("\n")) {
								if (line.trimStart().startsWith("```")) { inCodeBlock = !inCodeBlock; continue; }
								if (!inCodeBlock && line.trim()) proseLines.push(line.trim());
							}
							if (proseLines.length > 0) progress.lastMessage = proseLines.slice(0, 3).join(" ");
						}
					}
					fireUpdate();
					break;
				case "ask_user_question_pending":
					if (ctx?.hasUI) relayOrLog(ctx, evt);
					break;
			}
		});

		proc.stdout.on("data", (d: Buffer) => eventStream.feed(d.toString()));

		// Parse stderr lines too — pi redirects stdout to stderr in JSON mode,
		// so relay events (ask_user_question_pending) arrive on stderr.
		proc.stderr.on("data", (d: Buffer) => {
			stderrLineBuf += d.toString();
			const lines = stderrLineBuf.split("\n");
			stderrLineBuf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				if (classifyStderrLine(line, ctx) === 'stderr') {
					stderrBuf += line + "\n";
				}
			}
		});

		proc.on("close", (code) => {
			eventStream.drain();
			// Drain remaining stderr line buffer
			if (stderrLineBuf.trim() && classifyStderrLine(stderrLineBuf, ctx) === 'stderr') {
				stderrBuf += stderrLineBuf;
			}
			if (code !== 0 && stderrBuf.trim() && !progress.error) {
				progress.error = stderrBuf.trim();
			}
			resolve(code ?? 1);
		});

		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	// Cleanup temp dir
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {}

	result.exitCode = exitCode;
	progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (progress.error) result.output = result.output || `Error: ${progress.error}`;

	// Truncate output if very large
	if (result.output.length > DEFAULT_MAX_BYTES) {
		const trunc = truncateHead(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		result.output = trunc.content;
		if (trunc.truncated) {
			result.output += "\n\n[Output truncated]";
		}
	}

	return result;
}

// ── Post-hoc diffing for worker file changes ──────────────────────────

// Heuristic: a "file path" inside backticks has at least one / or \\
// plus an extension (dot followed by alphanumeric). This excludes things
// like `npm test`, `hello`, or variable names while catching both
// relative paths (extensions/foo.ts) and absolute paths (C:/Users/...).
const FILE_PATH_IN_TICKS = /`([^`]+[/\\][^`]+\.[a-zA-Z0-9_]+)`/g;

function makeRelPath(raw: string, cwd: string): string {
  // Normalize backslashes
  let p = raw.replace(/\\/g, "/");
  // If absolute Windows path (e.g. C:/Users/...), make relative to cwd
  if (p.match(/^[a-zA-Z]:\//)) {
    const rel = path.relative(cwd, p);
    // path.relative normalizes to / but may produce \\ on Windows
    return rel.replace(/\\/g, "/");
  }
  return p;
}

function extractFilePaths(output: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  // Strategy 1: bullet points in ## Changes Made section (most reliable)
  const changesMatch = output.match(/## Changes Made[\s\S]*?(?=## |$)/);
  if (changesMatch) {
    for (const line of changesMatch[0].split("\n")) {
      const m = line.match(/^-\s+`([^`]+)`/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); paths.push(m[1]); }
    }
  }

  // Strategy 2: scan all lines for backtick-wrapped file paths
  // Only if no paths found via strategy 1 (worker may not have used format)
  if (paths.length === 0) {
    for (const line of output.split("\n")) {
      if (line.startsWith("#") || line.startsWith("\`\`\`")) continue;
      const matches = line.matchAll(FILE_PATH_IN_TICKS);
      for (const m of matches) {
        if (!seen.has(m[1])) { seen.add(m[1]); paths.push(m[1]); }
      }
    }
  }

  return paths;
}

function getFileDiff(filePath: string, cwd: string): string {
  const relPath = makeRelPath(filePath, cwd);

  const check = spawnSync(`git`, [`cat-file`, `-e`, `HEAD:${relPath}`], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const isTracked = check.status === 0;

  let raw: Buffer;
  if (isTracked) {
    raw = spawnSync(`git`, [`diff`, `HEAD`, `--`, relPath], {
      cwd,
      maxBuffer: 1024 * 64,
      stdio: ["ignore", "pipe", "pipe"],
    }).stdout;
  } else {
    raw = spawnSync(`git`, [`diff`, `--no-index`, `/dev/null`, relPath], {
      cwd,
      maxBuffer: 1024 * 64,
      stdio: ["ignore", "pipe", "pipe"],
    }).stdout;
  }

  return (raw || "").toString().trim();
}

function computeWorkerDiffs(output: string, cwd: string, ctx?: any): string {
  const filePaths = extractFilePaths(output);
  const parts: string[] = [];

  for (const filePath of filePaths) {
    try {
      const relPath = makeRelPath(filePath, cwd);
      const absPath = path.resolve(cwd, relPath);

      // Read original content from git
      const showResult = spawnSync(`git`, [`show`, `HEAD:${relPath}`], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const isTracked = showResult.status === 0;
      const originalContent = isTracked ? (showResult.stdout || "").toString().trim() : null;

      // Register with filechanges if available
      const fc = (globalThis as any).__pi_filechanges;
      if (fc && ctx) {
        fc.trackFile(ctx, relPath, absPath, originalContent);
      }

      const diff = getFileDiff(filePath, cwd);
      if (diff) {
        parts.push(`### ${filePath}\n\n\`\`\`diff\n${diff}\n\`\`\``);
      }
    } catch {
      // File might have been deleted or path invalid — skip
    }
  }

  return parts.length ? `\n\n## File changes\n\n${parts.join("\n\n")}` : "";
}

// ── Throttle ──────────────────────────────────────────────────────────

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return ((...args: any[]) => {
		const now = Date.now();
		const remaining = ms - (now - lastCall);
		if (remaining <= 0) {
			lastCall = now;
			if (timer) { clearTimeout(timer); timer = undefined; }
			fn(...args);
		} else if (!timer) {
			timer = setTimeout(() => {
				lastCall = Date.now();
				timer = undefined;
				fn(...args);
			}, remaining);
		}
	}) as T;
}

// ── Parallel Execution with Concurrency Limit ─────────────────────────

async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < items.length) {
			const i = nextIndex++;
			results[i] = await fn(items[i], i);
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

// ── Rendering ─────────────────────────────────────────────────────────

type Theme = ExtensionContext["ui"]["theme"];
function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function renderLine(
	text: string,
	expanded: boolean,
	w: number,
): Text {
	return new Text(expanded ? text : truncLine(text, w), 0, 0);
}

function renderAgentProgress(
	r: AgentResult,
	theme: Theme,
	expanded: boolean,
	w: number,
): Container {
	const c = new Container();
	const prog = r.progress;
	const isRunning = prog.status === "running";
	const isPending = prog.status === "pending";

	// Header: icon + agent + stats (always one line, truncated)
	const icon = isRunning
		? theme.fg("warning", "π")
		: isPending
			? theme.fg("dim", "○")
			: r.exitCode === 0
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
	const stats = `${prog.toolCount} tools · ${formatTokens(prog.tokens)} tok · ${formatDuration(prog.durationMs)}`;
	const modelStr = r.model ? theme.fg("dim", ` (${r.model})`) : "";
	c.addChild(
		new Text(
			truncLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelStr} — ${theme.fg("dim", stats)}`, w),
			0, 0,
		),
	);

	// Task
	const taskStr = expanded ? r.task : r.task.replace(/\n/g, " ");
	c.addChild(renderLine(theme.fg("dim", `Task: ${taskStr}`), expanded, w));

	// Current tool (running state)
	if (isRunning && prog.currentTool) {
		const toolLine = prog.currentToolArgs
			? `${prog.currentTool}: ${prog.currentToolArgs}`
			: prog.currentTool;
		c.addChild(renderLine(theme.fg("warning", `▸ ${toolLine}`), expanded, w));
	}

	// Recent tools (always all)
	const toolsToShow = prog.recentTools;
	for (const t of toolsToShow) {
		c.addChild(renderLine(theme.fg("muted", `  ${t.tool}: ${t.args}`), expanded, w));
	}

	// Latest assistant message — the prose "thinking" text, always visible
	if (prog.lastMessage) {
		c.addChild(new Spacer(1));
		c.addChild(renderLine(theme.fg("text", prog.lastMessage), expanded, w));
	}

	// Expanded: full final output
	if (!isRunning && r.output && expanded) {
		c.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		c.addChild(new Markdown(r.output, 0, 0, mdTheme));
	}

	// Usage breakdown
	c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (r.usage.turns) usageParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
	if (r.usage.input) usageParts.push(`in:${formatTokens(r.usage.input)}`);
	if (r.usage.output) usageParts.push(`out:${formatTokens(r.usage.output)}`);
	if (r.usage.cacheRead) usageParts.push(`cR:${formatTokens(r.usage.cacheRead)}`);
	if (r.usage.cacheWrite) usageParts.push(`cW:${formatTokens(r.usage.cacheWrite)}`);
	if (r.usage.cost) usageParts.push(`$${r.usage.cost.toFixed(4)}`);
	if (usageParts.length) {
		c.addChild(new Text(theme.fg("dim", usageParts.join(" · ")), 0, 0));
	}
	

	// Error
	if (prog.error) {
		c.addChild(renderLine(theme.fg("error", `Error: ${prog.error}`), expanded, w));
	}

	return c;
}

// ── Extension ─────────────────────────────────────────────────────────

function emptyResult(agent: string, task: string, model?: string, status: "pending" | "running" = "running"): AgentResult {
	return {
		agent,
		task,
		output: "",
		exitCode: -1,
		model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			agent, task, status,
			recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "",
		},
	};
}

async function executeSingle(
	agentName: string,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	ctx: any,
	onUpdate: any,
): Promise<{ content: any[]; details: Details; isError?: boolean }> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => a.name).join(", ") || "none";
		throw new Error(`Unknown agent: ${agentName}. Available agents: ${available}`);
	}

	const liveResult = emptyResult(agentName, task, agent.model, "running");
	const result = await runSubagent(agent, task, cwd, signal, (progress) => {
		liveResult.progress = progress;
		onUpdate?.({
			content: [{ type: "text", text: "(running...)" }],
			details: { mode: "single" as const, results: [liveResult] },
		});
	}, ctx);

	// Compute post-hoc file diffs for worker subagent results
	if (agent.name === "worker" && result.output) {
		const diffs = computeWorkerDiffs(result.output, cwd, ctx);
		if (diffs) {
			result.output += diffs;
		}
	}

	const isError = result.exitCode !== 0 || !!result.progress.error;
	return {
		content: [{ type: "text", text: result.output || "(no output)" }],
		details: { mode: "single" as const, results: [result] },
		...(isError ? { isError: true } : {}),
	};
}

async function executeParallel(
	taskList: Array<{ agent: string; task: string; cwd?: string }>,
	maxConcurrency: number,
	cwd: string,
	signal: AbortSignal | undefined,
	ctx: any,
	onUpdate: any,
): Promise<{ content: any[]; details: Details }> {
	// Validate all agents
	const available = agents.map((a) => a.name).join(", ") || "none";
	for (const t of taskList) {
		if (!agents.find((a) => a.name === t.agent)) {
			throw new Error(`Unknown agent: ${t.agent}. Available agents: ${available}`);
		}
	}

	const allResults: AgentResult[] = [];

	// Initialize all result slots as pending
	for (let i = 0; i < taskList.length; i++) {
		allResults[i] = emptyResult(taskList[i].agent, taskList[i].task, undefined, "pending");
	}

	const flushParallelUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: `Running ${taskList.length} tasks...` }],
			details: {
				mode: "parallel" as const,
				results: [...allResults],
			},
		});
	};
	const fireParallelUpdate = throttle(flushParallelUpdate, 150);

	const results = await mapConcurrent(taskList, maxConcurrency, async (t, idx) => {
		const agent = agents.find((a) => a.name === t.agent)!;
		const result = await runSubagent(agent, t.task, t.cwd ?? cwd, signal, (progress) => {
			allResults[idx].progress = progress;
			fireParallelUpdate();
		}, ctx);

		// Compute post-hoc file diffs for worker subagent results
		if (agent.name === "worker" && result.output) {
			const diffs = computeWorkerDiffs(result.output, t.cwd ?? cwd, ctx);
			if (diffs) {
				result.output += diffs;
			}
		}

		// Update allResults with the completed result so the UI reflects it immediately
		allResults[idx] = result;
		flushParallelUpdate();

		return result;
	});

	// Build final output text
	const outputParts = results.map((r) => {
		const header = `## ${r.agent}${r.exitCode !== 0 ? " (FAILED)" : ""}`;
		return `${header}\n\n${r.output || "(no output)"}`;
	});

	return {
		content: [{ type: "text", text: outputParts.join("\n\n---\n\n") }],
		details: { mode: "parallel" as const, results },
	};
}

export default function (pi: ExtensionAPI) {
	loadEnv();
	const maxConcurrency = parseInt(process.env.SUBAGENTS_MAX_CONCURRENCY ?? "") || DEFAULT_MAX_CONCURRENCY;
	agents = loadAgents();

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
