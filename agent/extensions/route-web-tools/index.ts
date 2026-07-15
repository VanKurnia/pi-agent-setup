/**
 * route-web-tools — Web search & URL fetch tools for OmniRoute/route proxy
 *
 * Registers route_web_search and route_web_fetch that POST to
 * the same /v1/search and /v1/web/fetch endpoints that 9router and OmniRoute
 * both expose at localhost:20128.
 *
 * Config: reads baseUrl + apiKey from agent/route-proxy-config.json
 * (falls back to agent/9router-config.json).
 *
 * Verified against OmniRoute v3.8.x source (2026-07-14):
 *   - ./open-sse/handlers/search.ts    → SearchHandlerOptions
 *   - ./open-sse/handlers/webFetch.ts  → WebFetchRequest
 *   Live-tested: exa-search provider, firecrawl fetch provider.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Config ─────────────────────────────────────────────────────

interface RouteConfig {
    baseUrl: string;
    apiKey?: string;
}

function loadConfig(): RouteConfig {
    // __dirname = <pi>/agent/extensions/route-web-tools -> need <pi>/agent/
    const dir = join(__dirname, "..", "..");
    const candidates = ["route-proxy-config.json", "9router-config.json"];
    for (const name of candidates) {
        try {
            const p = join(dir, name);
            if (existsSync(p)) {
                return JSON.parse(readFileSync(p, "utf-8")) as RouteConfig;
            }
        } catch {
            // continue
        }
    }
    return { baseUrl: "http://localhost:20128" };
}

// ── HTTP helpers ───────────────────────────────────────────────

function authHeaders(config: RouteConfig): Record<string, string> {
    const h: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    if (config.apiKey) h.Authorization = `Bearer ${config.apiKey}`;
    return h;
}

function clamp(v: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(v)));
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

async function postJSON(
    baseUrl: string,
    path: string,
    body: Record<string, unknown>,
    apiKey: string | undefined,
    signal?: AbortSignal,
    auth = true,
): Promise<unknown> {
    const h = auth
        ? authHeaders({ baseUrl, apiKey })
        : { "Content-Type": "application/json", Accept: "application/json" };
    const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
        signal,
    });
    const text = await res.text();
    let payload: unknown;
    try {
        payload = JSON.parse(text);
    } catch {
        payload = { text };
    }
    if (!res.ok) {
        const msg =
            typeof payload === "object" && payload && "error" in payload
                ? JSON.stringify((payload as { error: unknown }).error)
                : text;
        throw new Error(`route proxy ${path} returned ${res.status}: ${msg}`);
    }
    return payload;
}

// ── Search formatting ──────────────────────────────────────────

function formatSearch(query: string, payload: unknown): string {
    const r = payload as {
        results?: Record<string, unknown>[];
        answer?: unknown;
        provider?: unknown;
        errors?: unknown[];
    };
    const results = Array.isArray(r.results) ? r.results : [];
    const out: string[] = [`Web search: ${query}`];
    if (r.provider) out.push(`Provider: ${String(r.provider)}`);
    if (typeof r.answer === "string" && r.answer.trim()) out.push("", `Answer: ${r.answer.trim()}`);
    if (results.length === 0) {
        out.push("", "No results.");
    } else {
        out.push("", "Results:");
        for (let i = 0; i < results.length; i++) {
            const item = results[i];
            const title = typeof item.title === "string" ? item.title : "Untitled";
            const url = typeof item.url === "string" ? item.url : "";
            const snippet = typeof item.snippet === "string" ? item.snippet : "";
            out.push(`${i + 1}. ${title}`);
            if (url) out.push(`   ${url}`);
            if (snippet) out.push(`   ${snippet}`);
        }
    }
    if (Array.isArray(r.errors) && r.errors.length > 0) {
        out.push("", `Errors: ${JSON.stringify(r.errors)}`);
    }
    return out.join("\n");
}

function formatFetch(payload: unknown, maxChars: number): string {
    const r = payload as Record<string, unknown>;

    const provider = typeof r.provider === "string" ? r.provider : "unknown";
    const url = typeof r.url === "string" ? r.url : "";
    const screenUrl = typeof r.screenshot_url === "string" ? r.screenshot_url : "";

    // Extract title from metadata object or top-level
    const meta = r.metadata as Record<string, unknown> | undefined;
    const title =
        typeof meta?.title === "string" && meta.title
            ? meta.title
            : typeof r.title === "string"
              ? r.title
              : "";

    // content is a raw string from firecrawl (not {text: ...})
    const contentText = typeof r.content === "string" ? r.content : "";

    const out: string[] = [`Web fetch: ${url}`];
    out.push(`Provider: ${provider}`);
    if (title) out.push(`Title: ${title}`);

    // Links-only format
    const links = Array.isArray(r.links) ? (r.links as string[]) : [];
    if (links.length > 0 && !contentText) {
        for (const link of links) out.push("", link);
        return out.join("\n");
    }

    // Screenshot-only response
    if (screenUrl && !contentText) {
        out.push("", `Screenshot: ${screenUrl}`);
        return out.join("\n");
    }

    out.push("", truncate(contentText || "(no content)", maxChars));
    return out.join("\n");
}

// ── Extension entry point ──────────────────────────────────────

export default function routeWebTools(pi: ExtensionAPI) {
    const config = loadConfig();
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const apiKey = config.apiKey;

    // ── route_web_search ──────────────────────────────────────────
    //
    // Maps to POST /v1/search on OmniRoute.
    // Server-side parameters (from open-sse/handlers/search.ts):
    //   query, model → provider resolution, max_results, search_type,
    //   country, language, time_range, offset, domain_filter
    //
    pi.registerTool({
        name: "route_web_search",
        label: "Route Web Search",
        description:
            "Search the web through your configured route proxy (OmniRoute / 9router). Sends the query to the proxy's /v1/search endpoint.",
        promptSnippet: "Search the web using the route proxy web search.",
        promptGuidelines: [
            "Use route_web_search when current or external web information is needed.",
            "The route parameter is optional; omit it to use the default search route.",
        ],
        parameters: Type.Object({
            query: Type.String({ description: "Search query." }),
            route: Type.Optional(
                Type.String({
                    description:
                        "Optional route proxy search route, provider alias, or combo name.",
                }),
            ),
            max_results: Type.Optional(
                Type.Number({
                    description: "Max results (1-20, default 5).",
                    minimum: 1,
                    maximum: 20,
                }),
            ),
            search_type: Type.Optional(
                Type.String({ description: 'Search type: "web" or "news".' }),
            ),
            country: Type.Optional(Type.String({ description: "Country/region hint." })),
            language: Type.Optional(Type.String({ description: "Language hint, e.g. en." })),
            time_range: Type.Optional(
                Type.String({ description: "Recency filter: day, week, month, year." }),
            ),
            offset: Type.Optional(
                Type.Number({ description: "Result offset for pagination.", minimum: 0 }),
            ),
            domain_filter: Type.Optional(
                Type.Array(Type.String(), { description: "Domain include/exclude filters." }),
            ),
        }),
        async execute(_toolCallId, params, signal, onUpdate, _ctx) {
            const maxResults = clamp(params.max_results, 5, 1, 20);
            const body: Record<string, unknown> = {
                model: params.route || "default",
                query: params.query,
                max_results: maxResults,
            };
            for (const key of [
                "search_type",
                "country",
                "language",
                "time_range",
                "offset",
                "domain_filter",
            ] as const) {
                if (params[key] !== undefined) body[key] = params[key];
            }

            onUpdate?.({
                content: [{ type: "text", text: `Searching via route proxy...` }],
                details: {},
            });

            const payload = await postJSON(baseUrl, "/v1/search", body, apiKey, signal, false);
            return {
                content: [{ type: "text", text: formatSearch(params.query, payload) }],
                details: {},
            };
        },
    });

    // ── route_web_fetch ───────────────────────────────────────────
    //
    // Maps to POST /v1/web/fetch on OmniRoute.
    // Server-side parameters (from open-sse/handlers/webFetch.ts):
    //   url, model → provider resolution, format ("markdown"|"html"|"links"|"screenshot"),
    //   include_metadata
    // Note: depth and wait_for_selector are defined in the interface but
    //       broken on firecrawl (the primary provider) — omitted.
    // max_characters is client-side-only: returned text is truncated locally.
    //
    pi.registerTool({
        name: "route_web_fetch",
        label: "Route Web Fetch",
        description:
            "Fetch and extract a URL through your configured route proxy (OmniRoute / 9router). Sends the URL to the proxy's /v1/web/fetch endpoint.",
        promptSnippet: "Fetch/extract URL content using the route proxy web fetch.",
        promptGuidelines: [
            "Use route_web_fetch when asked to read, fetch, extract, or summarize a specific URL.",
            "The route parameter is optional; omit it to use the default fetch route.",
        ],
        parameters: Type.Object({
            url: Type.String({ description: "URL to fetch and extract." }),
            route: Type.Optional(
                Type.String({
                    description: "Optional route proxy fetch route, provider alias, or combo name.",
                }),
            ),
            format: Type.Optional(
                Type.String({
                    description: 'Output format: "markdown", "html", "links", or "screenshot".',
                }),
            ),
            include_metadata: Type.Optional(
                Type.Boolean({
                    description: "Include page metadata (title, description) in response.",
                }),
            ),
            max_characters: Type.Optional(
                Type.Number({
                    description:
                        "Max characters for client-side truncation (1-50000, default 12000). Server always returns full content, truncated locally.",
                    minimum: 1,
                    maximum: 50000,
                }),
            ),
        }),
        async execute(_toolCallId, params, signal, onUpdate, _ctx) {
            const maxChars = clamp(params.max_characters, 12000, 1, 50000);
            const body: Record<string, unknown> = {
                model: params.route || "default",
                url: params.url,
                format: params.format || "markdown",
            };
            if (params.include_metadata !== undefined) {
                body.include_metadata = params.include_metadata;
            }

            onUpdate?.({
                content: [{ type: "text", text: `Fetching URL via route proxy...` }],
                details: {},
            });

            const payload = await postJSON(baseUrl, "/v1/web/fetch", body, apiKey, signal, false);
            return {
                content: [{ type: "text", text: formatFetch(payload, maxChars) }],
                details: {},
            };
        },
    });
}
