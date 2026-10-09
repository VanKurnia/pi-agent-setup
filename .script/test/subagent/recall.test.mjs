// Temp test: subagent child recall of parent memory (source:"parent").
// Run from repo root: node .script/test/subagent/recall.test.mjs
// Loads the real TS modules the way pi does (jiti). Registers a
// child->parent link the way the dispatcher does, then drives the real
// `recall` tool with stub sessions. No model calls, no session writes.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
    ROOT,
    createTestJiti,
    importProd,
    runCases,
    textMsg,
    toolMsg,
} from "./helpers.mjs";

// The default module cache stays ON: child->parent links live in a
// shared cross-extension registry, so the test must share module instances
// exactly like pi does in production (cf. smoke-tool-display.mjs, which
// opts out only because it shares no module state).
const jiti = await createTestJiti();

// Import order matters: subagents core registers the "subagents" API that
// blackhole's recall resolves lazily at execution time.
const core = await importProd(jiti, "agent/extensions/subagents/src/core.js");
const blackholeMod = await importProd(jiti, "agent/extensions/blackhole/index.js");
const factory = blackholeMod.default ?? blackholeMod;
assert.equal(typeof factory, "function", "blackhole factory missing");
for (const fn of ["registerChildSession", "unregisterChildSession", "resolveParentLink"]) {
    assert.equal(typeof core[fn], "function", `core.${fn} missing`);
}

const tools = {};
const pi = {
    on: () => {},
    registerCommand: () => {},
    registerTool: (t) => {
        tools[t.name] = t;
    },
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    events: { emit: () => {}, on: () => () => {} },
};
factory(pi);
const recall = tools.recall;
assert.ok(recall, "recall tool not registered");
assert.ok(
    JSON.stringify(recall.parameters).includes("parent"),
    "recall parameters lack source=parent",
);

// ── Stubs ─────────────────────────────────────────────────────────────────
const PARENT_MSGS = [
    textMsg("user", "parent goal is parent-secret-xyz, decided at parent-depth-7"),
    toolMsg("agent/extensions/blackhole/om.ts"),
];
const CHILD_MSGS = [textMsg("user", "child-only-text, fresh isolated session")];
const parentManager = {
    buildSessionProjection: () => ({ messages: PARENT_MSGS }),
    getEntries: () => PARENT_MSGS.map((message) => ({ type: "message", message })),
};
const childCtx = {
    cwd: ROOT,
    sessionManager: {
        getSessionId: () => "child-1",
        buildSessionProjection: () => ({ messages: CHILD_MSGS }),
        getEntries: () => CHILD_MSGS.map((message) => ({ type: "message", message })),
    },
};
const lonerCtx = {
    cwd: ROOT,
    sessionManager: {
        getSessionId: () => "loner-9",
        buildSessionProjection: () => ({ messages: CHILD_MSGS }),
        getEntries: () => CHILD_MSGS.map((message) => ({ type: "message", message })),
    },
};
// Dispatcher simulation: link child-1 -> parent.
core.registerChildSession("child-1", {
    parentSessionId: "parent-0",
    parentCwd: ROOT,
    parentSessionManager: parentManager,
});

const out = async (params, ctx = childCtx) =>
    (await recall.execute("call_1", params, undefined, undefined, ctx)).content[0]?.text ?? "";

// ── Cases ─────────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("default recall stays in own session (backward compatible)", async () => {
    // The no-match message echoes the query, so assert on the prefix.
    assert.ok((await out({ query: "parent-secret-xyz" })).startsWith("No matches"));
    assert.ok((await out({ query: "child-only-text" })).includes("child-only-text"));
});

test("source=parent keyword search hits parent history", async () => {
    const text = await out({ query: "parent-secret-xyz", source: "parent" });
    assert.ok(text.includes("parent-secret-xyz"), `no parent hit: ${text.slice(0, 120)}`);
});

test("source=parent #N expand + #N:text drill-down", async () => {
    assert.ok((await out({ query: "#1", source: "parent" })).includes("blackhole/om.ts"));
    assert.ok(
        (await out({ query: "#0:text", source: "parent" })).includes("parent-depth-7"),
        "parent #0:text missing",
    );
});

test("source=parent mode=touched lists parent files", async () => {
    const text = await out({ mode: "touched", source: "parent" });
    assert.ok(text.includes("agent/extensions/blackhole/om.ts"), `wrong touched set: ${text}`);
});

test("source=parent scope=all reads via getEntries", async () => {
    const text = await out({ query: "parent-depth-7", source: "parent", scope: "all" });
    assert.ok(text.includes("parent-depth-7"), `scope=all missed: ${text.slice(0, 120)}`);
});

test("unmapped session gets graceful message, not a throw", async () => {
    const text = await out({ query: "anything", source: "parent" }, lonerCtx);
    assert.ok(text.includes("No parent session linked"), `unexpected: ${text.slice(0, 120)}`);
});

test("parent output respects the char cap", async () => {
    const big = "B".repeat(20000);
    const bigManager = {
        buildSessionProjection: () => ({ messages: [textMsg("assistant", big)] }),
        getEntries: () => [],
    };
    core.registerChildSession("child-big", {
        parentSessionId: "parent-big",
        parentCwd: ROOT,
        parentSessionManager: bigManager,
    });
    const bigCtx = {
        cwd: ROOT,
        sessionManager: {
            getSessionId: () => "child-big",
            buildSessionProjection: () => ({ messages: [] }),
            getEntries: () => [],
        },
    };
    const text = await out({ query: "#0", source: "parent" }, bigCtx);
    assert.ok(text.length <= 4096, `cap exceeded: ${text.length}`);
    assert.ok(text.endsWith("... (truncated)"), "missing truncation suffix");
    core.unregisterChildSession("child-big");
});

test("link survives loader module isolation via globalThis", async () => {
    // Production topology: the host builds each extension with its own jiti
    // instance and moduleCache:false, so module-level Maps are never shared.
    // A second isolated import must still resolve links through globalThis.
    const jitiIso = await createTestJiti(undefined, { moduleCache: false });
    const sharedIso = await jitiIso.import(
        resolve(ROOT, "agent/extensions/shared/cross-extension-api.ts"),
    );
    assert.equal(
        sharedIso.getExtensionApi("subagents"),
        undefined,
        "expected isolated module instances for this test",
    );
    assert.equal(
        sharedIso.getParentLinkGlobal("child-1")?.parentSessionId,
        "parent-0",
        "link must cross isolated instances via globalThis",
    );
    sharedIso.setParentLinkGlobal("child-iso", { parentSessionId: "parent-iso" });
    assert.equal(
        core.resolveParentLink("child-iso")?.parentSessionId,
        "parent-iso",
        "reverse direction must work too",
    );
    sharedIso.deleteParentLinkGlobal("child-iso");
});

test("link registry round-trips and cleans up", async () => {
    assert.equal(core.resolveParentLink("child-1")?.parentSessionId, "parent-0");
    core.registerChildSession("", { parentSessionId: "x" });
    assert.equal(core.resolveParentLink(""), undefined, "empty id must be a no-op");
    core.unregisterChildSession("child-1");
    assert.equal(core.resolveParentLink("child-1"), undefined, "link must clear on dispose");
    const text = await out({ query: "parent-secret-xyz", source: "parent" });
    assert.ok(text.includes("No parent session linked"), "stale link survived unregister");
});

test("unknown hex id falls through without throwing", async () => {
    const text = await out({ query: "abcdef123456", source: "parent" }, lonerCtx);
    assert.ok(typeof text === "string" && text.length > 0);
});

// ── Run ───────────────────────────────────────────────────────────────────
await runCases(
    cases,
    "    (skip parent OM-file inclusion: would write to the real agent dir)",
);
