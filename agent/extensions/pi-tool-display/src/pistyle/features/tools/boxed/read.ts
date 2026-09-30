// Boxed read tool renderer
// (renderCall/renderResult only; no tool re-registration).
//
// Read calls render boxless: a lone read is a single inline line
// (`➔ Read <path>`), consecutive reads group into one tree panel (see
// batch.ts).

import { stripAnsi } from "../../../shared/ansi.js";
import { getTextOutput } from "../../../shared/box.js";
import {
	type BatchToolMeta,
	EMPTY_BATCH_COMPONENT,
	emptyBatchResult,
	registerBatchCall,
	registerBatchResult,
	renderBatchAwareCall,
} from "./batch.js";
import { type BoxedToolDefinition, noteExecutionStart, pathRangeDetail } from "./shared.js";

const READ_META: BatchToolMeta = Object.freeze({
	toolName: "read",
	label: "Read",
});

export const readTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const rawPath = String(args?.path ?? args?.file_path ?? "");
		const detail = pathRangeDetail(rawPath, args?.offset, args?.limit, context);
		const { isLeader, batch } = registerBatchCall(READ_META, detail, context);
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return renderBatchAwareCall(theme, batch);
	},
	result(result, options, _theme, context) {
		// The strip is only needed for error text — keep it off the success path
		// (result renderers re-fire on every repaint/scroll).
		const errorText = context.isError ? stripAnsi(getTextOutput(result)).trimEnd() || undefined : undefined;
		registerBatchResult(
			READ_META,
			{
				isPartial: Boolean(options.isPartial),
				isError: Boolean(context.isError),
				errorText,
			},
			context,
		);
		return emptyBatchResult();
	},
};
