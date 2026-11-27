/**
 * The tool cards for `web_search` and `web_fetch`, drawn with pi-tui
 * primitives. Registration stays in `index.ts`.
 */

import type { KeybindingHints, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createCachedMarkdownResult } from "../shared/markdown.ts";
import {
    type FetchResult,
    type OutputFormat,
    type QueryProgress,
    type QueryStatus,
    formatByteCount,
    isFileFetchResult,
} from "./types.ts";

// =============================================================================
// TUI Helpers: Search
// =============================================================================

const STATUS_STYLES: Record<QueryStatus, { color: ThemeColor; glyph: string }> = {
    queued: { color: "muted", glyph: "." },
    loading: { color: "accent", glyph: "." },
    done: { color: "success", glyph: "+" },
    error: { color: "error", glyph: "x" },
};

const STATUS_BADGE_TEXT_WIDTH = 9;

export function formatStatusBadge(status: string): string {
    const spacesNeeded = Math.max(0, STATUS_BADGE_TEXT_WIDTH - status.length);
    const spacesBefore = Math.floor(spacesNeeded / 2);
    const spacesAfter = spacesNeeded - spacesBefore;
    return `[ ${" ".repeat(spacesBefore)}${status}${" ".repeat(spacesAfter)} ]`;
}

function truncate(text: string, roomAvailable: number): string {
    if (visibleWidth(text) <= roomAvailable) return text;
    return truncateToWidth(text, Math.max(1, roomAvailable));
}

const GLYPH_COLUMN_WIDTH = 2;

export function renderSearchProgressCard(
    progressByQuery: QueryProgress[] | undefined,
    theme: Pick<Theme, "fg" | "bold">,
    terminalWidth: number,
): string {
    const entries = progressByQuery ?? [];
    const width = Math.max(24, terminalWidth || 80);

    const succeeded = entries.filter((entry) => entry.status === "done").length;
    const failed = entries.filter((entry) => entry.status === "error").length;

    const lines = [
        theme.fg(
            "muted",
            `${succeeded + failed}/${entries.length} done · ok ${succeeded} · err ${failed}`,
        ),
    ];

    for (const entry of entries) {
        const badge = formatStatusBadge(entry.status);
        const style = STATUS_STYLES[entry.status];
        const roomForQuery = width - GLYPH_COLUMN_WIDTH - badge.length - 1;
        const query = truncate(entry.query, Math.max(1, roomForQuery));
        const gapBeforeBadge = Math.max(
            1,
            width - GLYPH_COLUMN_WIDTH - visibleWidth(query) - badge.length,
        );

        lines.push(
            `${theme.fg(style.color, style.glyph)} ${theme.fg("accent", query)}` +
                `${" ".repeat(gapBeforeBadge)}${theme.fg(style.color, badge)}`,
        );
    }

    return lines.join("\n");
}

// =============================================================================
// TUI Helpers: Fetch
// =============================================================================

export type WebFetchRenderDetails = {
    error?: boolean;
    errorText?: string;
    userErrorSummary?: string;
    verbose?: boolean;
    format?: OutputFormat;
    maxChars?: number;
    fetchResult?: FetchResult;
    started?: boolean;
    status?: "connecting" | "waiting" | "loading" | "processing" | "done" | "error";
    progress?: number;
    phase?: string;
    url?: string;
    spinnerTick?: number;
};

export function createWebFetchCallComponent(
    args: Record<string, unknown>,
    theme: Pick<Theme, "fg" | "bold">,
): Text {
    const url = typeof args.url === "string" ? args.url : "...";
    const format = typeof args.format === "string" ? ` [${args.format}]` : "";
    return new Text(
        `${theme.fg("toolTitle", theme.bold("web_fetch"))} ${theme.fg("accent", url)}${theme.fg("dim", format)}`,
        0,
        0,
    );
}

export function createWebFetchResultComponent(
    details: WebFetchRenderDetails | undefined,
    expanded: boolean,
    theme: Pick<Theme, "fg" | "bold">,
    context: KeybindingHints & { state?: Record<string, unknown> },
): Container {
    const container = new Container();
    if (details?.error) {
        const summary = details.userErrorSummary || details.errorText || "Request failed.";
        container.addChild(new Text(theme.fg("error", `✗ ${summary}`), 0, 0));
        return container;
    }

    const result = details?.fetchResult;
    if (!result) {
        container.addChild(new Text(theme.fg("muted", "No preview details available."), 0, 0));
        return container;
    }

    if (isFileFetchResult(result)) {
        const metaParts = [
            formatByteCount(result.fileSize),
            result.contentType,
            `${result.browser}/${result.os}`,
        ].filter(Boolean);
        const meta = metaParts.length > 0 ? ` (${metaParts.join(" · ")})` : "";
        container.addChild(
            new Text(
                `${theme.fg("success", "✓")} ${theme.fg("accent", result.title || result.finalUrl || result.url)}${theme.fg("dim", meta)}`,
                0,
                0,
            ),
        );
        container.addChild(new Spacer(1));
        container.addChild(
            new Text(`${theme.fg("muted", "Saved:")} ${theme.fg("accent", result.filePath)}`, 0, 0),
        );
        return container;
    }

    const metaParts = [
        `${result.wordCount.toLocaleString()} words`,
        details?.format ?? "markdown",
        result.site || undefined,
        `${result.browser}/${result.os}`,
    ].filter(Boolean);
    const meta = metaParts.length > 0 ? ` (${metaParts.join(" · ")})` : "";

    container.addChild(
        new Text(
            `${theme.fg("success", "✓")} ${theme.fg("accent", result.title || result.finalUrl || result.url)}${theme.fg("dim", meta)}`,
            0,
            0,
        ),
    );

    if (expanded) {
        container.addChild(new Spacer(1));
        container.addChild(
            createCachedMarkdownResult(context.state, "__webFetchBody", result.content),
        );
    } else {
        const previewLines = result.content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 4);
        if (previewLines.length > 0) {
            container.addChild(new Spacer(1));
            for (const line of previewLines) {
                container.addChild(new Text(theme.fg("dim", line.slice(0, 120)), 0, 0));
            }
        }
        container.addChild(new Spacer(1));
        container.addChild(
            new Text(
                `${theme.fg("muted", "... (")} ${context.keyHint("app.tools.expand", "to expand full document")} ${theme.fg("muted", ")")}`,
                0,
                0,
            ),
        );
    }

    return container;
}
