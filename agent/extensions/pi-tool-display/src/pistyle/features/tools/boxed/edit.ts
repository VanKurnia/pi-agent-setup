// Boxed edit tool renderer
// (renderCall/renderResult only; no edit-core re-registration).

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
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
import {
    AdaptiveDiffComponent,
    buildSplitRows,
    countDiffStats,
    extractEditedPath,
    firstText,
} from "../../../shared/split-diff.js";
import { isResultSeen } from "./session-config.js";
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
    resultFooterLines,
    stateElapsedMs,
} from "./shared.js";

const MAX_HIGHLIGHT_DIFF_CHARS = 12000;
const MAX_HIGHLIGHT_DIFF_ROWS = 120;

/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_EDIT_RESULT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});

type EditResultDetails = { diff?: string; path?: string } | undefined;

/** Edit footer: elapsed time only. The diff stats live in the box header and
 *  a single edited file is implied, so neither repeats in the footer. */
function editDiffFooter(
    theme: BoxTheme,
    result: { content?: readonly unknown[]; details?: unknown },
    context: BoxedToolContext,
): string {
    const elapsedMs = getElapsedMs(result) ?? stateElapsedMs(context);
    return formatElapsedMetric(theme, elapsedMs);
}

export const editTool: BoxedToolDefinition = {
    call(args, theme, context) {
        noteExecutionStart(context);
        noteBoxedCallState(context);
        const path = displayPath(String(args?.path ?? args?.file_path ?? ""), context);
        return renderBoxedToolCall(theme, "Edit", [], {
            // Lazy: the settled result publishes diff stats into the shared renderer
            // state, and this function resolves at render time — so the header picks
            // up `· +N -M` on the same paint the diff body appears (the write footer
            // uses the same state-sharing contract).
            headerDetail: () => `${path}${diffHeaderStatsSuffix(theme, context)}`,
            isError: Boolean(context.isError),
            isPartial: Boolean(context.isPartial),
            isPending: Boolean(context.isPartial),
            running: Boolean(context.executionStarted),
            resultSeen: isResultSeen(context.state),
        });
    },
    result(result, options, theme, context) {
        // Handle partial/streaming state: continue the open call box with the
        // applying hint (no Response divider until the tool settles).
        if (options.isPartial) {
            const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
            if (firstResultPass) return EMPTY_EDIT_RESULT;
            return renderBoxedToolResult(
                theme,
                () => [`${theme.fg("dim", "↳")} ${theme.fg("muted", "Applying edit...")}`],
                {
                    showDivider: false,
                    footerLines: [formatBoxedRunningStatus(theme, stateElapsedMs(context))],
                    isPartial: true,
                },
            );
        }

        // Handle errors
        if (context.isError) {
            clearDiffHeaderStats(context);
            const output = getTextOutput(result);
            return renderBoxedToolResult(
                theme,
                () => [theme.fg("error", stripAnsi(output).trim() || "Error")],
                {
                    footerLines: resultFooterLines(theme, result, context),
                    isError: true,
                },
            );
        }

        // Extract diff from result details
        const details = result.details as EditResultDetails;
        const diff = details?.diff as string | undefined;

        if (!diff) {
            clearDiffHeaderStats(context);
            const output = stripAnsi(getTextOutput(result)).trim();
            const fallback = `↳ ${output || "Edit applied"}`;
            return renderBoxedToolResult(theme, () => [theme.fg("dim", fallback)], {
                footerLines: resultFooterLines(theme, result, context),
            });
        }

        // Resolve the edited path (cache-key input + language hint source).
        const message = firstText(result.content as Array<{ type: string; text?: string }>);
        const argPath = String(context?.args?.path ?? context?.args?.file_path ?? "");
        const sourcePath = details?.path ?? (argPath || extractEditedPath(message));
        const expanded = options.expanded;
        // Stats feed the header slot and the cache key (cheap line scan — unlike
        // the row/component construction below, which must not run on hits).
        const stats = countDiffStats(diff);
        noteDiffHeaderStats(context, stats);
        const footer = editDiffFooter(theme, result, context);

        return memoizedStateComponent(
            context.state,
            "__piStyleEditDiffResult",
            getRenderCacheKey(
                "edit-diff-result",
                theme,
                Boolean(expanded),
                diff,
                sourcePath ?? "",
                footer,
            ),
            () => {
                // Expensive construction (buildSplitRows + AdaptiveDiffComponent,
                // ~0.4ms for a 160-row diff) runs only on cache misses, never per
                // render pass. Everything below is a pure function of the key inputs.
                const language = sourcePath ? getLanguageFromPath(sourcePath) : undefined;
                const rows = buildSplitRows(diff);
                const shouldHighlight =
                    Boolean(language) &&
                    diff.length <= MAX_HIGHLIGHT_DIFF_CHARS &&
                    rows.length <= MAX_HIGHLIGHT_DIFF_ROWS;

                // Render adaptive diff (unified/split per width) with syntax colors for small outputs.
                const maxRows = expanded ? 160 : 36;
                const diffView = new AdaptiveDiffComponent(
                    theme,
                    rows,
                    maxRows,
                    shouldHighlight ? language : undefined,
                );
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
                        // Stats live in the box header (`➔ Edit ✓ · path · +N -M`), so no
                        // `Diff` divider: the body continues the open call box directly.
                        showDivider: false,
                        skipLeadingBlank: true,
                        ...(expandHint ? { expandHint } : {}),
                        footerLines: footer ? [footer] : [],
                    },
                );
            },
        );
    },
};

export type { BoxedToolContext };
