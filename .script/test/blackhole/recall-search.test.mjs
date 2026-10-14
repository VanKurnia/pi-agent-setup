// Test: recall's search honours its advertised behaviour (regex + tool-call payloads).
// Run from repo root: node .script/test/blackhole/recall-search.test.mjs
//
// Harness shape copied from .script/test/subagent/recall.test.mjs: import the
// real extension factory, capture the registered tool, drive it with stub ctx.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases, textMsg } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const blackholeMod = await importProd(jiti, "agent/extensions/blackhole/index.js");
const { loadBlackholeConfig } = await importProd(jiti, "agent/extensions/blackhole/config.js");
const factory = blackholeMod.default ?? blackholeMod;
assert.equal(typeof factory, "function", "blackhole factory missing");

// Effective response budget, read from the same config the tool reads.
const MAX = loadBlackholeConfig().recallResponseMaxChars || 4000;
const LONG = MAX * 2 + 1000;

let recall;
const piStub = {
    on: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerTool: (tool) => {
        if (tool.name === "recall") recall = tool;
    },
};
factory(piStub);
assert.ok(recall, "recall tool not registered");

const MESSAGES = [
    textMsg("user", "ticket ABC-123 opened for the compactor"),
    textMsg("assistant", "literal needle appears here"),
    {
        role: "assistant",
        content: [
            {
                type: "toolCall",
                arguments: { path: "src/a.ts", content: "const UNIQUE_MARKER = 1;" },
            },
        ],
    },
    {
        role: "assistant",
        content: [
            {
                type: "toolCall",
                arguments: { path: "C:\\laragon\\www\\win-path.ts", content: "windows" },
            },
        ],
    },
    textMsg("assistant", "L".repeat(LONG)),
];

const ctxStub = {
    cwd: process.cwd(),
    sessionManager: {
        getSessionId: () => "recall-search-test",
        buildSessionProjection: () => ({ messages: MESSAGES }),
        getEntries: () => [],
    },
};

const out = async (params) => {
    const result = await recall.execute("call-1", params, undefined, undefined, ctxStub);
    return result.content.map((c) => c.text || "").join("");
};

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
test("regex patterns match (they used to be escaped into literals)", async () => {
    const text = await out({ query: "\\b[A-Z]{3}-\\d{3}\\b" });
    assert.ok(text.includes("ABC-123"), `regex miss: ${text.slice(0, 120)}`);
});

test("an invalid pattern falls back to a literal search", async () => {
    const bracket = await out({ query: "[unclosed" });
    assert.ok(bracket.startsWith("No matches") || bracket.includes("["), "must not throw");
    const paren = await out({ query: "(" });
    assert.ok(paren.startsWith("No matches"), `unexpected: ${paren.slice(0, 120)}`);
});

test("literal search is unchanged", async () => {
    const hit = await out({ query: "needle" });
    assert.ok(hit.includes("literal needle appears here"), "literal hit lost");
    const miss = await out({ query: "absent-needle" });
    assert.ok(miss.startsWith("No matches"), `unexpected: ${miss.slice(0, 120)}`);
});

test('mode:"file" searches write tool-call payloads', async () => {
    const text = await out({ query: "UNIQUE_MARKER", mode: "file" });
    assert.ok(text.includes("UNIQUE_MARKER"), `payload not searched: ${text.slice(0, 160)}`);
});

test('mode:"file" still reports misses', async () => {
    const text = await out({ query: "no-such-marker", mode: "file" });
    assert.ok(text.startsWith("No matches"), `unexpected: ${text.slice(0, 120)}`);
});

test("#N:file auto-selects the first file payload", async () => {
    const text = await out({ query: "#2:file" });
    assert.ok(text.includes("src/a.ts"), `auto-select failed: ${text.slice(0, 160)}`);
});

test("#N:text drill-down is unchanged", async () => {
    const text = await out({ query: "#1:text" });
    assert.ok(text.includes("literal needle"), `text drill-down lost: ${text.slice(0, 160)}`);
});

test("a long entry pages with :offset:limit and reports its range", async () => {
    const head = await out({ query: "#4:text" });
    assert.ok(head.includes(`[chars 0-${MAX} of ${LONG}]`), `bad range: ${head.slice(-120)}`);
    assert.ok(
        head.includes(`continue with #4:text:${MAX}:${MAX}`),
        `missing continuation hint: ${head.slice(-140)}`,
    );

    const middle = await out({ query: `#4:text:${MAX}:${MAX}` });
    assert.ok(
        middle.includes(`[chars ${MAX}-${MAX * 2} of ${LONG}]`),
        `bad window: ${middle.slice(-120)}`,
    );

    const tail = await out({ query: `#4:text:${LONG - 400}:${MAX}` });
    assert.ok(
        tail.includes(`[chars ${LONG - 400}-${LONG} of ${LONG}]`),
        `bad tail: ${tail.slice(-120)}`,
    );
    assert.ok(!tail.includes("continue with"), "last window must not advertise a next page");
});

test(":full returns the whole payload and still reports the length", async () => {
    const full = await out({ query: "#4:text:full" });
    assert.ok(full.includes("L".repeat(LONG)), "full payload was truncated");
    assert.ok(full.includes(`[chars 0-${LONG} of ${LONG}]`), `missing length: ${full.slice(-80)}`);
});

test("a Windows path keeps its colons as one selector", async () => {
    const text = await out({ query: "#3:C:\\laragon\\www\\win-path.ts" });
    assert.ok(text.includes("win-path.ts"), `selector split on colons: ${text.slice(0, 200)}`);
});

test("tool-call payloads window the same way", async () => {
    const text = await out({ query: "#2:file:0:20" });
    assert.ok(text.includes("[chars 0-20 of "), `missing range footer: ${text.slice(-120)}`);
});

await runCases(cases, "\nblackhole recall search");
