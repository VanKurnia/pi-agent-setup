/**
 * Boxed card for db-viewer's query tools (fork addition — not vendored pi-style).
 *
 * db-viewer ships only a `renderResult` (a markdown box table) for these tools and
 * this fork's renderer patch bypasses it: without this card they fall to the
 * generic fallback, which loses the table look and prints every argument —
 * including the credentials inside `connectionString`.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type Component } from "@earendil-works/pi-tui";
import {
    type BoxTheme,
    formatMetricParts,
    getTextOutput,
    renderBoxedToolCall,
    renderBoxedToolResult,
} from "./pistyle/shared/box.js";
import {
    type BoxedToolContext,
    type BoxedToolResult,
    displayPath,
    noteBoxedCallState,
    noteBoxedResultPhase,
    noteExecutionStart,
    stateElapsedMs,
} from "./pistyle/features/tools/boxed/shared.js";
import { isResultSeen } from "./pistyle/features/tools/boxed/session-config.js";

/** db-viewer tool name → card title (mirrors the label on its tool definitions). */
const DB_QUERY_TOOL_LABELS: Record<string, string> = {
    query_sqlite: "Query SQLite",
    query_mysql: "Query MySQL",
};

/** SQL lines shown on a collapsed call card; expanding the block reveals the rest. */
const COLLAPSED_QUERY_LINES = 5;
/** Mirrors `COLLAPSED_LINES` in agent/extensions/shared/markdown.ts. */
const COLLAPSED_MARKDOWN_LINES = 10;

/** True for the db-viewer tools this card owns. */
export function isDbQueryTool(toolName: unknown): toolName is string {
    return typeof toolName === "string" && Object.hasOwn(DB_QUERY_TOOL_LABELS, toolName);
}

/**
 * Strip the password out of a connection URI before it reaches the card:
 * `mysql://user:pw@host:3306/db` → `mysql://user:***@host:3306/db`. User, host
 * and database stay (they say *which* database was queried); anything that does
 * not look like a URI is returned unchanged. The userinfo/host split is the last
 * `@` — inside the authority when the URI is well formed, and the last one in the
 * URI otherwise — so a password containing `@`, `/`, `?` or `#` is masked instead
 * of returned raw.
 */
export function redactConnectionTarget(raw: string): string {
    const uri = raw.trim();
    const schemeEnd = uri.indexOf("://");
    if (schemeEnd <= 0) return uri;

    const userinfoStart = schemeEnd + 3;
    const pathStart = uri.slice(userinfoStart).search(/[/?#]/);
    const authorityEnd = pathStart < 0 ? uri.length : userinfoStart + pathStart;
    const inAuthority = uri.lastIndexOf("@", authorityEnd);
    const at = inAuthority >= userinfoStart ? inAuthority : uri.lastIndexOf("@");
    if (at <= userinfoStart) return uri;

    const colon = uri.indexOf(":", userinfoStart);
    if (colon < 0 || colon > at) return uri; // no password to hide

    return `${uri.slice(0, userinfoStart)}${uri.slice(userinfoStart, colon)}:***${uri.slice(at)}`;
}

/** Card header target: the redacted connection URI, or the sqlite file path. */
function callTarget(args: Record<string, unknown>, context: BoxedToolContext): string | undefined {
    const connection = args?.connectionString;
    if (typeof connection === "string" && connection.trim()) {
        return redactConnectionTarget(connection);
    }
    const dbPath = args?.dbPath;
    if (typeof dbPath === "string" && dbPath.trim()) {
        return displayPath(dbPath, context);
    }
    return undefined;
}

export function renderDbQueryCall(
    toolName: string,
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteExecutionStart(context);
    noteBoxedCallState(context);

    const queryLines = (typeof args?.query === "string" ? args.query : "")
        .replace(/\r/g, "")
        .split("\n");
    const shownLines = context.expanded
        ? queryLines.length
        : Math.min(queryLines.length, COLLAPSED_QUERY_LINES);
    const detailLines: string[] = [];
    for (let index = 0; index < shownLines; index++) {
        const prefix = index === 0 ? "> " : "  ";
        detailLines.push(`${theme.fg("dim", prefix)}${queryLines[index] ?? ""}`);
    }
    if (queryLines.length > shownLines) {
        detailLines.push(theme.fg("muted", `... ${queryLines.length - shownLines} more lines`));
    }

    const maxRows = args?.maxRows;
    if (typeof maxRows === "number" && Number.isFinite(maxRows)) {
        detailLines.push(`${theme.fg("dim", "Max rows: ")}${Math.floor(maxRows)}`);
    }

    return renderBoxedToolCall(theme, DB_QUERY_TOOL_LABELS[toolName], detailLines, {
        headerDetail: callTarget(args, context),
        isError: context.isError,
        isPartial: context.isPartial,
        isPending: context.isPartial,
        running: context.executionStarted,
        resultSeen: isResultSeen(context.state),
    });
}

/**
 * db-viewer's result look: pi's Markdown renderer (box tables) with the same
 * 10-line collapse. Errors and empty output stay plain text, as upstream.
 */
function markdownRows(
    text: string,
    expanded: boolean,
    isError: boolean,
): (width: number) => string[] {
    return (width) => {
        if (isError || !text.trim()) return new Text(text, 0, 0).render(width);
        const lines = new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
        if (expanded || lines.length <= COLLAPSED_MARKDOWN_LINES) return lines;
        const remaining = lines.length - COLLAPSED_MARKDOWN_LINES;
        return [
            ...lines.slice(0, COLLAPSED_MARKDOWN_LINES),
            `... (${remaining} more lines, expand)`,
        ];
    };
}

/** Data rows in a `formatRowsToMarkdown` table (header and separator are not rows). */
function countTableRows(text: string): number | undefined {
    let tableLines = 0;
    let separatorSeen = false;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) continue;
        tableLines++;
        if (/^\|[\s:|-]+$/.test(trimmed)) separatorSeen = true;
    }
    return separatorSeen && tableLines >= 2 ? tableLines - 2 : undefined;
}

/** `elapsed · N rows` — the word-count metric would be noise for a table. */
function dbFooter(theme: BoxTheme, context: BoxedToolContext, rows: number | undefined): string {
    const elapsedMs = stateElapsedMs(context);
    const elapsed =
        elapsedMs === undefined
            ? theme.fg("dim", "--")
            : formatMetricParts(theme, (elapsedMs / 1000).toFixed(2), "s");
    if (rows === undefined) return elapsed;
    return `${elapsed}${theme.fg("dim", " · ")}${theme.fg("dim", `${rows} ${rows === 1 ? "row" : "rows"}`)}`;
}

export function renderDbQueryResult(
    result: BoxedToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteBoxedResultPhase(context, options.isPartial);

    const isError = context.isError;
    const text = getTextOutput(result);
    return renderBoxedToolResult(theme, markdownRows(text, options.expanded, isError), {
        dividerLabel: "Rows",
        footerLines: [dbFooter(theme, context, countTableRows(text))],
        isError,
        isPartial: options.isPartial,
    });
}
