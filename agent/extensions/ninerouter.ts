/**
 * ninerouter — minimal native 9router web-tools extension.
 *
 * Keeps ONLY the two model-facing tools from the old `pi-9router-ext` npm
 * package, with zero startup cost:
 *   - `ninerouter_web_search`  → POST {baseUrl}/v1/search
 *   - `ninerouter_web_fetch`   → POST {baseUrl}/v1/web/fetch
 *
 * Deliberately dropped (see git history / npm package for reference):
 * model/provider discovery + registration, combos browsing, reasoning toggles,
 * /9router-* commands, ninerouter_status tool, session hooks, disk caches.
 *
 * Config: `<agentDir>/9router-config.json` (same file the npm package used):
 * ```json
 * { "baseUrl": "http://localhost:20128", "apiKey": "sk-...",
 *   "webSearchRoute": "optional-default", "webFetchRoute": "optional-default" }
 * ```
 * Env overrides: NINE_ROUTER_BASE_URL, NINE_ROUTER_API_KEY,
 * NINE_ROUTER_WEB_SEARCH_ROUTE, NINE_ROUTER_WEB_FETCH_ROUTE.
 *
 * Web routes are resolved lazily per tool call via GET {baseUrl}/v1/models/web
 * (cached in memory); an explicit `route` param or configured default always
 * wins, so the tools keep working even when route discovery fails.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface NinerouterConfig {
    baseUrl: string;
    apiKey: string | undefined;
    webSearchRoute: string | undefined;
    webFetchRoute: string | undefined;
}

const DEFAULT_BASE_URL = "http://localhost:20128";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 20;
const DEFAULT_FETCH_CHARACTERS = 12000;
const MAX_FETCH_CHARACTERS = 50000;

function normalizeBaseUrl(url: string): string {
    return url.replace(/\/$/, "");
}

function cleanString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function agentDirSafe(): string {
    try {
        return getAgentDir();
    } catch {
        return join(homedir(), ".pi", "agent");
    }
}

// mtime-keyed read-through cache for the JSON config file (mirrors
// shared/db.ts read-through shape). Env overrides are applied per call in
// loadConfig() so env changes are never stale; file re-reads happen only
// when the underlying path or mtimeMs changes. Per-call `route` params
// bypass this cache in resolveRoute() (explicit route always wins).
let _cachedConfigFile: Partial<Record<string, unknown>> | null = null;
let _cachedConfigPath: string | null = null;
let _cachedConfigMtimeMs = -1;

function loadConfigFile(): Partial<Record<string, unknown>> {
    const candidates = [join(agentDirSafe(), "9router-config.json")];
    const legacy = join(homedir(), ".pi", "agent", "9router-config.json");
    if (!candidates.includes(legacy)) candidates.push(legacy);
    let found: string | null = null;
    for (const path of candidates) {
        try {
            if (existsSync(path)) {
                found = path;
                break;
            }
        } catch {
            continue;
        }
    }
    if (!found) {
        _cachedConfigFile = {};
        _cachedConfigPath = null;
        _cachedConfigMtimeMs = -1;
        return {};
    }
    let mtimeMs = -1;
    try {
        mtimeMs = statSync(found).mtimeMs;
    } catch {
        // If stat fails, fall through to a fresh read attempt.
    }
    if (
        _cachedConfigFile !== null &&
        _cachedConfigPath === found &&
        _cachedConfigMtimeMs === mtimeMs
    ) {
        return _cachedConfigFile;
    }
    let parsed: Partial<Record<string, unknown>> = {};
    try {
        parsed = JSON.parse(readFileSync(found, "utf8")) as Record<string, unknown>;
    } catch {
        // Ignore malformed config; fall through to env/defaults.
        parsed = {};
    }
    _cachedConfigFile = parsed;
    _cachedConfigPath = found;
    _cachedConfigMtimeMs = mtimeMs;
    return parsed;
}

function loadConfig(): NinerouterConfig {
    const file = loadConfigFile();

    const env = process.env;
    return {
        baseUrl: normalizeBaseUrl(
            cleanString(env.NINE_ROUTER_BASE_URL) ?? cleanString(file.baseUrl) ?? DEFAULT_BASE_URL,
        ),
        apiKey: cleanString(env.NINE_ROUTER_API_KEY) ?? cleanString(file.apiKey),
        webSearchRoute:
            cleanString(env.NINE_ROUTER_WEB_SEARCH_ROUTE) ?? cleanString(file.webSearchRoute),
        webFetchRoute:
            cleanString(env.NINE_ROUTER_WEB_FETCH_ROUTE) ?? cleanString(file.webFetchRoute),
    };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(config: NinerouterConfig): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    return headers;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
        abort();
    } else {
        signal?.addEventListener("abort", abort, { once: true });
    }
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        },
    };
}

async function fetchJson(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
): Promise<unknown> {
    const timeout = withTimeout(signal, REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...init, signal: timeout.signal });
        const text = await response.text();
        let payload: unknown;
        try {
            payload = JSON.parse(text);
        } catch {
            payload = { text };
        }
        if (!response.ok) {
            throw new Error(
                `9router ${url} → ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`,
            );
        }
        return payload;
    } finally {
        timeout.cleanup();
    }
}

function clampNumber(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(value)));
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Web routes (lazy, in-memory)
// ---------------------------------------------------------------------------

type WebKind = "webSearch" | "webFetch";

interface WebRoute {
    id: string;
    kind?: string;
    owned_by?: string;
}

let cachedRoutes: WebRoute[] = [];
let cachedFor = "";

async function getRoutes(config: NinerouterConfig, signal?: AbortSignal): Promise<WebRoute[]> {
    const identity = `${config.baseUrl}::${config.apiKey ?? ""}`;
    if (cachedFor === identity && cachedRoutes.length > 0) return cachedRoutes;
    try {
        const payload = (await fetchJson(
            `${config.baseUrl}/v1/models/web`,
            { method: "GET", headers: authHeaders(config) },
            signal,
        )) as { data?: WebRoute[] };
        const routes = Array.isArray(payload.data)
            ? payload.data.filter((r) => r?.kind === "webSearch" || r?.kind === "webFetch")
            : [];
        if (routes.length > 0) {
            cachedRoutes = routes;
            cachedFor = identity;
        }
        return routes.length > 0 ? routes : cachedRoutes;
    } catch (err) {
        // Discovery failed (network/auth) — fall back to cached routes, but
        // say so: otherwise callers misread this as "no route configured".
        console.warn(
            `[ninerouter] Route discovery failed: ${(err as Error)?.message ?? String(err)}; using cached routes.`,
        );
        return cachedRoutes;
    }
}

/** Strip combo-unaware `/search` / `/fetch` suffixes (matches npm package).
 * Limitation: when discovery is unavailable (routes empty), a combo-owned
 * route keeps its suffix-stripped form — the ownership guard below cannot
 * fire without discovery data. Failure is loud (API rejects the model id).
 */
function toApiModel(route: string, kind: WebKind, routes: WebRoute[]): string {
    const discovered = routes.find((r) => r.id === route && r.kind === kind);
    if (discovered?.owned_by === "combo") return route;
    if (kind === "webSearch" && route.endsWith("/search")) return route.slice(0, -"/search".length);
    if (kind === "webFetch" && route.endsWith("/fetch")) return route.slice(0, -"/fetch".length);
    return route;
}

function resolveRoute(
    paramRoute: string | undefined,
    defaultRoute: string | undefined,
    routes: WebRoute[],
    kind: WebKind,
): { route: string; apiModel: string } | undefined {
    const explicit = paramRoute?.trim();
    if (explicit) return { route: explicit, apiModel: toApiModel(explicit, kind, routes) };
    const preferred = defaultRoute?.trim();
    if (preferred) {
        const known = routes.find((r) => r.id === preferred && r.kind === kind);
        if (known) return { route: known.id, apiModel: toApiModel(known.id, kind, routes) };
        // Configured default unknown (or discovery failed) — try it as-is when
        // there is nothing discovered, otherwise fall back to first discovered.
        const first = routes.find((r) => r.kind === kind);
        if (first) return { route: first.id, apiModel: toApiModel(first.id, kind, routes) };
        return { route: preferred, apiModel: toApiModel(preferred, kind, routes) };
    }
    const first = routes.find((r) => r.kind === kind);
    return first ? { route: first.id, apiModel: toApiModel(first.id, kind, routes) } : undefined;
}

// ---------------------------------------------------------------------------
// Response formatting (same shape as the npm package)
// ---------------------------------------------------------------------------

function formatSearchResponse(query: string, route: string, payload: unknown): string {
    const response = payload as {
        results?: Record<string, unknown>[];
        answer?: unknown;
        provider?: unknown;
        errors?: unknown[];
    };
    const results = Array.isArray(response.results) ? response.results : [];
    const lines = [
        `9router web search: ${query}`,
        `Route: ${route}${response.provider ? ` (provider: ${String(response.provider)})` : ""}`,
    ];
    if (typeof response.answer === "string" && response.answer.trim()) {
        lines.push("", `Answer: ${response.answer.trim()}`);
    }
    if (results.length === 0) {
        lines.push("", "No results returned.");
    } else {
        lines.push("", "Results:");
        results.forEach((result, index) => {
            const title = typeof result.title === "string" ? result.title : "Untitled";
            const url = typeof result.url === "string" ? result.url : "";
            const snippet = typeof result.snippet === "string" ? result.snippet : "";
            lines.push(`${index + 1}. ${title}`);
            if (url) lines.push(`   ${url}`);
            if (snippet) lines.push(`   ${snippet}`);
        });
    }
    if (Array.isArray(response.errors) && response.errors.length > 0) {
        const errStr = JSON.stringify(response.errors);
        lines.push("", `Errors: ${errStr.length > 500 ? errStr.slice(0, 500) + "…" : errStr}`);
    }
    return lines.join("\n");
}

function formatFetchResponse(route: string, payload: unknown, maxCharacters: number): string {
    const response = payload as {
        url?: unknown;
        title?: unknown;
        provider?: unknown;
        content?: { text?: unknown; format?: unknown };
    };
    const raw = typeof response.content?.text === "string" ? response.content.text : "";
    const text =
        raw.length > maxCharacters
            ? `${raw.slice(0, maxCharacters)}\n\n[truncated ${raw.length - maxCharacters} chars]`
            : raw;
    const lines = [
        `9router web fetch: ${typeof response.url === "string" ? response.url : ""}`,
        `Route: ${route}${response.provider ? ` (provider: ${String(response.provider)})` : ""}`,
    ];
    if (typeof response.title === "string" && response.title.trim()) {
        lines.push(`Title: ${response.title.trim()}`);
    }
    if (response.content?.format) lines.push(`Format: ${String(response.content.format)}`);
    lines.push("", text || "No content returned.");
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface SearchParams {
    query: string;
    route?: string;
    max_results?: number;
    search_type?: string;
    country?: string;
    language?: string;
    time_range?: string;
    offset?: number;
    domain_filter?: string[];
    content_options?: Record<string, unknown>;
    provider_options?: Record<string, unknown>;
}

interface FetchParams {
    url: string;
    route?: string;
    format?: string;
    max_characters?: number;
}

const NO_ROUTE_HINT =
    "No 9router web route is configured or discovered. Add a web provider/combo in 9router, then set webSearchRoute/webFetchRoute in <agentDir>/9router-config.json (or pass route explicitly).";

export default function ninerouter(pi: ExtensionAPI) {
    pi.registerTool({
        name: "ninerouter_web_search",
        label: "9router Web Search",
        description:
            "Search the web through your configured 9router instance. Sends the query to 9router and its upstream web-search provider or combo.",
        promptSnippet: "Search the web using 9router web search routes.",
        promptGuidelines: [
            "Use ninerouter_web_search when current or external web information is needed and the user has not requested a different web-search tool.",
            "The route parameter is optional; omit it to use the configured 9router default search route.",
        ],
        parameters: Type.Object({
            query: Type.String({ description: "Search query." }),
            route: Type.Optional(
                Type.String({
                    description:
                        "Optional 9router web search route, provider alias, or combo name. Examples: brave/search, tavily/search, my-search-combo.",
                }),
            ),
            max_results: Type.Optional(
                Type.Number({
                    description: `Maximum results to return, capped at ${MAX_SEARCH_RESULTS}. Defaults to ${DEFAULT_SEARCH_RESULTS}.`,
                    minimum: 1,
                    maximum: MAX_SEARCH_RESULTS,
                }),
            ),
            search_type: Type.Optional(
                Type.String({
                    description:
                        "9router search_type, forwarded as-is. Examples depend on provider (web, news, images).",
                }),
            ),
            country: Type.Optional(
                Type.String({ description: "Optional country/region hint forwarded to 9router." }),
            ),
            language: Type.Optional(
                Type.String({
                    description: "Optional language hint forwarded to 9router, e.g. en.",
                }),
            ),
            time_range: Type.Optional(
                Type.String({
                    description:
                        "Optional recency filter forwarded to 9router, e.g. day, week, month, year.",
                }),
            ),
            offset: Type.Optional(
                Type.Number({
                    description: "Optional result offset for providers that support pagination.",
                    minimum: 0,
                }),
            ),
            domain_filter: Type.Optional(
                Type.Array(Type.String(), {
                    description:
                        "Optional domain filters. Some providers support negative entries like -example.com.",
                }),
            ),
            content_options: Type.Optional(
                Type.Object(
                    {},
                    {
                        description: "Advanced 9router content_options forwarded as-is.",
                        additionalProperties: true,
                    },
                ),
            ),
            provider_options: Type.Optional(
                Type.Object(
                    {},
                    {
                        description:
                            "Advanced provider_options forwarded as-is to 9router/upstream provider.",
                        additionalProperties: true,
                    },
                ),
            ),
        }),
        async execute(_toolCallId, params: SearchParams, signal, onUpdate) {
            const config = loadConfig();
            const routes = await getRoutes(config, signal);
            const resolved = resolveRoute(params.route, config.webSearchRoute, routes, "webSearch");
            if (!resolved) {
                return {
                    content: [{ type: "text", text: NO_ROUTE_HINT }],
                    isError: true,
                    details: { ok: false },
                };
            }
            onUpdate?.({
                content: [
                    { type: "text", text: `Searching via 9router route ${resolved.route}...` },
                ],
                details: { partial: true, route: resolved.route },
            });
            const body: Record<string, unknown> = {
                model: resolved.apiModel,
                query: params.query,
                max_results: clampNumber(
                    params.max_results,
                    DEFAULT_SEARCH_RESULTS,
                    1,
                    MAX_SEARCH_RESULTS,
                ),
            };
            for (const key of [
                "search_type",
                "country",
                "language",
                "time_range",
                "offset",
                "domain_filter",
                "content_options",
                "provider_options",
            ] as const) {
                if (params[key] !== undefined) body[key] = params[key];
            }
            try {
                const payload = await fetchJson(
                    `${config.baseUrl}/v1/search`,
                    {
                        method: "POST",
                        headers: authHeaders(config),
                        body: JSON.stringify(body),
                    },
                    signal,
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: formatSearchResponse(params.query, resolved.route, payload),
                        },
                    ],
                    details: { ok: true, route: resolved.route, request: body, response: payload },
                };
            } catch (err) {
                return {
                    content: [
                        { type: "text", text: `9router web search failed: ${errorText(err)}` },
                    ],
                    isError: true,
                    details: { ok: false, route: resolved.route, request: body },
                };
            }
        },
    });

    pi.registerTool({
        name: "ninerouter_web_fetch",
        label: "9router Web Fetch",
        description:
            "Fetch and extract a URL through your configured 9router instance. Sends the URL to 9router and its upstream web-fetch provider or combo.",
        promptSnippet: "Fetch/extract URL content using 9router web fetch routes.",
        promptGuidelines: [
            "Use ninerouter_web_fetch when the user asks to read, fetch, extract, or summarize a specific URL through 9router.",
            "The route parameter is optional; omit it to use the configured 9router default fetch route.",
        ],
        parameters: Type.Object({
            url: Type.String({ description: "URL to fetch and extract." }),
            route: Type.Optional(
                Type.String({
                    description:
                        "Optional 9router web fetch route, provider alias, or combo name. Examples: tavily/fetch, jina-reader/fetch, my-fetch-combo.",
                }),
            ),
            format: Type.Optional(
                Type.String({
                    description:
                        "Output format requested from 9router. Common values: markdown, text, html.",
                }),
            ),
            max_characters: Type.Optional(
                Type.Number({
                    description: `Maximum characters to return, capped at ${MAX_FETCH_CHARACTERS}. Defaults to ${DEFAULT_FETCH_CHARACTERS}.`,
                    minimum: 1,
                    maximum: MAX_FETCH_CHARACTERS,
                }),
            ),
        }),
        async execute(_toolCallId, params: FetchParams, signal, onUpdate) {
            const config = loadConfig();
            const routes = await getRoutes(config, signal);
            const resolved = resolveRoute(params.route, config.webFetchRoute, routes, "webFetch");
            if (!resolved) {
                return {
                    content: [{ type: "text", text: NO_ROUTE_HINT }],
                    isError: true,
                    details: { ok: false },
                };
            }
            onUpdate?.({
                content: [
                    { type: "text", text: `Fetching URL via 9router route ${resolved.route}...` },
                ],
                details: { partial: true, route: resolved.route },
            });
            const maxCharacters = clampNumber(
                params.max_characters,
                DEFAULT_FETCH_CHARACTERS,
                1,
                MAX_FETCH_CHARACTERS,
            );
            const body: Record<string, unknown> = {
                model: resolved.apiModel,
                url: params.url,
                format: params.format ?? "markdown",
                max_characters: maxCharacters,
            };
            try {
                const payload = await fetchJson(
                    `${config.baseUrl}/v1/web/fetch`,
                    {
                        method: "POST",
                        headers: authHeaders(config),
                        body: JSON.stringify(body),
                    },
                    signal,
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: formatFetchResponse(resolved.route, payload, maxCharacters),
                        },
                    ],
                    details: { ok: true, route: resolved.route, request: body, response: payload },
                };
            } catch (err) {
                return {
                    content: [
                        { type: "text", text: `9router web fetch failed: ${errorText(err)}` },
                    ],
                    isError: true,
                    details: { ok: false, route: resolved.route, request: body },
                };
            }
        },
    });
}
