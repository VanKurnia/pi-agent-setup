// Test: every tool the model sees declares a complete, non-redundant string set.
// Run from repo root: node .script/test/tools/tool-surface.test.mjs
//
// Loads the eight extension entry files that declare those strings through the harness
// as the other model-free tests, captures every registered tool through a
// recording stub, and asserts the four gate properties: exact per-file
// coverage, a non-empty promptSnippet, snippet shape, and no restatement
// across the three surfaces. No model calls, no session writes.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();

// Only the ExtensionAPI methods the eight factories call at load time, so a new
// load-time dependency fails loudly instead of being silently absorbed.
const tools = {};
const byFile = {};
const piStub = {
    on: () => {},
    registerTool: (tool) => {
        tools[tool.name] = tool;
    },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
};

const entries = {
    "agent/extensions/ask-user-question.js": ["ask_user_question"],
    "agent/extensions/blackhole/index.js": ["recall"],
    "agent/extensions/db-viewer/index.js": ["query_sqlite", "query_mysql", "db_status", "db_save"],
    "agent/extensions/ninerouter.js": ["ninerouter_web_search", "ninerouter_web_fetch"],
    "agent/extensions/open-code-review/index.js": ["ocr_review", "ocr_scan", "ocr_health"],
    "agent/extensions/session-mgr/index.js": ["rename_session"],
    "agent/extensions/smart-web-access/index.js": ["web_search", "web_fetch"],
    "agent/extensions/subagents/index.js": ["subagent"],
};

for (const [relPath, expected] of Object.entries(entries)) {
    const mod = await importProd(jiti, relPath);
    const factory = mod.default ?? mod;
    assert.equal(typeof factory, "function", `${relPath} factory missing`);
    const before = new Set(Object.keys(tools));
    factory(piStub);
    byFile[relPath] = Object.keys(tools).filter((name) => !before.has(name));
    for (const name of expected) {
        assert.ok(tools[name], `${relPath} did not register ${name}`);
    }
}

const scoped = Object.values(entries).flat();
for (const name of scoped) {
    const tool = tools[name];
    const guidelines = tool.promptGuidelines ?? [];
    console.log(
        `${name} snippet=${tool.promptSnippet?.length ?? 0} desc=${tool.description?.length ?? 0} guidelines=${guidelines.length}`,
    );
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();
const normalized = (s) => collapse(s).replace(/\.\s*$/, "");

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("each entry file registers exactly its expected tools", () => {
    for (const [relPath, expected] of Object.entries(entries)) {
        assert.deepEqual(
            [...byFile[relPath]].sort(),
            [...expected].sort(),
            `${relPath} registered unexpected tools`,
        );
    }
});

test("every tool has a non-empty promptSnippet", () => {
    for (const name of scoped) {
        const snippet = tools[name].promptSnippet;
        assert.ok(
            typeof snippet === "string" && snippet.trim().length > 0,
            `${name}: no promptSnippet — pi will not list this tool in the tools block`,
        );
    }
});

test("snippets are single-line, at most 120 chars, with no parameter marks", () => {
    for (const name of scoped) {
        const snippet = tools[name].promptSnippet;
        assert.ok(!snippet.includes("\n"), `${name}: snippet spans multiple lines`);
        assert.ok(
            snippet.length <= 120,
            `${name}: snippet is ${snippet.length} chars (max 120): ${snippet}`,
        );
        assert.ok(
            !snippet.includes("?"),
            `${name}: snippet restates optional parameters: ${snippet}`,
        );
    }
});

test("no guideline restates its own snippet/description or duplicates another", () => {
    for (const name of scoped) {
        const tool = tools[name];
        const snippet = normalized(tool.promptSnippet ?? "");
        const description = normalized(tool.description ?? "");
        const guidelines = tool.promptGuidelines ?? [];
        const seen = new Set();
        for (const guideline of guidelines) {
            const text = normalized(guideline);
            assert.ok(text.length > 0, `${name}: empty guideline after whitespace collapse`);
            assert.notEqual(
                text,
                snippet,
                `${name}: guideline restates the snippet: ${collapse(guideline).slice(0, 120)}`,
            );
            assert.notEqual(
                text,
                description,
                `${name}: guideline restates the description: ${collapse(guideline).slice(0, 120)}`,
            );
            assert.ok(
                !seen.has(text),
                `${name}: duplicate guideline: ${collapse(guideline).slice(0, 120)}`,
            );
            seen.add(text);
        }
    }
});

await runCases(cases, "\ntool surface");
