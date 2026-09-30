// Boxed quick-edit / substitute-edit / target-edit renderer.

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../../shared/ansi.js";
import {
	type BoxTheme,
	formatBoxedRunningStatus,
	formatElapsedMetric,
	getTextOutput,
	renderBoxedToolCall,
	renderBoxedToolResult,
} from "../../../shared/box.js";
import { getElapsedMs } from "../../../shared/elapsed.js";
import { AdaptiveDiffComponent, buildSplitRows, countDiffStats } from "../../../shared/split-diff.js";
import { getStateElapsedMs, isResultSeen } from "./session-config.js";
import {
	type BoxedToolContext,
	type BoxedToolDefinition,
	clearDiffHeaderStats,
	diffHeaderStatsSuffix,
	displayPath,
	getRenderCacheKey,
	memoizedStateComponent,
	noteBoxedCallState,
	noteBoxedResultPhase,
	noteDiffHeaderStats,
	noteExecutionStart,
	stateElapsedMs,
} from "./shared.js";

const MAX_HIGHLIGHT_DIFF_CHARS = 12000;
const MAX_HIGHLIGHT_DIFF_ROWS = 120;

/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_QUICK_EDIT_RESULT = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

interface QuickEditToolConfig {
	toolLabel: string;
	applyingLabel: string;
	fallbackLabel: string;
}

const QUICK_EDIT_TOOLS: Readonly<Record<string, QuickEditToolConfig>> = {
	quick_edit: {
		toolLabel: "Quick Edit",
		applyingLabel: "quick-edit",
		fallbackLabel: "Quick edit applied",
	},
	substitute_edit: {
		toolLabel: "Substitute Edit",
		applyingLabel: "substitute-edit",
		fallbackLabel: "Substitute edit applied",
	},
	target_edit: {
		toolLabel: "Target Edit",
		applyingLabel: "target-edit",
		fallbackLabel: "Target edit applied",
	},
};

export function getQuickEditToolConfig(toolName: unknown): QuickEditToolConfig | undefined {
	return typeof toolName === "string" ? QUICK_EDIT_TOOLS[toolName] : undefined;
}

/**
 * Parse the `── diff ──` section of a quick-edit-family output text into a
 * synthetic unified diff (exported for the turn-summary registry, which
 * derives diff stats from session content without a renderer).
 */
export function extractQuickEditDiff(text: string): string | undefined {
	const lines = stripAnsi(text).replace(/\r/g, "").split("\n");
	const start = lines.indexOf("── diff ──");
	if (start < 0) return undefined;

	const diffLines: string[] = [];
	let cumulativeDelta = 0;
	let oldLine: number | undefined;
	let newLine: number | undefined;
	let chunkAdditions = 0;
	let chunkRemovals = 0;

	const finishChunk = () => {
		cumulativeDelta += chunkAdditions - chunkRemovals;
		oldLine = undefined;
		newLine = undefined;
		chunkAdditions = 0;
		chunkRemovals = 0;
	};

	for (const line of lines.slice(start + 1)) {
		if (line === "") {
			finishChunk();
			continue;
		}

		const headerMatch = line.match(/^:(\d+)(?:-\d+)?$/);
		if (headerMatch) {
			finishChunk();
			const startLine = Number.parseInt(headerMatch[1] ?? "", 10);
			oldLine = startLine;
			newLine = startLine + cumulativeDelta;
			continue;
		}

		const match = line.match(/^([+-]) (.*)$/);
		if (match) {
			const [, sign, content = ""] = match;
			let gutter = "";
			if (sign === "-" && oldLine !== undefined) gutter = String(oldLine++);
			if (sign === "+" && newLine !== undefined) gutter = String(newLine++);
			if (!gutter) continue;
			if (sign === "-") chunkRemovals++;
			if (sign === "+") chunkAdditions++;
			diffLines.push(`${sign} ${gutter} ${content}`);
			continue;
		}

		if (line === "---") break;
	}

	return diffLines.length > 0 ? diffLines.join("\n") : undefined;
}

/** Quick-edit footer: elapsed time only. The diff stats live in the box
 *  header and a single edited file is implied, so neither repeats there. */
function quickEditDiffFooter(
	theme: BoxTheme,
	result: { content?: readonly unknown[]; details?: unknown },
	context: BoxedToolContext,
): string {
	const elapsedMs = getElapsedMs(result) ?? getStateElapsedMs(context.state);
	return formatElapsedMetric(theme, elapsedMs);
}

function renderQuickEditResult(
	_toolName: string,
	result: { content?: readonly unknown[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
	config: QuickEditToolConfig,
) {
	if (options.isPartial) {
		const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
		if (firstResultPass) return EMPTY_QUICK_EDIT_RESULT;
		return renderBoxedToolResult(
			theme,
			() => [`${theme.fg("dim", "↳")} ${theme.fg("muted", `Applying ${config.applyingLabel}...`)}`],
			{ showDivider: false, footerLines: [formatBoxedRunningStatus(theme, stateElapsedMs(context))], isPartial: true },
		);
	}

	const output = getTextOutput(result);
	if (context.isError) {
		clearDiffHeaderStats(context);
		const footer = quickEditFooter(theme, context);
		return renderBoxedToolResult(theme, () => [theme.fg("error", stripAnsi(output).trim() || "Error")], {
			...(footer ? { footerLines: [footer] } : {}),
			isError: true,
		});
	}

	const diff = extractQuickEditDiff(output);
	if (!diff) {
		clearDiffHeaderStats(context);
		const fallback = stripAnsi(output).trim() || config.fallbackLabel;
		const footer = quickEditFooter(theme, context);
		return renderBoxedToolResult(theme, () => [`${theme.fg("dim", "↳")} ${theme.fg("muted", fallback)}`], {
			...(footer ? { footerLines: [footer] } : {}),
		});
	}

	const expanded = options.expanded;
	const argPath = String(context?.args?.path ?? "");
	// Stats feed the header slot and the cache key (cheap line scan — unlike
	// the row/component construction below, which must not run on hits).
	const stats = countDiffStats(diff);
	noteDiffHeaderStats(context, stats);
	const footer = quickEditDiffFooter(theme, result, context);

	return memoizedStateComponent(
		context.state,
		"__piStyleQuickEditDiffResult",
		getRenderCacheKey("quick-edit-diff-result", theme, config.toolLabel, Boolean(expanded), diff, argPath, footer),
		() => {
			// Expensive construction (buildSplitRows + AdaptiveDiffComponent) runs
			// only on cache misses, never per render pass. Everything below is a
			// pure function of the key inputs.
			const rows = buildSplitRows(diff);
			const language = argPath ? getLanguageFromPath(argPath) : undefined;
			const shouldHighlight =
				Boolean(language) && diff.length <= MAX_HIGHLIGHT_DIFF_CHARS && rows.length <= MAX_HIGHLIGHT_DIFF_ROWS;

			const maxRows = expanded ? 160 : 36;
			const diffView = new AdaptiveDiffComponent(theme, rows, maxRows, shouldHighlight ? language : undefined);
			const expandHint = !expanded && diffView.hasCollapsed() ? "Ctrl+O more" : undefined;

			return renderBoxedToolResult(
				theme,
				{
					render(width: number): string[] {
						return diffView.render(width);
					},
					invalidate(): void {
						diffView.invalidate();
					},
				},
				{
					// Stats live in the box header (`➔ Quick Edit ✓ · path · +N -M`),
					// so no `Diff` divider: the body continues the open call box directly.
					showDivider: false,
					skipLeadingBlank: true,
					...(expandHint ? { expandHint } : {}),
					footerLines: footer ? [footer] : [],
				},
			);
		},
	);
}

function quickEditFooter(theme: BoxTheme, context: BoxedToolContext): string {
	const elapsedMs = getStateElapsedMs(context.state);
	return formatElapsedMetric(theme, elapsedMs);
}

export function quickEditTool(config: QuickEditToolConfig): BoxedToolDefinition {
	return {
		call(args, theme, context) {
			noteExecutionStart(context);
			noteBoxedCallState(context);
			const path = displayPath(String(args?.path ?? ""), context);
			return renderBoxedToolCall(theme, config.toolLabel, [], {
				// Lazy: the settled result publishes diff stats into the shared renderer
				// state, and this function resolves at render time — so the header picks
				// up `· +N -M` on the same paint the diff body appears.
				headerDetail: () => `${path}${diffHeaderStatsSuffix(theme, context)}`,
				isError: Boolean(context.isError),
				isPartial: Boolean(context.isPartial),
				isPending: Boolean(context.isPartial),
				running: Boolean(context.executionStarted),
				resultSeen: isResultSeen(context.state),
			});
		},
		result(result, options, theme, context) {
			return renderQuickEditResult(config.toolLabel, result, options, theme, context, config);
		},
	};
}
