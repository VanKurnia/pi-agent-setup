/**
 * smart-web-access — unified local web access extension for Pi.
 * Registers `web_search`, `web_fetch`, and `batch_web_fetch`.
 *
 * Heavy dependencies (wreq-js, linkedom, defuddle, mime-types, lodash) are
 * lazily loaded inside execute() handlers so startup cost remains near zero.
 */

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ExtensionAPI,
    getAgentDir,
    getMarkdownTheme,
    keyHint,
    type Theme,
    type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    Markdown,
    Spacer,
    Text,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
    type BatchFetchItemProgress,
    type BatchFetchProgressSnapshot,
    type BatchFetchResult,
    type FetchResult,
    type FetchToolConfig,
    type FingerprintOs,
    type IncludeRepliesOption,
    type OutputFormat,
    type QueryProgress,
    type QueryStatus,
    type WebSearchDetails,
    createBaseFetchToolParameterProperties,
    createBatchFetchToolParameterProperties,
    formatByteCount,
    isFileFetchResult,
    isError,
    resolveFetchToolDefaults,
    searchParametersSchema,
} from "./types.js";

// =============================================================================
// Settings: Fetch
// =============================================================================

const VALID_OS_VALUES = new Set<FingerprintOs>(["windows", "macos", "linux", "android", "ios"]);

interface PiSmartFetchSettings {
    smartFetchVerboseByDefault?: boolean;
    smartFetchDefaultMaxChars?: number;
    smartFetchDefaultTimeoutMs?: number;
    smartFetchDefaultBrowser?: string;
    smartFetchDefaultOs?: FingerprintOs;
    smartFetchDefaultRemoveImages?: boolean;
    smartFetchDefaultIncludeReplies?: IncludeRepliesOption;
    smartFetchDefaultBatchConcurrency?: number;
    smartFetchTempDir?: string;
}

export interface ResolvedPiSmartFetchSettings extends FetchToolConfig {
    verboseByDefault: boolean;
}

/**
 * Read the first alias that holds an acceptable value, so a renamed setting
 * keeps working alongside the current name.
 */
function readSetting<T>(
    source: Record<string, unknown>,
    keys: readonly string[],
    accept: (value: unknown) => value is T,
): T | undefined {
    for (const key of keys) {
        const value = source[key];
        if (accept(value)) return value;
    }
    return undefined;
}

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isPositiveNumber = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isFingerprintOs = (v: unknown): v is FingerprintOs =>
    typeof v === "string" && VALID_OS_VALUES.has(v as FingerprintOs);
const isIncludeReplies = (v: unknown): v is IncludeRepliesOption =>
    typeof v === "boolean" || v === "extractors";

function normalizePiSmartFetchSettings(input: unknown): PiSmartFetchSettings {
    if (!input || typeof input !== "object") return {};
    const source = input as Record<string, unknown>;

    return {
        smartFetchVerboseByDefault: readSetting(
            source,
            ["smartFetchVerboseByDefault", "webFetchVerboseByDefault"],
            isBoolean,
        ),
        smartFetchDefaultMaxChars: readSetting(
            source,
            ["smartFetchDefaultMaxChars", "webFetchDefaultMaxChars"],
            isPositiveNumber,
        ),
        smartFetchDefaultTimeoutMs: readSetting(
            source,
            ["smartFetchDefaultTimeoutMs"],
            isPositiveNumber,
        ),
        smartFetchDefaultBrowser: readSetting(
            source,
            ["smartFetchDefaultBrowser"],
            isNonEmptyString,
        ),
        smartFetchDefaultOs: readSetting(source, ["smartFetchDefaultOs"], isFingerprintOs),
        smartFetchDefaultRemoveImages: readSetting(
            source,
            ["smartFetchDefaultRemoveImages"],
            isBoolean,
        ),
        smartFetchDefaultIncludeReplies: readSetting(
            source,
            ["smartFetchDefaultIncludeReplies"],
            isIncludeReplies,
        ),
        smartFetchDefaultBatchConcurrency: readSetting(
            source,
            ["smartFetchDefaultBatchConcurrency", "webFetchDefaultBatchConcurrency"],
            isPositiveNumber,
        ),
        smartFetchTempDir: readSetting(
            source,
            ["smartFetchTempDir", "webFetchTempDir"],
            isNonEmptyString,
        ),
    };
}

export function resolvePiSmartFetchSettings(
    globalSettings: unknown,
    projectSettings: unknown,
): ResolvedPiSmartFetchSettings {
    const global = normalizePiSmartFetchSettings(globalSettings);
    const project = normalizePiSmartFetchSettings(projectSettings);

    return {
        verboseByDefault:
            project.smartFetchVerboseByDefault ?? global.smartFetchVerboseByDefault ?? false,
        maxChars: project.smartFetchDefaultMaxChars ?? global.smartFetchDefaultMaxChars,
        timeoutMs: project.smartFetchDefaultTimeoutMs ?? global.smartFetchDefaultTimeoutMs,
        browser: project.smartFetchDefaultBrowser ?? global.smartFetchDefaultBrowser,
        os: project.smartFetchDefaultOs ?? global.smartFetchDefaultOs,
        removeImages: project.smartFetchDefaultRemoveImages ?? global.smartFetchDefaultRemoveImages,
        includeReplies:
            project.smartFetchDefaultIncludeReplies ?? global.smartFetchDefaultIncludeReplies,
        batchConcurrency:
            project.smartFetchDefaultBatchConcurrency ?? global.smartFetchDefaultBatchConcurrency,
        tempDir:
            project.smartFetchTempDir ??
            global.smartFetchTempDir ??
            join(tmpdir(), "smart-fetch-pi"),
    };
}

async function readSettingsFile(path: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, "utf-8"));
    } catch {
        return {};
    }
}

export async function loadPiSmartFetchSettings(
    cwd: string,
    agentDir = getAgentDir(),
): Promise<ResolvedPiSmartFetchSettings> {
    const globalSettings = await readSettingsFile(join(agentDir, "settings.json"));
    const projectSettings = await readSettingsFile(join(cwd, ".pi", "settings.json"));
    return resolvePiSmartFetchSettings(globalSettings, projectSettings);
}

// =============================================================================
// Descriptions & UI Constants
// =============================================================================

const toolDescription = [
    "Fetch a URL with browser-grade TLS fingerprinting and extract clean, readable content.",
    "Uses wreq-js for browser-like TLS/HTTP2 impersonation and Defuddle for article extraction.",
    "Returns full metadata plus the extracted document to the agent while keeping the pi history preview brief.",
    "Does NOT execute JavaScript — use a browser automation tool for JS-heavy pages.",
].join(" ");

const batchToolDescription = [
    "Fetch multiple URLs with browser-grade TLS fingerprinting and readable extraction.",
    "Each request accepts the same parameters as web_fetch and fans out with bounded concurrency.",
    "Returns full per-item metadata to the agent and streams compact per-item progress in the pi TUI.",
    "Does NOT execute JavaScript — use a browser automation tool for JS-heavy pages.",
].join(" ");

const SPINNER_INTERVAL_MS = 80;

type WebFetchRenderDetails = {
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

type BatchRenderDetails = {
    verbose?: boolean;
    batchProgress?: BatchFetchProgressSnapshot;
    batchResult?: BatchFetchResult;
    completed?: boolean;
    spinnerTick?: number;
};

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

function formatPercent(value: number | undefined): string {
    if (value === undefined || Number.isNaN(value)) return "";
    const clamped = Math.max(0, Math.min(1, value));
    return `${Math.round(clamped * 100)}%`;
}

function formatBatchItemSummary(item: BatchFetchItemProgress): string {
    const status = item.status === "error" ? "failed" : item.status;
    const percent =
        item.status === "loading" || item.status === "processing"
            ? ` ${formatPercent(item.progress)}`
            : "";
    return `${item.url} -> ${status}${percent}`;
}

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

export function createBatchFetchCallComponent(
    args: Record<string, unknown>,
    theme: Pick<Theme, "fg" | "bold">,
): Text {
    const requests = Array.isArray(args.requests) ? args.requests : [];
    const requestCount = requests.length;
    const countLabel = `${requestCount} URL${requestCount === 1 ? "" : "s"}`;
    const firstUrl =
        requestCount > 0 && typeof requests[0]?.url === "string"
            ? ` -> ${requests[0].url}${requestCount > 1 ? ` (+${requestCount - 1} more)` : ""}`
            : "";
    return new Text(
        `${theme.fg("toolTitle", theme.bold("batch_web_fetch"))} ${theme.fg("accent", countLabel)}${theme.fg("dim", firstUrl)}`,
        0,
        0,
    );
}

export function createWebFetchResultComponent(
    details: WebFetchRenderDetails | undefined,
    expanded: boolean,
    theme: Pick<Theme, "fg" | "bold">,
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
        container.addChild(new Markdown(result.content, 0, 0, getMarkdownTheme()));
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
                `${theme.fg("muted", "... (")} ${keyHint("app.tools.expand", "to expand full document")} ${theme.fg("muted", ")")}`,
                0,
                0,
            ),
        );
    }

    return container;
}

export function createBatchFetchResultComponent(
    details: BatchRenderDetails | undefined,
    expanded: boolean,
    theme: Pick<Theme, "fg" | "bold">,
): Container {
    const container = new Container();
    const summary = details?.batchResult
        ? `${details.batchResult.succeeded}/${details.batchResult.total} succeeded`
        : "Completed";
    const icon =
        details?.batchResult && details.batchResult.failed > 0
            ? theme.fg("warning", "!")
            : theme.fg("success", "✓");

    container.addChild(new Text(`${icon} ${theme.fg("accent", summary)}`, 0, 0));

    const items = details?.batchProgress?.items ?? [];
    if (items.length > 0) {
        container.addChild(new Spacer(1));
        const maxVisible = expanded ? items.length : Math.min(items.length, 5);
        for (const item of items.slice(0, maxVisible)) {
            const mark =
                item.status === "done"
                    ? theme.fg("success", "✓")
                    : item.status === "error"
                      ? theme.fg("error", "✗")
                      : theme.fg("dim", "•");
            container.addChild(
                new Text(`${mark} ${theme.fg("dim", formatBatchItemSummary(item))}`, 0, 0),
            );
        }
        if (!expanded && items.length > maxVisible) {
            container.addChild(
                new Text(
                    theme.fg(
                        "dim",
                        `... +${items.length - maxVisible} more (${keyHint("app.tools.expand", "to expand")})`,
                    ),
                    0,
                    0,
                ),
            );
        }
    }

    return container;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function smartWebAccessExtension(pi: ExtensionAPI): void {
    // ── 1. web_search ───────────────────────────────────────────────────────────
    pi.registerTool<typeof searchParametersSchema, WebSearchDetails>({
        name: "web_search",
        label: "web_search",
        description:
            "Search the web and return each query's results as readable markdown -- title, URL and snippet " +
            "per result -- followed by a summary of every result link, to open with " +
            "web_fetch (a single page) or batch_web_fetch (two or three). Call this " +
            "whenever the answer depends on information that changes over time: latest versions, APIs, " +
            "prices, dates, events, release notes. Memory of these is often stale even when it feels certain.",
        promptSnippet: "Search the web for current or external information",
        promptGuidelines: [
            "Use web_search when current or external information would change the answer, then " +
                "web_fetch or batch_web_fetch to open the few most relevant links it returns.",
            "Match the number of web_search queries to the question: one for a narrow lookup, more only when the " +
                "extra angles would change the answer.",
        ],
        parameters: searchParametersSchema,

        renderCall(args, theme) {
            const queryCount = args.searches.length;
            return new Text(
                theme.fg("toolTitle", theme.bold("web_search ")) +
                    theme.fg("muted", `${queryCount} ${queryCount === 1 ? "query" : "queries"}`),
                0,
                0,
            );
        },

        async execute(_toolCallId, params, _signal, onUpdate, ctx) {
            const { executeWebSearch } = await import("./search.js");
            const result = await executeWebSearch(params.searches, ctx.cwd, (progressByQuery) => {
                onUpdate?.({ content: [], details: { progressByQuery } });
            });
            return {
                content: [{ type: "text", text: result.text }],
                details: result.details,
            };
        },

        renderResult(result, opts, theme) {
            const answer = result.content
                .map((block) => ("text" in block ? block.text : ""))
                .join("");
            const container = new Container();
            const terminalWidth = process.stdout.columns || 80;
            const card = new Text(
                renderSearchProgressCard(result.details?.progressByQuery, theme, terminalWidth),
                0,
                0,
            );

            container.addChild(card);
            container.addChild(new Spacer(1));
            container.addChild(
                opts.expanded && answer
                    ? new Markdown(answer, 0, 0, getMarkdownTheme())
                    : new Text(
                          theme.fg("muted", "... (") +
                              keyHint("app.tools.expand", "to show results") +
                              theme.fg("muted", ")"),
                          0,
                          0,
                      ),
            );

            return container;
        },
    });

    // ── 2. web_fetch ────────────────────────────────────────────────────────────
    const fetchDefaults = resolveFetchToolDefaults();

    pi.registerTool({
        name: "web_fetch",
        label: "web_fetch",
        description: toolDescription,
        promptSnippet:
            "web_fetch(url, browser?, os?, headers?, maxChars?, timeoutMs?, format?, removeImages?, includeReplies?, proxy?, verbose?): fetch browser-fingerprinted readable web content with full agent metadata and a compact pi preview",
        parameters: Type.Object({
            ...createBaseFetchToolParameterProperties(fetchDefaults),
            verbose: Type.Optional(
                Type.Boolean({
                    description:
                        "Compatibility flag. pi currently returns the full metadata header to the agent regardless, while keeping the history preview compact. Default: false, or smartFetchVerboseByDefault from pi settings.",
                }),
            ),
        }),

        renderCall(args, theme) {
            return createWebFetchCallComponent(args, theme);
        },

        async execute(_toolCallId, params: Record<string, unknown>, _signal, onUpdate, ctx) {
            const settings = await loadPiSmartFetchSettings(ctx.cwd, getAgentDir());
            const runtimeDefaults = resolveFetchToolDefaults(settings);
            const verbose = (params.verbose as boolean) ?? settings.verboseByDefault;

            let spinnerTick = 0;
            let spinnerTimer: NodeJS.Timeout | null = null;
            const latestDetails: WebFetchRenderDetails = {
                verbose,
                format: params.format as OutputFormat,
                maxChars: params.maxChars as number,
                started: true,
                status: "connecting",
                url: params.url as string,
                spinnerTick: 0,
            };

            const emitProgress = (details: WebFetchRenderDetails) => {
                onUpdate?.({ content: [{ type: "text", text: "" }], details });
            };

            spinnerTimer = setInterval(() => {
                spinnerTick += 1;
                emitProgress({ ...latestDetails, spinnerTick });
            }, SPINNER_INTERVAL_MS);

            try {
                const {
                    executeFetchToolCall,
                    buildFetchErrorResponseText,
                    buildFetchResponseText,
                    buildUserFacingFetchErrorSummary,
                } = await import("./fetch.js");

                const result = await executeFetchToolCall(params, runtimeDefaults, {
                    onStatusChange(status) {
                        emitProgress({
                            ...latestDetails,
                            status,
                            phase: undefined,
                            progress: status === "done" ? 1 : undefined,
                        });
                    },
                    onProgressChange(update) {
                        emitProgress({
                            ...latestDetails,
                            status: update.status,
                            progress: update.progress,
                            phase: update.phase,
                        });
                    },
                });

                if (spinnerTimer) {
                    clearInterval(spinnerTimer);
                    spinnerTimer = null;
                }

                if (isError(result)) {
                    const userSummary = buildUserFacingFetchErrorSummary(result);
                    const fullError = buildFetchErrorResponseText(result);
                    emitProgress({
                        ...latestDetails,
                        error: true,
                        status: "error",
                        errorText: fullError,
                        userErrorSummary: userSummary,
                    });
                    return {
                        content: [{ type: "text", text: fullError }],
                        details: {
                            ...latestDetails,
                            error: true,
                            status: "error",
                            errorText: fullError,
                            userErrorSummary: userSummary,
                        },
                    };
                }

                const responseText = buildFetchResponseText(result, { verbose });
                emitProgress({
                    ...latestDetails,
                    status: "done",
                    fetchResult: result,
                    progress: 1,
                });
                return {
                    content: [{ type: "text", text: responseText }],
                    details: {
                        ...latestDetails,
                        status: "done",
                        fetchResult: result,
                        progress: 1,
                    },
                };
            } catch (error) {
                if (spinnerTimer) {
                    clearInterval(spinnerTimer);
                    spinnerTimer = null;
                }
                const message = error instanceof Error ? error.message : String(error);
                emitProgress({
                    ...latestDetails,
                    error: true,
                    status: "error",
                    errorText: message,
                    userErrorSummary: message,
                });
                return {
                    content: [{ type: "text", text: `Error: ${message}` }],
                    details: {
                        ...latestDetails,
                        error: true,
                        status: "error",
                        errorText: message,
                        userErrorSummary: message,
                    },
                };
            }
        },

        renderResult(result, { expanded }, theme) {
            const details = result.details as WebFetchRenderDetails | undefined;
            return createWebFetchResultComponent(details, expanded, theme);
        },
    });

    // ── 3. batch_web_fetch ──────────────────────────────────────────────────────
    pi.registerTool({
        name: "batch_web_fetch",
        label: "batch_web_fetch",
        description: batchToolDescription,
        promptSnippet:
            "batch_web_fetch(requests, verbose?): fetch multiple URLs concurrently with full agent metadata and per-item progress in the pi TUI",
        parameters: Type.Object({
            ...createBatchFetchToolParameterProperties(fetchDefaults),
            verbose: Type.Optional(
                Type.Boolean({
                    description:
                        "Compatibility flag. pi currently returns the full metadata header for successful results regardless, while keeping the history preview compact. Default: false, or smartFetchVerboseByDefault from pi settings.",
                }),
            ),
        }),

        renderCall(args, theme) {
            return createBatchFetchCallComponent(args, theme);
        },

        async execute(_toolCallId, params: Record<string, unknown>, _signal, onUpdate, ctx) {
            const settings = await loadPiSmartFetchSettings(ctx.cwd, getAgentDir());
            const runtimeDefaults = resolveFetchToolDefaults(settings);
            const verbose = (params.verbose as boolean) ?? settings.verboseByDefault;

            let latestSnapshot: BatchFetchProgressSnapshot | undefined;
            let spinnerTick = 0;
            let spinnerTimer: NodeJS.Timeout | null = null;

            const emitProgress = (snapshot: BatchFetchProgressSnapshot | undefined) => {
                onUpdate?.({
                    content: [{ type: "text", text: "" }],
                    details: { verbose, batchProgress: snapshot, spinnerTick },
                });
            };

            spinnerTimer = setInterval(() => {
                if (!latestSnapshot) return;
                spinnerTick += 1;
                emitProgress(latestSnapshot);
            }, SPINNER_INTERVAL_MS);

            try {
                const { executeBatchFetchToolCall, buildBatchFetchResponseText } =
                    await import("./fetch.js");

                const batchResult = await executeBatchFetchToolCall(params, runtimeDefaults, {
                    batchConcurrency: runtimeDefaults.batchConcurrency,
                    onProgress(snapshot) {
                        latestSnapshot = snapshot;
                        emitProgress(snapshot);
                    },
                });

                if (spinnerTimer) clearInterval(spinnerTimer);

                const finalProgress: BatchFetchProgressSnapshot = {
                    items: batchResult.items.map((item) => ({
                        index: item.index,
                        url: item.request.url,
                        status: item.status,
                        progress: item.progress,
                        error: item.error,
                    })),
                    total: batchResult.total,
                    completed: batchResult.total,
                    succeeded: batchResult.succeeded,
                    failed: batchResult.failed,
                    batchConcurrency: batchResult.batchConcurrency,
                };

                const responseText = buildBatchFetchResponseText(batchResult);
                return {
                    content: [{ type: "text", text: responseText }],
                    details: {
                        verbose,
                        batchProgress: finalProgress,
                        batchResult,
                        completed: true,
                    },
                };
            } catch (error) {
                if (spinnerTimer) clearInterval(spinnerTimer);
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: `Error: ${message}` }],
                    details: { verbose, completed: true, error: true },
                };
            }
        },

        renderResult(result, { expanded }, theme) {
            const details = result.details as BatchRenderDetails | undefined;
            return createBatchFetchResultComponent(details, expanded, theme);
        },
    });
}
