
import * as os from "node:os";
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentResult } from "./types.js";
import { formatDuration, formatTokens, truncLine } from "./utils.js";

type Theme = ExtensionContext["ui"]["theme"];
function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function shortenPath(p: string): string {
	const home = os.homedir().replace(/\\/g, "/");
	const normalized = p.replace(/\\/g, "/");
	return normalized.startsWith(home) ? `~${normalized.slice(home.length)}` : p;
}

function tryParseJson(s: string): Record<string, unknown> | null {
	try { return JSON.parse(s); } catch { return null; }
}

/**
 * Format a tool call for display in the subagent UI.
 *
 * Accepts:
 * - A plain preview string (our ToolEvent.args format from extractToolArgsPreview)
 * - A JSON string (will be parsed for richer formatting)
 * - An object (full args, as used in the reference implementation)
 */
export function formatToolCall(
	toolName: string,
	args: Record<string, unknown> | string,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	// Resolve the preview text from whatever argument format we receive
	let previewText: string;
	if (typeof args === "string") {
		const parsed = tryParseJson(args);
		previewText = parsed ? extractPreviewText(toolName, parsed) : shortenPath(args);
	} else {
		previewText = extractPreviewText(toolName, args);
	}

	// Truncate long previews
	if (previewText.length > 80) {
		previewText = previewText.slice(0, 80) + "...";
	}

	switch (toolName) {
		case "bash":
			return themeFg("muted", "$ ") + themeFg("toolOutput", previewText);
		case "read":
			return themeFg("muted", "read ") + themeFg("accent", previewText);
		case "write":
			return themeFg("muted", "write ") + themeFg("accent", previewText);
		case "edit":
			return themeFg("muted", "edit ") + themeFg("accent", previewText);
		case "ls":
			return themeFg("muted", "ls ") + themeFg("accent", previewText);
		case "find":
		case "fffind":
			return themeFg("muted", "find ") + themeFg("accent", previewText);
		case "grep":
		case "ffgrep":
			return themeFg("muted", "grep ") + themeFg("accent", previewText);
		default:
			return themeFg("accent", toolName) + themeFg("dim", ` ${previewText}`);
	}
}

/**
 * Extract a human-readable preview text from a full args object.
 * Mirrors extractToolArgsPreview in process.ts for backward compat.
 */
function extractPreviewText(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
			return String(args.command || args.cmd || "...");
		case "read": {
			const filePath = String(args.file_path || args.path || "...");
			const offset = args.offset != null ? Number(args.offset) : undefined;
			const limit = args.limit != null ? Number(args.limit) : undefined;
			let text = shortenPath(filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return text;
		}
		case "write": {
			const filePath = String(args.file_path || args.path || "...");
			const content = String(args.content || "");
			const lines = content.split("\n").length;
			let text = shortenPath(filePath);
			if (lines > 1) text += ` (${lines} lines)`;
			return text;
		}
		case "edit":
			return shortenPath(String(args.file_path || args.path || "..."));
		case "ls":
			return shortenPath(String(args.path || args.dir || "."));
		case "find":
		case "fffind":
			return `${String(args.pattern || args.query || "*")} in ${shortenPath(String(args.path || args.dir || "."))}`;
		case "grep":
		case "ffgrep":
			return `/${String(args.pattern || args.query || "")}/ in ${shortenPath(String(args.path || args.dir || "."))}`;
		default:
			return JSON.stringify(args);
	}
}

function renderLine(
	text: string,
	expanded: boolean,
	w: number,
): Text {
	return new Text(expanded ? text : truncLine(text, w), 0, 0);
}

export function renderAgentProgress(
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
		? theme.fg("warning", "")
		: isPending
			? theme.fg("dim", "󱦟")
			: r.exitCode === 0
				? theme.fg("success", "")
				: theme.fg("error", "");
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
		const toolLine = prog.currentToolArgs || prog.currentToolArgsObj
			? formatToolCall(prog.currentTool, prog.currentToolArgsObj ?? prog.currentToolArgs ?? "", theme.fg.bind(theme))
			: prog.currentTool;
		c.addChild(renderLine(theme.fg("warning", `▸ ${toolLine}`), expanded, w));
	}

	// Recent tools (always all)
	const toolsToShow = prog.recentTools;
	for (const t of toolsToShow) {
		c.addChild(renderLine(
			theme.fg("muted", "  ") + formatToolCall(t.tool, t.argsObj ?? t.args, theme.fg.bind(theme)),
			expanded, w,
		));
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

export { getTermWidth };
