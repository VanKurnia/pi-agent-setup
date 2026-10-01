/**
 * Bridge between this extension and the vendored pi-style boxed renderers
 * (src/pistyle/). It normalizes the extension's config, the theme, and Pi's
 * untyped renderer arguments, so the ported renderers stay unmodified apart
 * from dead-code removal.
 */
import type { BoxTheme } from "./pistyle/shared/box.js";
import type { BoxedToolContext } from "./pistyle/features/tools/boxed/shared.js";
import {
    renderBoxedToolCall,
    renderBoxedToolResult,
} from "./pistyle/features/tools/boxed/index.js";
import { setToolsRenderConfig } from "./pistyle/features/tools/boxed/session-config.js";
import { setFullTheme } from "./pistyle/shared/theme-extras.js";
import {
    renderFallbackCall,
    renderFallbackResult,
} from "./pistyle/features/tools/boxed/fallback.js";
import { isDbQueryTool, renderDbQueryCall, renderDbQueryResult } from "./db-query-card.js";
import { resetBashTreeRegistry } from "./pistyle/features/tools/boxed/bash.js";
import { resetBatchRegistry } from "./pistyle/features/tools/boxed/batch.js";
import { resetGrepRegistry } from "./pistyle/features/tools/boxed/grep.js";
import { resetTurnRegistry } from "./pistyle/features/tools/boxed/turn-summary.js";
import type { ToolDisplayConfig } from "./types.js";

/** Tools with a dedicated pi-style boxed renderer; powershell shares bash's arguments. */
const DEDICATED_TOOLS = new Set(["read", "write", "edit", "bash"]);

/** Resolves the dedicated renderer name for a tool, or undefined for the boxed fallback card. */
function dedicatedToolName(toolName: unknown): string | undefined {
    if (typeof toolName !== "string") {
        return undefined;
    }
    const name = toolName === "powershell" ? "bash" : toolName;
    return DEDICATED_TOOLS.has(name) ? name : undefined;
}

/** Result shape shared by the boxed and fallback result renderers. */
interface BoxedResult {
    content?: readonly unknown[];
    details?: unknown;
}

interface BoxedResultOptions {
    expanded: boolean;
    isPartial: boolean;
}

let syncedPreviewLines = -1;
let syncedExpandedMaxLines = -1;
let syncedCollapseAfterTurn = -1;
let syncedNerdFonts = -1;
let primedTheme: unknown;

/**
 * pi-style keeps per-call panel registries that its own session coordinator
 * resets; this port drives them from the extension's session lifecycle.
 */
export function resetPistyleRegistries(): void {
    resetGrepRegistry();
    resetBatchRegistry();
    resetBashTreeRegistry();
    resetTurnRegistry();
    syncedPreviewLines = -1;
    syncedExpandedMaxLines = -1;
    syncedCollapseAfterTurn = -1;
    syncedNerdFonts = -1;
    primedTheme = undefined;
}

export function syncPistyleRenderConfig(config: ToolDisplayConfig): void {
    const nerdFonts = process.env.ZENTUI_NERD_FONTS !== "0" ? 1 : 0;
    const collapseAfterTurn = config.collapseAfterTurn ? 1 : 0;
    if (
        config.previewLines === syncedPreviewLines &&
        config.expandedPreviewMaxLines === syncedExpandedMaxLines &&
        collapseAfterTurn === syncedCollapseAfterTurn &&
        nerdFonts === syncedNerdFonts
    ) {
        return;
    }
    syncedPreviewLines = config.previewLines;
    syncedExpandedMaxLines = config.expandedPreviewMaxLines;
    syncedCollapseAfterTurn = collapseAfterTurn;
    syncedNerdFonts = nerdFonts;

    setToolsRenderConfig({
        maxCollapsedLines: config.previewLines,
        maxExpandedLines: config.expandedPreviewMaxLines,
        nerdFonts: nerdFonts === 1,
        batchOpenGlyph: nerdFonts === 1 ? "\u{F111}" : "●",
        collapseAfterTurn: collapseAfterTurn === 1,
    });
}

/** Theme extras are cache-guarded inside pi-style; only re-prime on a new theme instance. */
function primeTheme(theme: unknown): void {
    if (primedTheme === theme) {
        return;
    }
    primedTheme = theme;
    setFullTheme(theme);
}

export function renderPistyleToolCall(
    toolName: unknown,
    args: Record<string, unknown>,
    theme: unknown,
    context: unknown,
    config: ToolDisplayConfig,
): unknown {
    syncPistyleRenderConfig(config);
    primeTheme(theme);
    const boxTheme = theme as BoxTheme;
    const boxedContext = context as BoxedToolContext;
    // db-viewer's query tools get the fork-owned card (redacted target, SQL preview).
    if (isDbQueryTool(toolName)) {
        return renderDbQueryCall(toolName, args, boxTheme, boxedContext);
    }
    const name = dedicatedToolName(toolName);
    if (!name) {
        return renderFallbackCall(toolName, args, boxTheme, boxedContext);
    }
    return renderBoxedToolCall(name, args, boxTheme, boxedContext);
}

export function renderPistyleToolResult(
    toolName: unknown,
    result: unknown,
    options: unknown,
    theme: unknown,
    context: unknown,
    config: ToolDisplayConfig,
): unknown {
    syncPistyleRenderConfig(config);
    primeTheme(theme);
    const boxTheme = theme as BoxTheme;
    const boxedContext = context as BoxedToolContext;
    const boxedOptions = options as BoxedResultOptions;
    const boxedResult = result as BoxedResult;
    if (isDbQueryTool(toolName)) {
        return renderDbQueryResult(boxedResult, boxedOptions, boxTheme, boxedContext);
    }
    const name = dedicatedToolName(toolName);
    if (!name) {
        return renderFallbackResult(toolName, boxedResult, boxedOptions, boxTheme, boxedContext);
    }
    return renderBoxedToolResult(name, boxedResult, boxedOptions, boxTheme, boxedContext);
}
