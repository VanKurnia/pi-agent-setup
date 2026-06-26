import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Details, AgentScope } from "./src/types.js";
import { formatDuration, formatTokens, truncLine } from "./src/utils.js";
import { getTermWidth, renderAgentProgress } from "./src/ui.js";
import { type Static } from "typebox";
import { SubagentParams } from "./register.js";

export function renderSubagentToolCall(args: Static<typeof SubagentParams>, theme: any): Text {
	const scope: AgentScope = (args.agentScope ?? "user") as AgentScope;
	const scopeText = scope !== "user" ? theme.fg("warning", ` [${scope}]`) : "";

	if (args.chain && args.chain.length > 0) {
		const agentNames = args.chain.map((s: any) => s.agent).join(" → ");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "chain")} ${theme.fg("dim", `(${args.chain.length} steps: ${agentNames})`)}${scopeText}`,
			0, 0,
		);
	}
	if (args.tasks && args.tasks.length > 0) {
		const agentNames = args.tasks.map((t: any) => t.agent).join(", ");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks: ${agentNames})`)}${scopeText}`,
			0, 0,
		);
	}
	if (args.agent) {
		const taskPreview = args.task
			? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task).replace(/\n/g, " ")
			: "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}${scopeText}`,
			0, 0,
		);
	}
	return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
}

export function renderSubagentToolResult(result: any, options: any, theme: any): Container | Text {
	const details = result.details as Details | undefined;
	if (!details?.results?.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		return new Text(text.slice(0, 200), 0, 0);
	}

	const w = getTermWidth() - 4;
	const expanded = options?.expanded;
	const c = new Container();

	if (details.mode === "chain") {
		// Chain summary header
		const ok = details.results.filter((r) => r.exitCode === 0).length;
		const failed = details.results.filter((r) => r.exitCode !== 0).length;
		const totalIcon = failed === 0
			? theme.fg("success", "")
			: theme.fg("error", "");

		c.addChild(
			new Text(
				truncLine(
					`${totalIcon} ${theme.fg("toolTitle", theme.bold("chain"))} ${ok}/${details.results.length} steps`,
					w,
				),
				0, 0,
			),
		);
		c.addChild(new Spacer(1));

		for (let i = 0; i < details.results.length; i++) {
			const r = details.results[i];
			// Step header
			const stepIcon = r.exitCode === 0
				? theme.fg("success", "")
				: r.progress?.status === "running"
					? theme.fg("warning", "󱦟")
					: theme.fg("error", "");
			c.addChild(
				new Text(
					truncLine(`${stepIcon} ${theme.fg("accent", `Step ${r.step ?? i + 1}: ${r.agent}`)}`, w),
					0, 0,
				),
			);
			c.addChild(renderAgentProgress(r, theme, expanded, w));
			if (i < details.results.length - 1) c.addChild(new Spacer(1));
		}
	} else if (details.mode === "parallel") {
		// Parallel summary header
		const ok = details.results.filter((r) => r.exitCode === 0).length;
		const running = details.results.filter((r) => r.progress?.status === "running").length;
		const totalIcon = running > 0
			? theme.fg("warning", "󱦟")
			: ok === details.results.length
				? theme.fg("success", "")
				: theme.fg("error", "");

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
}