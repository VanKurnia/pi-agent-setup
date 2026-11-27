/**
 * Reading views over an extracted markdown document: an outline (`toc`), one
 * numbered section (`section`), or the sections that best match a query
 * (`focus`).
 *
 * The views are a pure function over the markdown the fetch pipeline already
 * produces, so they stay independent of `fetch.ts` (which imports this module).
 * Headings come from marked's lexer, not a line regex: an unlabeled fence whose
 * lines start with `#` is a `code` token, so it cannot become a phantom heading.
 */
import { Marked, type Token } from "@earendil-works/pi-tui";
import { truncateChars } from "../shared/text-format.ts";

export type ReadingView =
    | { kind: "toc" }
    | { kind: "section"; target: string }
    | { kind: "focus"; query: string };

export interface ReadingViewResult {
    /** Markdown for the tool result body. Starts with one summary line. */
    text: string;
    /** Words in `text`, so the caller's wordCount describes what it received. */
    wordCount: number;
}

interface Section {
    number: number;
    depth: number;
    heading: string;
    startOffset: number;
    bodyStart: number;
    /** Where the next heading of any depth begins: the section's own body only. */
    bodyEnd: number;
    /** Where the next heading at the same or a higher level begins: the subtree. */
    endOffset: number;
}

export const MAX_TOC_ENTRIES = 200;
const MAX_TOC_HEADING_CHARS = 120;
const MAX_TOC_INDENT_DEPTH = 6;
const FOCUS_SECTIONS = 5;
export const FOCUS_PASSAGE_CHARS = 1_200;
const K1 = 1.2;
const B = 0.75;

const STOPWORDS = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "for",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "with",
    "on",
    "at",
    "by",
    "from",
    "that",
    "this",
    "it",
    "its",
    "as",
    "if",
    "how",
    "what",
    "when",
    "why",
    "which",
    "do",
    "does",
    "not",
    "can",
    "you",
    "your",
]);

function lex(markdown: string): Token[] {
    return new Marked().lexer(markdown);
}

/**
 * Sections in document order, numbered across the whole document whatever the
 * heading depths are. Offsets are the running sum of `token.raw`, which
 * concatenates back to the input, so every slice is exact.
 */
function buildSections(markdown: string): Section[] {
    const headings: { depth: number; heading: string; startOffset: number; bodyStart: number }[] =
        [];
    let offset = 0;
    for (const token of lex(markdown)) {
        if (token.type === "heading") {
            headings.push({
                depth: token.depth,
                heading: token.text.trim(),
                startOffset: offset,
                bodyStart: offset + token.raw.length,
            });
        }
        offset += token.raw.length;
    }

    return headings.map((own, index) => {
        let endOffset = markdown.length;
        for (let next = index + 1; next < headings.length; next++) {
            if (headings[next].depth <= own.depth) {
                endOffset = headings[next].startOffset;
                break;
            }
        }
        return {
            number: index + 1,
            depth: own.depth,
            heading: own.heading,
            startOffset: own.startOffset,
            bodyStart: own.bodyStart,
            bodyEnd:
                index + 1 < headings.length ? headings[index + 1].startOffset : markdown.length,
            endOffset,
        };
    });
}

/** Ancestor headings of a section, its own heading last. */
function headingPath(sections: Section[], index: number): string[] {
    const path: string[] = [sections[index].heading];
    let depth = sections[index].depth;
    for (let previous = index - 1; previous >= 0; previous--) {
        if (sections[previous].depth < depth) {
            path.unshift(sections[previous].heading);
            depth = sections[previous].depth;
        }
    }
    return path;
}

function countWords(text: string): number {
    return text.trim().match(/\S+/g)?.length ?? 0;
}

function tokenize(text: string): string[] {
    return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function result(text: string): ReadingViewResult {
    return { text, wordCount: countWords(text) };
}

function renderToc(markdown: string): ReadingViewResult | { error: string } {
    const sections = buildSections(markdown);
    if (sections.length === 0) {
        return {
            error: "No headings found in the extracted markdown, so toc has nothing to list.",
        };
    }

    const total = sections.length;
    const minDepth = Math.min(...sections.map((section) => section.depth));
    const lines = [
        `Outline: ${total} headings, ${countWords(markdown)} words in the full document. Read one with section: "<number>".`,
    ];
    for (const section of sections.slice(0, MAX_TOC_ENTRIES)) {
        const indent = "  ".repeat(Math.min(section.depth - minDepth, MAX_TOC_INDENT_DEPTH));
        lines.push(
            `${indent}${section.number}. ${truncateChars(section.heading, MAX_TOC_HEADING_CHARS)}`,
        );
    }
    if (total > MAX_TOC_ENTRIES) {
        lines.push(`... ${total - MAX_TOC_ENTRIES} more headings (narrow with focus).`);
    }
    return result(lines.join("\n"));
}

function renderSection(markdown: string, target: string): ReadingViewResult | { error: string } {
    const sections = buildSections(markdown);
    const trimmed = target.trim();

    let found: Section | undefined;
    let matches = 0;
    if (/^\d+$/.test(trimmed)) {
        found = sections[Number(trimmed) - 1];
    } else {
        const needle = trimmed.toLowerCase();
        const hits = sections.filter((section) => section.heading.toLowerCase().includes(needle));
        matches = hits.length;
        found = hits[0];
    }

    if (!found) {
        const listed = sections
            .slice(0, 8)
            .map((section) => `${section.number}. ${section.heading}`)
            .join(" · ");
        const suffix = sections.length > 8 ? ` (and ${sections.length - 8} more)` : "";
        return { error: `No section matches "${target}". Sections: ${listed}${suffix}` };
    }

    const path = headingPath(sections, found.number - 1).join(" › ");
    const body = markdown.slice(found.startOffset, found.endOffset);
    const note = matches > 1 ? `\n\n(matched "${target}" among ${matches} headings)` : "";
    return result(`Section ${found.number} of ${sections.length} · ${path}\n\n${body}${note}`);
}

function focusPassage(body: string): string {
    const passage = body.trim();
    if (passage.length <= FOCUS_PASSAGE_CHARS) return passage;
    const cut = truncateChars(passage, FOCUS_PASSAGE_CHARS);
    const lastBreak = cut.lastIndexOf("\n");
    return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut} …`;
}

function renderFocus(markdown: string, query: string): ReadingViewResult | { error: string } {
    const sections = buildSections(markdown);
    const allTerms = tokenize(query);
    let terms = [...new Set(allTerms.filter((term) => term.length > 2 && !STOPWORDS.has(term)))];
    if (terms.length === 0) terms = [...new Set(allTerms)];
    if (terms.length === 0) return { error: "focus needs at least one word to match." };

    // Score each section over its own body, not its subtree: a chapter heading
    // must not win on text its children repeat.
    const bodies = sections.map((section) => markdown.slice(section.bodyStart, section.bodyEnd));
    const loweredBodies = bodies.map((body) => body.toLowerCase());
    const lengths = bodies.map((body) => tokenize(body).length);
    const total = sections.length;
    const averageLength = Math.max(
        1,
        lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, total),
    );

    const scores = sections.map((section, index) => {
        const heading = section.heading.toLowerCase();
        const loweredBody = loweredBodies[index];
        let score = 0;
        for (const term of terms) {
            const matching = sections.filter(
                (other, otherIndex) =>
                    other.heading.toLowerCase().includes(term) ||
                    loweredBodies[otherIndex].includes(term),
            ).length;
            const idf = Math.log(1 + (total - matching + 0.5) / (matching + 0.5));
            const tf = loweredBody.split(term).length - 1;
            score +=
                idf *
                ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * lengths[index]) / averageLength)));
            if (heading.includes(term)) score += 2 * idf;
        }
        return { section, index, score };
    });

    const kept = scores
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, FOCUS_SECTIONS);

    if (kept.length === 0) {
        return { error: `No section mentions ${terms.join(", ")}.` };
    }

    const blocks = kept.map((entry) => {
        const path = headingPath(sections, entry.index).join(" › ");
        return `### ${path}\n\n${focusPassage(bodies[entry.index])}`;
    });
    return result(
        `Focus "${query}": ${kept.length} of ${total} sections, best first (full document: ${countWords(markdown)} words).\n\n${blocks.join("\n\n")}`,
    );
}

export function applyReadingView(
    markdown: string,
    view: ReadingView,
): ReadingViewResult | { error: string } {
    switch (view.kind) {
        case "toc":
            return renderToc(markdown);
        case "section":
            return renderSection(markdown, view.target);
        case "focus":
            return renderFocus(markdown, view.query);
    }
}

/**
 * `undefined` when the request may proceed. A blank `section`/`focus` counts as
 * absent, so it cannot substring-match every heading.
 */
export function validateReadingViewRequest(params: {
    toc?: boolean;
    section?: string;
    focus?: string;
    format?: string;
}): string | undefined {
    const present: string[] = [];
    if (params.toc === true) present.push("toc");
    if (typeof params.section === "string" && params.section.trim() !== "") present.push("section");
    if (typeof params.focus === "string" && params.focus.trim() !== "") present.push("focus");

    if (present.length > 1) {
        return `Pass only one of toc, section, focus (got: ${present.join(", ")}).`;
    }
    if (present.length === 0) return undefined;

    const format = params.format;
    if (format === "html" || format === "json" || format === "raw") {
        return `${present[0]} reads the extracted markdown, which format "${format}" does not produce. Drop format or use "markdown" or "text".`;
    }
    return undefined;
}
