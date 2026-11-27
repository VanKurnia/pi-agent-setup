/**
 * smart-web-access — unified local web access extension for Pi.
 * Registers `web_search` and `web_fetch`.
 * `batch_web_fetch` was removed on purpose -- use `codemode` to fan out
 * `tools.web_fetch(...)` calls when several URLs are needed.
 *
 * Heavy dependencies (wreq-js, linkedom, defuddle) are lazily loaded inside
 * execute() handlers so startup cost remains near zero.
 */

import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import { createCachedMarkdownResult } from "../shared/markdown.ts";

import {
    type WebFetchOutput,
    type WebSearchDetails,
    type WebSearchOutput,
    createBaseFetchToolParameterProperties,
    isError,
    isFileFetchResult,
    resolveFetchToolDefaults,
    searchParametersSchema,
    webFetchOutputSchema,
    webSearchOutputSchema,
} from "./types.ts";
import {
    createWebFetchCallComponent,
    createWebFetchResultComponent,
    renderSearchProgressCard,
    type WebFetchRenderDetails,
} from "./tui.ts";

// =============================================================================
// Tool Parameters
// =============================================================================

const SPINNER_INTERVAL_MS = 80;

const fetchDefaults = resolveFetchToolDefaults();

const webFetchParameters = Type.Object({
    ...createBaseFetchToolParameterProperties(fetchDefaults),
    verbose: Type.Optional(
        Type.Boolean({
            description:
                "Include the full metadata header (site, language, word count, browser) in the returned text. Default: false, or smartFetchVerboseByDefault from settings.",
        }),
    ),
});

export type WebFetchInput = Static<typeof webFetchParameters>;

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function smartWebAccessExtension(pi: ExtensionAPI): void {
    // ── 1. web_search ───────────────────────────────────────────────────────────
    pi.registerTool<typeof searchParametersSchema, WebSearchDetails>({
        name: "web_search",
        label: "web_search",
        annotations: {
            readOnlyHint: true,
            openWorldHint: true,
            idempotentHint: true,
        },
        description:
            "Search the web and return per-query results as markdown — title, URL and snippet — followed by a summary of every result link.",
        promptSnippet: "Search the web for current or external information",
        promptGuidelines: [
            "web_search: when current or external information would change the answer, then open the few most relevant links with web_fetch (in parallel through codemode).",
        ],
        parameters: searchParametersSchema,
        outputSchema: webSearchOutputSchema,

        renderCall(args, theme) {
            const queryCount = args.searches.length;
            return new Text(
                theme.fg("toolTitle", theme.bold("web_search ")) +
                    theme.fg("muted", `${queryCount} ${queryCount === 1 ? "query" : "queries"}`),
                0,
                0,
            );
        },

        async execute(_toolCallId, params, signal, onUpdate) {
            const [{ executeWebSearch }, { readSmartFetchSettings }] = await Promise.all([
                import("./search.js"),
                import("./settings.js"),
            ]);
            const settings = readSmartFetchSettings(pi.getSettings());
            const result = await executeWebSearch(
                params.searches,
                settings.resultsPerQuery,
                (progressByQuery) => {
                    onUpdate?.({ content: [], details: { progressByQuery } });
                },
                signal,
            );
            const emptyLinks: Array<{ title: string; url: string }> = [];
            const results: WebSearchOutput["results"] = (result.details?.progressByQuery || []).map(
                (q) => {
                    const res = q.result;
                    if (!res) {
                        return {
                            query: q.query,
                            ok: false,
                            error: "no response",
                            links: emptyLinks,
                        };
                    }
                    if (res.ok) {
                        return {
                            query: q.query,
                            ok: true,
                            links: res.links.map((l) => ({ title: l.title, url: l.url })),
                        };
                    }
                    return { query: q.query, ok: false, error: res.error, links: emptyLinks };
                },
            );
            const structuredContent: WebSearchOutput = { queries: params.searches, results };
            return {
                content: [{ type: "text", text: result.text }],
                structuredContent: structuredContent as JsonValue,
                details: result.details,
            };
        },

        renderResult(result, opts, theme, context) {
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
                    ? createCachedMarkdownResult(context.state, "__webSearchAnswer", answer)
                    : new Text(
                          theme.fg("muted", "... (") +
                              context.keyHint("app.tools.expand", "to show results") +
                              theme.fg("muted", ")"),
                          0,
                          0,
                      ),
            );

            return container;
        },
    });

    // ── 2. web_fetch ────────────────────────────────────────────────────────────
    pi.registerTool<typeof webFetchParameters, WebFetchRenderDetails>({
        name: "web_fetch",
        label: "web_fetch",
        annotations: {
            readOnlyHint: true,
            openWorldHint: true,
            idempotentHint: true,
        },
        description:
            "Fetch a URL and return it as readable markdown (html, text, json or raw on request). Extractors add title, author and date when the page publishes them. Does not execute JavaScript.",
        promptSnippet: "Fetch a URL and extract readable content (does not run JavaScript)",
        parameters: webFetchParameters,
        outputSchema: webFetchOutputSchema,

        renderCall(args, theme) {
            return createWebFetchCallComponent(args, theme);
        },

        async execute(_toolCallId, params, signal, onUpdate) {
            const [{ readSmartFetchSettings }, fetch] = await Promise.all([
                import("./settings.js"),
                import("./fetch.js"),
            ]);
            const settings = readSmartFetchSettings(pi.getSettings());
            const runtimeDefaults = resolveFetchToolDefaults(settings);
            const verbose = params.verbose ?? settings.verboseByDefault;

            let spinnerTick = 0;
            const latestDetails: WebFetchRenderDetails = {
                verbose,
                format: params.format,
                maxChars: params.maxChars,
                started: true,
                status: "connecting",
                url: params.url,
                spinnerTick: 0,
            };

            const emitProgress = (details: WebFetchRenderDetails) => {
                onUpdate?.({ content: [{ type: "text", text: "" }], details });
            };

            const spinnerTimer = setInterval(() => {
                spinnerTick += 1;
                emitProgress({ ...latestDetails, spinnerTick });
            }, SPINNER_INTERVAL_MS);
            const stopSpinner = () => clearInterval(spinnerTimer);

            try {
                const result = await fetch.executeFetchToolCall(
                    params,
                    runtimeDefaults,
                    {
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
                    },
                    signal,
                );

                stopSpinner();

                if (isError(result)) {
                    const userSummary = fetch.buildUserFacingFetchErrorSummary(result);
                    const fullError = fetch.buildFetchErrorResponseText(result);
                    emitProgress({
                        ...latestDetails,
                        error: true,
                        status: "error",
                        errorText: fullError,
                        userErrorSummary: userSummary,
                    });
                    const structuredContent: WebFetchOutput = {
                        url: params.url,
                        finalUrl: result.finalUrl || params.url,
                        title: "Error",
                        content: fullError,
                        wordCount: 0,
                        statusCode: result.statusCode,
                        isError: true,
                    };
                    return {
                        content: [{ type: "text", text: fullError }],
                        structuredContent: structuredContent as JsonValue,
                        isError: true,
                        details: {
                            ...latestDetails,
                            error: true,
                            status: "error",
                            errorText: fullError,
                            userErrorSummary: userSummary,
                        },
                    };
                }

                const responseText = fetch.buildFetchResponseText(result, { verbose });
                emitProgress({
                    ...latestDetails,
                    status: "done",
                    fetchResult: result,
                    progress: 1,
                });
                const isFile = isFileFetchResult(result);
                const structuredContent: WebFetchOutput = {
                    url: result.url,
                    finalUrl: result.finalUrl,
                    title: result.title,
                    content: result.content,
                    wordCount: result.wordCount,
                    site: result.site || undefined,
                    warning: result.warning,
                    author: result.author || undefined,
                    published: result.published || undefined,
                    filePath: isFile ? result.filePath : undefined,
                    fileSize: isFile ? result.fileSize : undefined,
                    isError: false,
                };
                return {
                    content: [{ type: "text", text: responseText }],
                    structuredContent: structuredContent as JsonValue,
                    details: {
                        ...latestDetails,
                        status: "done",
                        fetchResult: result,
                        progress: 1,
                    },
                };
            } catch (error) {
                stopSpinner();
                const message = error instanceof Error ? error.message : String(error);
                emitProgress({
                    ...latestDetails,
                    error: true,
                    status: "error",
                    errorText: message,
                    userErrorSummary: message,
                });
                const structuredContent: WebFetchOutput = {
                    url: params.url,
                    finalUrl: params.url,
                    title: "Error",
                    content: message,
                    wordCount: 0,
                    isError: true,
                };
                return {
                    content: [{ type: "text", text: `Error: ${message}` }],
                    structuredContent: structuredContent as JsonValue,
                    isError: true,
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

        renderResult(result, { expanded }, theme, context) {
            return createWebFetchResultComponent(result.details, expanded, theme, context);
        },
    });
}
