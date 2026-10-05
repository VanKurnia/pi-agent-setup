import { fetch } from "wreq-js";
import { Defuddle } from "defuddle/node";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseLinkedomHTML } from "./dom.js";
import type {
    PageFetchResult,
    QueryProgress,
    SearchResultLink,
    WebSearchDetails,
} from "./types.js";

// =============================================================================
// Rate-limited Fetching for Search Results
// =============================================================================

const MIN_MS_BETWEEN_FETCHES = 1_000;
const EXTRA_RANDOM_WAIT_MS = 400;

let lastFetchStartedAt = 0;
let fetchQueue: Promise<void> = Promise.resolve();

async function waitBeforeNextFetch(): Promise<void> {
    const currentWait = fetchQueue.then(async () => {
        const waitFor = MIN_MS_BETWEEN_FETCHES + Math.floor(Math.random() * EXTRA_RANDOM_WAIT_MS);
        const elapsed = Date.now() - lastFetchStartedAt;
        if (elapsed < waitFor) {
            await new Promise((resolve) => setTimeout(resolve, waitFor - elapsed));
        }
        lastFetchStartedAt = Date.now();
    });
    fetchQueue = currentWait.catch(() => {});
    await currentWait;
}

async function fetchReadablePage(url: string, resultsPerQuery: number): Promise<PageFetchResult> {
    try {
        await waitBeforeNextFetch();
        const response = await fetch(url, {
            browser: "chrome_147",
            os: "windows",
            headers: {
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            timeout: 12_000,
        });

        if (response.status === 202) {
            return {
                ok: false,
                requestedUrl: url,
                error: "rate-limited by search engine (HTTP 202 soft-ban); wait ~60s before retrying",
            };
        }

        if (!response.ok) {
            return {
                ok: false,
                requestedUrl: url,
                error: `HTTP ${response.status} ${response.statusText}`,
            };
        }

        const finalUrl = response.url;
        const page = parseLinkedomHTML(await response.text(), finalUrl);

        keepFirstResults(page, resultsPerQuery);
        const extraction = await Defuddle(page, finalUrl, {
            markdown: true,
            removeImages: true,
        });

        return {
            ok: true,
            requestedUrl: url,
            finalUrl,
            title: extraction.title ?? "",
            readableText: extraction.content?.trim() ?? "",
            links: readResultLinks(page),
        };
    } catch (caught) {
        return {
            ok: false,
            requestedUrl: url,
            error: caught instanceof Error ? caught.message : String(caught),
        };
    }
}

// =============================================================================
// Parsing DuckDuckGo HTML
// =============================================================================

function findAll(page: Document, selector: string) {
    return Array.from(page.querySelectorAll(selector));
}

function keepFirstResults(page: Document, count: number): void {
    for (const surplus of findAll(page, "div.result").slice(count)) {
        surplus.remove();
    }
}

function readResultLinks(page: Document): SearchResultLink[] {
    return findAll(page, "a.result__a").map((anchor) => ({
        title: anchor.textContent?.trim() ?? "",
        url: unwrapRedirect(anchor.getAttribute("href") ?? ""),
    }));
}

/** Percent-decode, keeping the raw value when the provider emits bad encoding. */
function decodeSafely(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function unwrapRedirect(href: string): string {
    const escapedUrl = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    return escapedUrl ? decodeSafely(escapedUrl) : href;
}

// =============================================================================
// Search Settings & URL Construction
// =============================================================================

const SEARCH_URL_TEMPLATE = "https://html.duckduckgo.com/html/?q={query}";

function buildSearchUrl(query: string): string {
    return SEARCH_URL_TEMPLATE.replace("{query}", encodeURIComponent(query));
}

const DEFAULT_RESULTS_PER_QUERY = 5;
const MIN_RESULTS_PER_QUERY = 1;
const MAX_RESULTS_PER_QUERY = 10;

function clamp(value: number, lowest: number, highest: number): number {
    return Math.min(highest, Math.max(lowest, value));
}

interface SettingsFile {
    smartWebSearch?: { resultsPerQuery?: unknown };
}

async function readResultsPerQueryFrom(file: string): Promise<number | undefined> {
    let settings: SettingsFile;
    try {
        settings = JSON.parse(await readFile(file, "utf-8")) as SettingsFile;
    } catch {
        return undefined;
    }

    const configured = settings.smartWebSearch?.resultsPerQuery;
    if (typeof configured !== "number" || !Number.isFinite(configured)) return undefined;
    return Math.floor(configured);
}

async function loadResultsPerQuery(
    cwd: string,
    userSettingsDir: string = getAgentDir(),
): Promise<number> {
    const projectSettings = join(cwd, ".pi", "settings.json");
    const userSettings = join(userSettingsDir, "settings.json");

    const resultsPerQuery =
        (await readResultsPerQueryFrom(projectSettings)) ??
        (await readResultsPerQueryFrom(userSettings)) ??
        DEFAULT_RESULTS_PER_QUERY;

    return clamp(resultsPerQuery, MIN_RESULTS_PER_QUERY, MAX_RESULTS_PER_QUERY);
}

// =============================================================================
// Markdown Post-processing & Formatting
// =============================================================================

function numberResultHeadings(markdown: string): string {
    let resultNumber = 0;
    return markdown.replace(/^## /gm, () => {
        resultNumber += 1;
        return `## ${resultNumber}. `;
    });
}

function demoteHeadings(markdown: string): string {
    return markdown.replace(/^(#{1,5}) /gm, "#$1 ");
}

function labelReadsAsProse(label: string): boolean {
    return /\s/.test(label.trim());
}

function flattenMarkdownLinks(markdown: string): string {
    const markdownLink = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
    return markdown.replace(markdownLink, (_whole, label: string, address: string) =>
        labelReadsAsProse(label) ? label : address,
    );
}

function expandRedirectLinks(markdown: string): string {
    const redirectLink =
        /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*?\buddg=([^&)\s"'<>]+)[^)\s"'<>]*/gi;

    return markdown.replace(redirectLink, (_whole, escapedUrl: string) => decodeSafely(escapedUrl));
}

function cleanUpLinks(markdown: string): string {
    return flattenMarkdownLinks(expandRedirectLinks(markdown));
}

const FETCH_TOOL_NAME = "web_fetch";
const SEARCH_RESULTS_HEADER = "# Search results by query";
const LINK_SUMMARY_HEADER = "# Read these pages";

const FETCH_INSTRUCTION =
    `Open the most relevant links below before answering -- ${FETCH_TOOL_NAME} for each page, ` +
    "several in parallel through codemode when more than one is needed. Pick the few that best " +
    "answer the question rather " +
    "than the whole list. These previews are brief and may be out of date; skip fetching only if " +
    "they already fully answer the question.";

function renderQuerySection(entry: QueryProgress): string {
    const heading = `## Query: "${entry.query}"`;
    const result = entry.result;

    if (!result?.ok) {
        return `${heading}\n_search failed: ${result?.error ?? "unknown"}_\n`;
    }

    const withPlainLinks = cleanUpLinks(result.readableText);
    const withNumberedResults = numberResultHeadings(withPlainLinks);
    const snippets = demoteHeadings(withNumberedResults);

    return `${heading}\n${snippets || "_no content extracted_"}\n`;
}

function renderSearchResults(searches: QueryProgress[]): string {
    return [SEARCH_RESULTS_HEADER, ...searches.map(renderQuerySection)].join("\n");
}

function renderLinkSummary(searches: QueryProgress[]): string {
    const blocks: string[] = [];

    for (const entry of searches) {
        if (!entry.result?.ok || entry.result.links.length === 0) continue;
        const links = entry.result.links.map(
            (link, index) => `${index + 1}. [${link.title}](${link.url})`,
        );
        blocks.push(`## ${entry.query}\n${links.join("\n")}`);
    }

    if (blocks.length === 0) return "";

    return [LINK_SUMMARY_HEADER, "", FETCH_INSTRUCTION, "", blocks.join("\n\n")].join("\n");
}

function renderToolResult(searches: QueryProgress[]): string {
    const summary = renderLinkSummary(searches);
    const sections = [renderSearchResults(searches)];
    if (summary) sections.push(summary);
    return sections.join("\n");
}

// =============================================================================
// Tool Execution Entry Point
// =============================================================================

export async function executeWebSearch(
    queries: string[],
    cwd: string,
    onProgress?: (progressByQuery: QueryProgress[]) => void,
): Promise<{ text: string; details: WebSearchDetails }> {
    const resultsPerQuery = await loadResultsPerQuery(cwd);

    const progressByQuery: QueryProgress[] = queries.map((query) => ({
        query,
        status: "queued",
        result: undefined,
    }));

    const reportProgress = () => onProgress?.(progressByQuery);
    reportProgress();

    for (const entry of progressByQuery) {
        entry.status = "loading";
        reportProgress();

        entry.result = await fetchReadablePage(buildSearchUrl(entry.query), resultsPerQuery);
        entry.status = entry.result.ok ? "done" : "error";
        reportProgress();
    }

    return {
        text: renderToolResult(progressByQuery),
        details: { progressByQuery },
    };
}
