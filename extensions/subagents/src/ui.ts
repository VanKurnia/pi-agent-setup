
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentResult } from "./types.js";
import { formatDuration, formatTokens, truncLine } from "./utils.js";

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

export { getTermWidth };
