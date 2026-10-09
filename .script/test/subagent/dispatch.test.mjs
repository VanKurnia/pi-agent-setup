// Temp test: subagent dispatcher wiring end-to-end without models.
// Run from repo root: node .script/test/subagent/dispatch.test.mjs
// Aliases @earendil-works/pi-coding-agent to a stub whose createAgentSession
// returns fakes, then drives the REAL buildSubagentExecute dispatcher with a
// stub parent ctx. Covers the gap unit tests cannot: snapshot attach,
// child->parent link visibility DURING the run, cleanup after dispose, and
// retry behavior. No model calls, no session writes.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
    ROOT,
    createTestJiti,
    importProd,
    runCases,
    toolMsg,
} from "./helpers.mjs";

const stubPath = resolve(ROOT, ".script/test/subagent/stubs/pi-sdk.stub.mjs");
// Default module cache stays ON so the stub shares module instances
// with the extensions (same trick as recall.test.mjs).
const jiti = await createTestJiti(stubPath);

const core = await importProd(jiti, "agent/extensions/subagents/src/core.js");
const run = await importProd(jiti, "agent/extensions/subagents/src/run.js");
const shared = await importProd(jiti, "agent/extensions/shared/cross-extension-api.js");
const stub = await jiti.import(stubPath);
assert.equal(typeof run.buildSubagentExecute, "function", "dispatcher missing");

// Hermetic agent: dynamic registrations override file-based discovery, so the
// test never depends on which agent .md files exist on disk. Empty model
// skips resolveAgentModel; tools:["recall"] asserts allowlist pass-through.
core.registerAgent({
    name: "test-scout",
    description: "dispatcher-test stub",
    tools: ["recall"],
    model: "",
});

const settings = {
    maxConcurrent: 2,
    getAllAgentModels: () => ({}),
    getAllAgentThinking: () => ({}),
};
const execute = run.buildSubagentExecute(settings);

// ── Stubs ─────────────────────────────────────────────────────────────────
const parentCtx = (messages, sessionId = "parent-0", cwd = ROOT) => ({
    cwd,
    hasUI: false,
    sessionManager: {
        getSessionId: () => sessionId,
        buildSessionProjection: () => ({ messages }),
    },
});
const PARENT_MSGS = [
    {
        role: "user",
        content: [{ type: "text", text: "parent goal, decided at parent-depth-7" }],
    },
    toolMsg("agent/extensions/subagents/src/core.ts"),
    // Literal chain token inside snapshot source text: must reach the child
    // neutralized so a later fillPrevious() cannot rewrite the frozen block.
    toolMsg("agent/extensions/{previous}/notes.md"),
];
const snapshotBlockOf = (task) =>
    task.split("<DELEGATION_SNAPSHOT>")[1]?.split("</DELEGATION_SNAPSHOT>")[0] ?? "";

// ── Cases ─────────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("single dispatch attaches snapshot and links child during run", async () => {
    stub.__resetStubbedSessions();
    const res = await execute(
        "call_1",
        { agent: "test-scout", task: "do the thing" },
        undefined,
        () => {},
        parentCtx(PARENT_MSGS),
    );
    assert.ok(!res.isError, `dispatch failed: ${JSON.stringify(res.content).slice(0, 200)}`);
    assert.equal(stub.stubbedSessions.length, 1, "expected one child session");
    const [rec] = stub.stubbedSessions;
    assert.deepEqual(rec.opts.tools, ["recall"], "agent tools not passed to session");
    const [task] = rec.prompts;
    assert.ok(task.includes("<DELEGATION_SNAPSHOT>"), "snapshot block missing from child task");
    assert.ok(
        task.includes("agent/extensions/subagents/src/core.ts"),
        "touched file missing from snapshot",
    );
    const block = snapshotBlockOf(task);
    assert.ok(block.includes("{ previous }"), "{previous} token not neutralized");
    assert.ok(!block.includes("{previous}"), "raw {previous} leaks into snapshot");
    assert.equal(rec.linkSeen.length, 1, "prompt ran more than once");
    assert.equal(
        rec.linkSeen[0]?.parentSessionId,
        "parent-0",
        "parent link not visible during child run",
    );
    assert.equal(rec.linkSeen[0]?.parentCwd, ROOT, "parent cwd not carried on link");
    assert.equal(rec.disposed, true, "child session not disposed");
    assert.equal(
        shared.getParentLinkGlobal(rec.id),
        undefined,
        "link survived dispose (leak across runs)",
    );
});

test("empty parent passes task through untouched", async () => {
    stub.__resetStubbedSessions();
    const emptyCtx = parentCtx([], "", resolve(ROOT, ".script/test/subagent/no-such-dir"));
    const res = await execute(
        "call_2",
        { agent: "test-scout", task: "do the thing" },
        undefined,
        () => {},
        emptyCtx,
    );
    assert.ok(!res.isError, "dispatch failed");
    const [rec] = stub.stubbedSessions;
    assert.equal(rec.prompts[0], "do the thing", "task mutated despite empty snapshot");
    assert.equal(rec.linkSeen[0], undefined, "link registered without a parent session id");
});

test("parallel batch snapshots and links every child", async () => {
    stub.__resetStubbedSessions();
    const ctx = parentCtx(PARENT_MSGS);
    const res = await execute(
        "call_3",
        {
            tasks: [
                { agent: "test-scout", task: "first job" },
                { agent: "test-scout", task: "second job" },
            ],
        },
        undefined,
        () => {},
        ctx,
    );
    assert.ok(!res.isError, "dispatch failed");
    assert.equal(stub.stubbedSessions.length, 2, "expected two child sessions");
    const ids = new Set();
    for (const rec of stub.stubbedSessions) {
        assert.ok(
            rec.prompts[0].includes("<DELEGATION_SNAPSHOT>"),
            `child ${rec.id} missed the snapshot`,
        );
        assert.equal(rec.linkSeen[0]?.parentSessionId, "parent-0", `child ${rec.id} unlinked`);
        assert.equal(rec.disposed, true, `child ${rec.id} not disposed`);
        assert.equal(shared.getParentLinkGlobal(rec.id), undefined, `child ${rec.id} link leaked`);
        ids.add(rec.id);
    }
    assert.equal(ids.size, 2, "child session ids not distinct");
});

test("prompt failure retries then cleans up every attempt", async () => {
    stub.__resetStubbedSessions();
    stub.stubFlags.failPrompt = "boom";
    try {
        const res = await execute(
            "call_4",
            { agent: "test-scout", task: "doomed job" },
            undefined,
            () => {},
            parentCtx(PARENT_MSGS),
        );
        assert.equal(res.isError, true, "failed run must report isError");
    } finally {
        stub.stubFlags.failPrompt = null;
    }
    // 3 attempts on the selected (undefined) model, no fallback without ctx.model.
    assert.equal(stub.stubbedSessions.length, 3, "expected 3 attempts");
    for (const rec of stub.stubbedSessions) {
        assert.equal(rec.disposed, true, `attempt ${rec.id} not disposed`);
        assert.equal(
            shared.getParentLinkGlobal(rec.id),
            undefined,
            `attempt ${rec.id} link leaked`,
        );
    }
});

test("session creation failure returns graceful error without throwing", async () => {
    stub.__resetStubbedSessions();
    stub.stubFlags.failCreate = "no session for you";
    let res;
    try {
        res = await execute(
            "call_6",
            { agent: "test-scout", task: "doomed job" },
            undefined,
            () => {},
            parentCtx(PARENT_MSGS),
        );
    } finally {
        stub.stubFlags.failCreate = null;
    }
    assert.equal(res.isError, true, "creation failure must report isError, not throw");
    assert.ok(
        JSON.stringify(res.content).includes("Failed to create session"),
        `wrong error shape: ${JSON.stringify(res.content).slice(0, 160)}`,
    );
    // Graceful failure still retries the selected-model budget.
    assert.equal(stub.stubStats.createCalls, 3, "expected 3 creation attempts");
    assert.equal(stub.stubbedSessions.length, 0, "no child session may exist");
});

test("unknown agent fails closed with listing", async () => {
    await assert.rejects(
        execute(
            "call_5",
            { agent: "nope", task: "whatever" },
            undefined,
            () => {},
            parentCtx(PARENT_MSGS),
        ),
        /Unknown agent: nope/,
    );
});

// ── Run ───────────────────────────────────────────────────────────────────
await runCases(cases);
