import {
    getMarkdownTheme,
    type AgentToolResult,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type Component } from "@earendil-works/pi-tui";

// Matches core's default result collapse (FALLBACK_PREVIEW_LINES in
// tool-execution.js), which custom renderers bypass.
const COLLAPSED_LINES = 10;

/**
 * Render markdown (tables, lists, code, …) exactly like assistant messages.
 * For use inside a tool `renderResult`. Only pass text the extension
 * authored as markdown (never raw command output).
 */
export function createMarkdownResult(markdown: string, expanded = false): Component {
    if (expanded) {
        return new Markdown(markdown, 0, 0, getMarkdownTheme());
    }
    return {
        // No cached state (a fresh Markdown renders per call), so no-op.
        // Required: Component.invalidate() is NOT optional.
        invalidate(): void {},
        render(width: number): string[] {
            const lines = new Markdown(markdown, 0, 0, getMarkdownTheme()).render(width);
            if (lines.length <= COLLAPSED_LINES) return lines;
            const remaining = lines.length - COLLAPSED_LINES;
            return [...lines.slice(0, COLLAPSED_LINES), `... (${remaining} more lines, expand)`];
        },
    };
}

/**
 * Drop-in `renderResult` body for tools whose success text is authored
 * markdown: errors and empty output stay plain text, markdown renders
 * boxed with collapse. Core strips `isError` from the result object, so the
 * flag must come from the render context (4th argument).
 */
export function createToolResultComponent(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    context: { isError: boolean },
): Component {
    const text =
        (result.content.find((c) => c.type === "text") as { text?: string } | undefined)?.text ??
        "";
    if (context.isError || !text.trim()) return new Text(text, 0, 0);
    return createMarkdownResult(text, options.expanded);
}
