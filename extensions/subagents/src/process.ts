
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentProgress, AgentResult, SubagentEvent } from "./types.js";
import { KNOWN_EVENT_TYPES } from "./types.js";
import { resolvePiBinary } from "./config.js";
import { relayOrLog } from "./ipc.js";
import { throttle } from "./utils.js";

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

	// Pass tools list so the model knows which tools are available
	if (agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	} else {
		args.push("--no-tools");
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

export async function runSubagent(
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
