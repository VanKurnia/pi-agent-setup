import { Type, type Static } from "typebox";
import type { ReadingView } from "./views.ts";

// =============================================================================
// Fetch Constants & Defaults
// =============================================================================

export const DEFAULT_BROWSER = "chrome_145";
export const DEFAULT_OS = "windows" as const;
export const DEFAULT_MAX_CHARS = 50_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_INCLUDE_REPLIES = "extractors" as const;
export const DEFAULT_ACCEPT_HEADER =
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
export const DEFAULT_RAW_ACCEPT_HEADER =
    "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,text/markdown;q=0.8,text/plain;q=0.8,*/*;q=0.7";
export const DEFAULT_JSON_ACCEPT_HEADER =
    "application/json,text/json,application/ld+json;q=0.9,text/plain;q=0.8,*/*;q=0.7";
export const DEFAULT_ACCEPT_LANGUAGE_HEADER = "en-US,en;q=0.9";

// =============================================================================
// Fetch Types
// =============================================================================

export type OutputFormat = "markdown" | "html" | "text" | "json" | "raw";
export type FingerprintOs = "windows" | "macos" | "linux" | "android" | "ios";
export type IncludeRepliesOption = boolean | "extractors";

/** Live status of one fetch, as reported to the tool card while it runs. */
export type FetchStatus = "connecting" | "waiting" | "loading" | "processing" | "done" | "error";

export interface FetchOptions {
    url: string;
    browser?: string;
    os?: FingerprintOs | string;
    headers?: Record<string, string>;
    format?: OutputFormat;
    maxChars?: number;
    removeImages?: boolean;
    includeReplies?: IncludeRepliesOption;
    proxy?: string;
    timeoutMs?: number;
    /** Read part of the extracted markdown instead of the whole document. */
    view?: ReadingView;
    tempDir?: string;
    /** Caller's abort signal; cancels the request and reports `code: "aborted"`. */
    signal?: AbortSignal;
}

export interface BaseFetchResult {
    url: string;
    finalUrl: string;
    title: string;
    author: string;
    published: string;
    site: string;
    language: string;
    wordCount: number;
    browser: string;
    os: string;
    contentType?: string;
    /** Set when the page extracted far less than it holds (JS shell, partial wall). */
    warning?: string;
}

export interface ContentFetchResult extends BaseFetchResult {
    kind: "content";
    content: string;
}

export interface FileFetchResult extends BaseFetchResult {
    kind: "file";
    content: "";
    filePath: string;
    fileSize: number;
    mimeType?: string;
}

export type FetchResult = ContentFetchResult | FileFetchResult;

export type FetchErrorCode =
    | "invalid_url"
    | "unsupported_protocol"
    | "http_error"
    | "unexpected_response"
    | "timeout"
    | "network_error"
    | "processing_error"
    | "download_error"
    | "no_content"
    | "blocked_page"
    | "too_many_redirects"
    | "aborted";

export type FetchErrorPhase =
    | "validation"
    | "connecting"
    | "waiting"
    | "loading"
    | "processing"
    | "unknown";

export interface FetchError {
    error: string;
    code?: FetchErrorCode;
    phase?: FetchErrorPhase;
    retryable?: boolean;
    timeoutMs?: number;
    url?: string;
    finalUrl?: string;
    statusCode?: number;
    statusText?: string;
    mimeType?: string;
    contentLength?: number;
    downloadedBytes?: number;
}

export interface ExtractedContent {
    content?: string;
    wordCount: number;
    title?: string;
    author?: string;
    published?: string;
    site?: string;
    language?: string;
    extractorType?: string;
}

export interface BodyStreamReader<T> {
    read(): Promise<{ done: boolean; value?: T }>;
    cancel(reason?: string): Promise<void>;
    releaseLock(): void;
}

export interface ReadableBodyStream<T> {
    getReader(): BodyStreamReader<T>;
    readonly locked: boolean;
}

export interface FetchResponseLike {
    ok: boolean;
    status: number;
    statusText: string;
    url: string;
    headers: {
        get(name: string): string | null;
    };
    body: ReadableBodyStream<Uint8Array> | null;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    readable(): NodeJS.ReadableStream;
}

export interface FetchDependencies {
    fetch(url: string, options: Record<string, unknown>): Promise<FetchResponseLike>;
    defuddle(
        document: Document,
        url: string,
        options: Record<string, unknown>,
    ): Promise<ExtractedContent>;
    getProfiles(): string[];
}

export interface FetchToolConfig {
    maxChars?: number;
    timeoutMs?: number;
    browser?: string;
    os?: string;
    removeImages?: boolean;
    includeReplies?: IncludeRepliesOption;
    tempDir?: string;
}

export interface FetchToolDefaults {
    maxChars: number;
    timeoutMs: number;
    browser: string;
    os: string;
    removeImages: boolean;
    includeReplies: IncludeRepliesOption;
    tempDir?: string;
}

export interface FetchProgressUpdate {
    status: FetchStatus;
    progress: number;
    phase?: string;
}

export interface FetchExecutionHooks {
    onStatusChange?(status: FetchStatus): void;
    onProgressChange?(update: FetchProgressUpdate): void;
}

// =============================================================================
// Search Types
// =============================================================================

export interface SearchResultLink {
    title: string;
    url: string;
}

export type PageFetchResult =
    | {
          ok: true;
          requestedUrl: string;
          finalUrl: string;
          title: string;
          readableText: string;
          links: SearchResultLink[];
      }
    | { ok: false; requestedUrl: string; error: string };

export type QueryStatus = "queued" | "loading" | "done" | "error";

export interface QueryProgress {
    query: string;
    status: QueryStatus;
    result: PageFetchResult | undefined;
}

export interface WebSearchDetails {
    progressByQuery?: QueryProgress[];
}

export const searchParametersSchema = Type.Object({
    searches: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 6,
        description:
            "One to six search queries, each fetched as its own results page. Match the count to the " +
            "question: 1 for a narrow factual lookup, 2-3 for a topic with a few distinct angles, up to " +
            "6 for a broad or multi-part question. More queries is not better -- each one costs a fetch " +
            "and adds results to read, so only widen the set when the extra angles would actually change " +
            "the answer.",
    }),
});

export type WebSearchInput = Static<typeof searchParametersSchema>;

// =============================================================================
// Type Guards
// =============================================================================

export function isFileFetchResult(
    result: FetchResult,
): result is Extract<FetchResult, { kind: "file" }> {
    return result.kind === "file";
}

export function isError(result: FetchResult | FetchError): result is FetchError {
    return "error" in result;
}

// =============================================================================
// Formatting
// =============================================================================

/** Human-readable byte count, e.g. `1.5 MB`. Shared by error text and TUI cards. */
export function formatByteCount(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Math.max(0, bytes);
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const decimals = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

// =============================================================================
// Schema Helpers
// =============================================================================

export function resolveFetchToolDefaults(config: FetchToolConfig = {}): FetchToolDefaults {
    return {
        maxChars: config.maxChars ?? DEFAULT_MAX_CHARS,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        browser: config.browser ?? DEFAULT_BROWSER,
        os: config.os ?? DEFAULT_OS,
        removeImages: config.removeImages ?? false,
        includeReplies: config.includeReplies ?? DEFAULT_INCLUDE_REPLIES,
        tempDir: config.tempDir,
    };
}

/** The parameters both fetch tools share; the literal type is what `Static` reads. */
export function createBaseFetchToolParameterProperties(defaults: FetchToolDefaults) {
    return {
        url: Type.String({ description: "URL to fetch (http/https only)" }),
        browser: Type.Optional(
            Type.String({
                description: `Browser profile for TLS fingerprinting. Default: "${defaults.browser}". Examples: chrome_145, firefox_147, safari_26, edge_145, opera_127`,
            }),
        ),
        os: Type.Optional(
            Type.String({
                description: `OS profile for fingerprinting. Default: "${defaults.os}". Options: windows, macos, linux, android, ios`,
            }),
        ),
        headers: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
                description:
                    "Custom HTTP headers to send. By default, Accept and Accept-Language are set automatically.",
            }),
        ),
        maxChars: Type.Optional(
            Type.Number({
                description: `Maximum characters to return. Default: ${defaults.maxChars}`,
            }),
        ),
        timeoutMs: Type.Optional(
            Type.Number({
                description: `Request timeout in milliseconds. Default: ${defaults.timeoutMs}`,
            }),
        ),
        format: Type.Optional(
            Type.Union(
                [
                    Type.Literal("markdown"),
                    Type.Literal("html"),
                    Type.Literal("text"),
                    Type.Literal("json"),
                    Type.Literal("raw"),
                ],
                {
                    description:
                        'Output format. "markdown" (default), "html" (cleaned HTML), "text" (plain text, no formatting), "json" (pretty-printed JSON), or "raw" (full raw server response without extraction or truncation, for further parsing)',
                },
            ),
        ),
        removeImages: Type.Optional(
            Type.Boolean({
                description: "Strip image references from output. Default: false",
            }),
        ),
        includeReplies: Type.Optional(
            Type.Union([Type.Boolean(), Type.Literal("extractors")], {
                description:
                    "Include replies/comments: 'extractors' for site-specific only (default), true for all, false for none",
            }),
        ),
        proxy: Type.Optional(
            Type.String({
                description: "Proxy URL (http://user:pass@host:port or socks5://host:port)",
            }),
        ),
        toc: Type.Optional(
            Type.Boolean({
                description:
                    "Return only the numbered heading outline instead of the body. Cannot be combined with section or focus.",
            }),
        ),
        section: Type.Optional(
            Type.String({
                description:
                    'Return one section by its toc number (for example "17") or by a fragment of its heading text; subsections included. Cannot be combined with toc or focus.',
            }),
        ),
        focus: Type.Optional(
            Type.String({
                description:
                    "Return the sections that best match this query, best first, each with its heading path. Cannot be combined with toc or section.",
            }),
        ),
    };
}

export const webSearchOutputSchema = Type.Object({
    queries: Type.Array(Type.String()),
    results: Type.Array(
        Type.Object({
            query: Type.String(),
            ok: Type.Boolean(),
            error: Type.Optional(Type.String()),
            links: Type.Array(
                Type.Object({
                    title: Type.String(),
                    url: Type.String(),
                }),
            ),
        }),
    ),
});
export type WebSearchOutput = Static<typeof webSearchOutputSchema>;

export const webFetchOutputSchema = Type.Object({
    url: Type.String({ description: "Requested URL" }),
    finalUrl: Type.String({ description: "Final URL after redirects" }),
    title: Type.String({ description: "Extracted document title" }),
    content: Type.String({ description: "Extracted document text or error message" }),
    wordCount: Type.Number({ description: "Word count of the returned content" }),
    site: Type.Optional(Type.String({ description: "Site name if extracted" })),
    author: Type.Optional(Type.String({ description: "Author name if extracted" })),
    published: Type.Optional(Type.String({ description: "Published date if extracted" })),
    warning: Type.Optional(
        Type.String({ description: "Set when the page extracted far less than it holds" }),
    ),
    statusCode: Type.Optional(Type.Number({ description: "HTTP status code" })),
    filePath: Type.Optional(Type.String({ description: "Local disk path for downloaded file" })),
    fileSize: Type.Optional(Type.Number({ description: "Size of downloaded file in bytes" })),
    isError: Type.Optional(Type.Boolean({ description: "Whether extraction failed" })),
});
export type WebFetchOutput = Static<typeof webFetchOutputSchema>;
