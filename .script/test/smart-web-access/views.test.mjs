// Run from repo root: node .script/test/smart-web-access/views.test.mjs
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const views = await importProd(jiti, "agent/extensions/smart-web-access/views.js");
const { applyReadingView, validateReadingViewRequest, MAX_TOC_ENTRIES, FOCUS_PASSAGE_CHARS } =
    views;
const fetchMod = await importProd(jiti, "agent/extensions/smart-web-access/fetch.js");
const { Marked } = await import("@earendil-works/pi-tui");

// The fence is the mutant detector: its first line looks like an ATX heading
// but marked lexes it as a code token, so no offset may treat it as one.
const FENCE = ["```", "# not a heading", "echo done", "```"].join("\n");
const LONG_BODY = Array.from(
    { length: 60 },
    (_, index) => `Filler line ${index + 1} about widgets and their properties.`,
).join("\n");

// Headings in document order: 1 Installation, 2 Verifying the install,
// 3 Installation (duplicate text), 4 Usage, 5 Long chapter.
const FIXTURE = [
    "Intro paragraph before any heading, with words to count.",
    "",
    "## Installation",
    "",
    "Install by running the package manager. Run the installer twice before the installer finishes.",
    "",
    "### Verifying the install",
    "",
    "Check the version output matches what you expected.",
    "",
    FENCE,
    "",
    "## Installation",
    "",
    "The second installation section repeats the earlier heading text on purpose and mentions the installer once.",
    "",
    "## Usage",
    "",
    "Call the tool with a url and a query argument.",
    "",
    "| Column | Meaning |",
    "| --- | --- |",
    "| toc | outline of headings |",
    "",
    "## Long chapter",
    "",
    LONG_BODY,
    "",
].join("\n");

const words = (text) => text.trim().match(/\S+/g)?.length ?? 0;
const tocLines = (text) => text.split("\n").filter((line) => /^\s*\d+\. /.test(line));

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("lexer round-trip: token raw fields concatenate back to the input", () => {
    const tokens = new Marked().lexer(FIXTURE);
    assert.equal(tokens.map((token) => token.raw).join(""), FIXTURE);
});

test("toc lists headings in document order with 1-based numbers, not the fenced line", () => {
    const { text } = applyReadingView(FIXTURE, { kind: "toc" });

    assert.ok(text.startsWith("Outline: 5 headings"), text.split("\n")[0]);
    const lines = tocLines(text);
    assert.deepEqual(
        lines.map((line) => line.trim()),
        [
            "1. Installation",
            "2. Verifying the install",
            "3. Installation",
            "4. Usage",
            "5. Long chapter",
        ],
    );
    assert.ok(!text.includes("not a heading"), "the fenced # line became a heading");
});

test("toc indents a child heading and caps at MAX_TOC_ENTRIES", () => {
    const { text } = applyReadingView(FIXTURE, { kind: "toc" });
    assert.ok(text.includes("\n  2. Verifying the install"), "child heading not indented");

    const repeated = Array.from({ length: 60 }, () => FIXTURE).join("\n");
    const capped = applyReadingView(repeated, { kind: "toc" }).text;
    assert.equal(tocLines(capped).length, MAX_TOC_ENTRIES);
    assert.ok(
        capped.endsWith(`... ${60 * 5 - MAX_TOC_ENTRIES} more headings (narrow with focus).`),
        capped.split("\n").at(-1),
    );
});

test('section "1" returns its own body and its child, and stops before heading 3', () => {
    const { text } = applyReadingView(FIXTURE, { kind: "section", target: "1" });

    assert.ok(text.startsWith("Section 1 of 5 · Installation"), text.split("\n")[0]);
    assert.ok(text.includes("Run the installer twice"), "own body missing");
    assert.ok(text.includes("### Verifying the install"), "child heading missing");
    assert.ok(text.includes("Check the version output"), "child body missing");
    assert.ok(!text.includes("## Usage"), "subtree ran past the next same-level heading");
    assert.ok(!text.includes("Call the tool"), "sibling body leaked in");
});

test("section by text is case-insensitive and reports an ambiguous match", () => {
    const exact = applyReadingView(FIXTURE, { kind: "section", target: "usage" }).text;
    assert.ok(exact.startsWith("Section 4 of 5 · Usage"), exact.split("\n")[0]);

    const ambiguous = applyReadingView(FIXTURE, { kind: "section", target: "INSTALLATION" }).text;
    assert.ok(ambiguous.startsWith("Section 1 of 5 · Installation"), ambiguous.split("\n")[0]);
    assert.ok(
        ambiguous.includes('(matched "INSTALLATION" among 2 headings)'),
        "ambiguity note missing",
    );
});

test("section with no match names the existing sections", () => {
    const { error } = applyReadingView(FIXTURE, { kind: "section", target: "99" });
    assert.ok(error, "expected an error");
    assert.ok(error.startsWith('No section matches "99". Sections: 1. Installation'), error);
});

test("focus ranks the best-matching section first and carries its heading path", () => {
    const { text } = applyReadingView(FIXTURE, { kind: "focus", query: "installer" });

    assert.ok(text.startsWith('Focus "installer": '), text.split("\n")[0]);
    assert.ok(text.includes("### Installation"), "heading path missing");
    const best = text.indexOf("Run the installer twice");
    const runnerUp = text.indexOf("The second installation section");
    assert.ok(best > 0, "best section missing");
    assert.ok(runnerUp > best, "the weaker section was not ranked after the best one");
});

test("focus errors when nothing usable is left", () => {
    assert.deepEqual(applyReadingView(FIXTURE, { kind: "focus", query: "!!!" }), {
        error: "focus needs at least one word to match.",
    });
    const { error } = applyReadingView(FIXTURE, { kind: "focus", query: "zebra" });
    assert.equal(error, "No section mentions zebra.");
});

test("focus cuts a long passage and marks the cut", () => {
    const { text } = applyReadingView(FIXTURE, { kind: "focus", query: "widgets" });
    const passage = text.slice(text.indexOf("Filler line 1"));

    assert.ok(text.includes("### Long chapter"), "heading path missing");
    assert.ok(passage.length <= FOCUS_PASSAGE_CHARS + 2, `passage was ${passage.length} chars`);
    assert.ok(/properties\. …$/.test(passage), passage.slice(-60));
});

test("validateReadingViewRequest rejects two views and markdown-less formats", () => {
    assert.equal(
        validateReadingViewRequest({ toc: true, section: "3" }),
        "Pass only one of toc, section, focus (got: toc, section).",
    );
    assert.equal(
        validateReadingViewRequest({ toc: true, focus: "x" }),
        "Pass only one of toc, section, focus (got: toc, focus).",
    );
    assert.equal(
        validateReadingViewRequest({ toc: true, format: "html" }),
        'toc reads the extracted markdown, which format "html" does not produce. Drop format or use "markdown" or "text".',
    );
    assert.equal(validateReadingViewRequest({ toc: true, format: "text" }), undefined);
    assert.equal(validateReadingViewRequest({ toc: true, format: "markdown" }), undefined);
    assert.equal(validateReadingViewRequest({}), undefined);
    assert.equal(validateReadingViewRequest({ toc: false }), undefined);
    assert.equal(validateReadingViewRequest({ section: "" }), undefined);
    assert.equal(validateReadingViewRequest({ focus: "   " }), undefined);
});

// ── Wiring: the view runs inside the fetch pipeline ──────────────────────────

const fakeResponse = (contentType, body) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://example.test/doc",
    headers: {
        get: (name) => (name.toLowerCase() === "content-type" ? contentType : null),
    },
    body: null,
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    readable() {
        throw new Error("unused");
    },
});

const DOCUMENT_HTML = "<html><body><article><h1>T</h1><p>x</p></article></body></html>";

const createImpl = (contentType = "text/html; charset=utf-8", body = DOCUMENT_HTML) =>
    fetchMod.createDefuddleFetch({
        fetch: async () => fakeResponse(contentType, body),
        defuddle: async () => ({ content: FIXTURE, wordCount: 40, title: "T", site: "example" }),
        getProfiles: () => ["chrome_145"],
    });

test("a toc view returns the outline with a wordCount of what it returned", async () => {
    const result = await createImpl()({
        url: "https://example.test/doc",
        format: "markdown",
        view: { kind: "toc" },
    });

    assert.equal(result.kind, "content");
    assert.ok(result.content.startsWith("Outline:"), result.content.slice(0, 40));
    assert.equal(result.wordCount, words(result.content));
    assert.notEqual(result.wordCount, 40, "wordCount still describes the document");
});

test("a section view with no matching heading is a non-retryable processing error", async () => {
    const result = await createImpl()({
        url: "https://example.test/doc",
        format: "markdown",
        view: { kind: "section", target: "nope" },
    });

    assert.equal(result.code, "processing_error");
    assert.equal(result.retryable, false);
    assert.ok(result.error.startsWith('No section matches "nope".'), result.error);
});

test("a view on a plain-text response is an error, not a silent no-op", async () => {
    const result = await createImpl("text/plain; charset=utf-8", "hello world")({
        url: "https://example.test/doc",
        format: "markdown",
        view: { kind: "toc" },
    });

    assert.equal(result.code, "processing_error");
    assert.equal(result.retryable, false);
    assert.ok(result.error.includes("plain text"), result.error);
});

test("executeFetchToolCall rejects a view with format html before any request", async () => {
    const result = await fetchMod.executeFetchToolCall(
        { url: "https://example.test/doc", format: "html", toc: true },
        {},
    );

    assert.equal(result.code, "processing_error");
    assert.equal(result.retryable, false);
    assert.ok(result.error.includes("markdown"), result.error);
});

await runCases(cases, "\nsmart-web-access views");
