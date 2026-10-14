// Test: bounded + semantic compaction summary composition.
// Run from repo root: node .script/test/blackhole/summary.test.mjs
//
// compileVccSummary is a pure function (git lookups fail closed outside a repo),
// so every case runs against a temp cwd with no filesystem writes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestJiti, importProd, runCases, textMsg, toolMsg } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const { compileVccSummary, SUMMARY_MAX_CHARS } = await importProd(
    jiti,
    "agent/extensions/blackhole/compaction.js",
);
assert.equal(typeof compileVccSummary, "function");
assert.equal(SUMMARY_MAX_CHARS, 8000);

const CWD = mkdtempSync(join(tmpdir(), "bh-summary-"));
const OM = [
    "#### Key Reflections",
    "- [aaaaaaaaaaaa] the user wants bounded summaries",
    "",
    "#### Key Observations",
    "- [bbbbbbbbbbbb] blackhole stores memory in agent/pi-blackhole",
].join("\n");
// Absolute fixture paths: collectTouchedFiles renders them relative to cwd.
const TOOLS = [toolMsg(join(CWD, "src/one.ts")), toolMsg(join(CWD, "src/two.ts"))];
const CHAT = [
    textMsg("user", "please fix the compactor so summaries stay small"),
    textMsg("assistant", "I will cap the summary and drop the verbatim blob"),
];

const bulletCount = (summary, marker) =>
    summary.split("\n").filter((l) => l.startsWith(`- ${marker}`)).length;

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("OM leads and there is no Previous Context section", () => {
    const summary = compileVccSummary({ messages: TOOLS, cwd: CWD, omSummary: OM });
    assert.ok(summary.startsWith("### Active Context & Insights"), summary.slice(0, 60));
    assert.ok(summary.includes("### Files Touched"), "files section missing");
    assert.ok(!summary.includes("### Previous Context"), "verbatim blob section returned");
});

test("conversation excerpt appears when there is no OM", () => {
    const summary = compileVccSummary({ messages: [...TOOLS, ...CHAT], cwd: CWD });
    assert.ok(summary.includes("### Recent Conversation"), "excerpt section missing");
    assert.ok(summary.includes("cap the summary"), "newest assistant text missing from excerpt");
});

test("plain path bullets are never carried", () => {
    const summary = compileVccSummary({
        messages: TOOLS,
        cwd: CWD,
        previousSummary: "### Files Touched\n- a/b/c.ts\n- d/e/f.ts",
    });
    assert.ok(!summary.includes("### Carried Context"), "path-only carry must be skipped");
});

test("a 60k previous summary is bounded and de-duplicated", () => {
    const previousSummary = Array.from(
        { length: 200 },
        (_, i) => `- decision-${String(i).padStart(3, "0")}: ${"x".repeat(300)}`,
    ).join("\n");
    const summary = compileVccSummary({ messages: TOOLS, cwd: CWD, previousSummary });
    assert.ok(summary.length <= SUMMARY_MAX_CHARS + 32, `not capped: ${summary.length}`);
    assert.ok(
        bulletCount(summary, "decision-") <= 12,
        `carry cap exceeded: ${bulletCount(summary, "decision-")}`,
    );
});

test("an oversized summary is truncated at the cap", () => {
    const manyTools = Array.from({ length: 400 }, (_, i) =>
        toolMsg(join(CWD, `src/dir-${i}`, `file-${i}.ts`)),
    );
    const summary = compileVccSummary({ messages: manyTools, cwd: CWD });
    assert.ok(summary.length <= SUMMARY_MAX_CHARS + 32, `not capped: ${summary.length}`);
    assert.ok(summary.endsWith("... (summary truncated)"), "missing truncation suffix");
});

test("three successive compactions do not ratchet", () => {
    const base = { messages: [...TOOLS, ...CHAT], cwd: CWD, omSummary: OM };
    const s1 = compileVccSummary(base);
    const s2 = compileVccSummary({ ...base, previousSummary: s1 });
    const s3 = compileVccSummary({ ...base, previousSummary: s2 });
    assert.ok(s3.length <= SUMMARY_MAX_CHARS + 32, `s3 exceeded cap: ${s3.length}`);
    assert.ok(s3.length <= s1.length * 1.1 + 1, `ratchet detected: ${s1.length} -> ${s3.length}`);
    assert.ok(s2.length <= s1.length * 1.1 + 1, `ratchet detected: ${s1.length} -> ${s2.length}`);
});

test("bullets already present are not duplicated", () => {
    const shared = "- [aaaaaaaaaaaa] the user wants bounded summaries";
    const summary = compileVccSummary({
        messages: TOOLS,
        cwd: CWD,
        omSummary: OM,
        previousSummary: `### Carried Context\n${shared}`,
    });
    assert.equal(summary.split(shared).length - 1, 1, "duplicate bullet in summary");
});

test("memory yields to the structural sections inside the budget", () => {
    const bigOm = `#### Key Reflections\n${Array.from(
        { length: 120 },
        (_, i) => `- [${String(i).padStart(12, "0")}] reflection text ${"y".repeat(160)}`,
    ).join("\n")}`;
    const summary = compileVccSummary({ messages: TOOLS, cwd: CWD, omSummary: bigOm });
    assert.ok(summary.includes("### Active Context & Insights"), "memory section missing");
    assert.ok(summary.includes("### Files Touched"), "memory starved the files section");
    assert.ok(summary.includes("... (memory truncated)"), "memory section not bounded");
    assert.ok(summary.length <= SUMMARY_MAX_CHARS + 32, `not capped: ${summary.length}`);
});

test("a larger budget keeps memory and structure together", () => {
    const bigOm = `#### Key Observations\n${Array.from(
        { length: 60 },
        (_, i) => `- [${String(i).padStart(12, "0")}] observation text ${"z".repeat(160)}`,
    ).join("\n")}`;
    const summary = compileVccSummary({
        messages: [...TOOLS, ...CHAT],
        cwd: CWD,
        omSummary: bigOm,
        maxChars: 24000,
    });
    for (const header of [
        "### Active Context & Insights",
        "### Recent Conversation",
        "### Files Touched",
    ]) {
        assert.ok(summary.includes(header), `${header} missing from a large-budget summary`);
    }
    assert.ok(summary.length <= 24000 + 32, `over budget: ${summary.length}`);
    assert.ok(!summary.includes("... (summary truncated)"), "large budget must not truncate");
});

test("the subagent snapshot contract still holds", () => {
    const summary = compileVccSummary({
        messages: TOOLS,
        cwd: CWD,
        previousSummary: "### Carried Context\n- prior decision worth keeping",
    });
    assert.ok(summary.includes("### Files Touched"), "snapshot asserts this header");
    assert.ok(summary.includes("- src/one.ts"), "touched path missing");
    assert.ok(!summary.includes("{previous}"), "template token must never be emitted");
    assert.ok(summary.includes("- prior decision worth keeping"), "decision carry lost");
});

try {
    await runCases(cases, `\nblackhole summary bounds (cap=${SUMMARY_MAX_CHARS})`);
} finally {
    rmSync(CWD, { recursive: true, force: true });
}
