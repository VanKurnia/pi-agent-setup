// Boxed find tool renderer.
//
// find calls render as a boxless tree panel — a lone find shows its parsed
// output as a flat `Find: <pattern> <N> files · in <path>` tree; consecutive
// find calls group into one panel with per-member nested subtrees (see
// batch.ts). Pending/failed calls without output fall back to a path row.

import { stripAnsi } from "../../../shared/ansi.js";
import { getTextOutput, shortenPath } from "../../../shared/box.js";
import {
	type BatchToolMeta,
	EMPTY_BATCH_COMPONENT,
	emptyBatchResult,
	hasFinalBatchOutput,
	registerBatchCall,
	registerBatchResult,
	renderBatchAwareCall,
} from "./batch.js";
import { parseFindOutput } from "./output-tree.js";
import { type BoxedToolDefinition, noteExecutionStart } from "./shared.js";

const FIND_META: BatchToolMeta = Object.freeze({
	toolName: "find",
	label: "Find",
	headerLabel: "Find",
});

function pathLabel(rawPath: string): string {
	const displayPath = String(rawPath ?? ".");
	return displayPath === "." || displayPath === "" ? "current directory" : shortenPath(displayPath);
}

function queryDetail(pattern: string, rawPath: string): string {
	const path = pathLabel(rawPath);
	return pattern ? `${pattern} in ${path}` : path;
}

export const findTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const pattern = String(args?.pattern ?? "");
		const rawPath = String(args?.path ?? ".");
		const detail = queryDetail(pattern, rawPath);
		const { isLeader, batch } = registerBatchCall(FIND_META, detail, context, {
			pattern,
			pathLabel: pathLabel(rawPath),
		});
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return renderBatchAwareCall(theme, batch);
	},
	result(result, options, _theme, context) {
		const isError = Boolean(context.isError);
		// Result renderers re-fire on every repaint/scroll; once the final output
		// is parsed and registered, skip stripping/parsing the same text again.
		const settled = !options.isPartial && !isError && hasFinalBatchOutput(context.toolCallId);
		const output = settled ? "" : stripAnsi(getTextOutput(result)).trimEnd();
		const entries = settled || isError ? undefined : parseFindOutput(output);
		registerBatchResult(
			FIND_META,
			{
				isPartial: Boolean(options.isPartial),
				isError,
				errorText: isError ? output || undefined : undefined,
				...(entries !== undefined ? { entries } : {}),
			},
			context,
		);
		return emptyBatchResult();
	},
};
