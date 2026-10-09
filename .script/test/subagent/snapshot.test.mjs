// Temp test: subagent delegation snapshot (parent VCC -> child task).
// Run from repo root: node .script/test/subagent/snapshot.test.mjs
// Loads the real TS modules the way pi does (jiti) and drives the exported
// helpers with a stub parent ctx. No model calls, no session writes.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
    ROOT,
    createTestJiti,
    importProd,
    runCases,
    toolMsg,
} from "./helpers.mjs";

const jiti = await createTestJiti();

const run = await importProd(jiti, "agent/extensions/subagents/src/run.js");
const {
    createDelegationSnapshot,
    attachDelegationSnapshot,
    applyDelegationSnapshot,
    SNAPSHOT_MAX_CHARS: MAX,
    SNAPSHOT_MARKER: MARKER,
} = run;
assert.equal(typeof createDelegationSnapshot, "function");
assert.equal(typeof attachDelegationSnapshot, "function");
assert.equal(typeof applyDelegationSnapshot, "function");

// ── Stubs ─────────────────────────────────────────────────────────────────
const makeCtx = (messages, sessionId = "test-no-such-session", cwd = ROOT) => ({
    cwd,
    sessionManager: {
        getSessionId: () => sessionId,
        buildSessionProjection: () => ({ messages }),
    },
});
let gitOk = true;
try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: ROOT, stdio: "ignore" });
} catch {
    gitOk = false;
}

// fillPrevious replica (same regex as run.ts) for the frozen-snapshot check.
const fillPrevious = (task, previous) => task.replace(/\{previous\}/g, () => previous);

// ── Cases ─────────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("snapshot lists touched files + recent commits", () => {
    const ctx = makeCtx([toolMsg("agent/extensions/subagents/src/run.ts"), toolMsg("README.md")]);
    const snap = createDelegationSnapshot(ctx);
    assert.ok(snap.includes("### Files Touched"), "missing Files Touched");
    assert.ok(snap.includes("agent/extensions/subagents/src/run.ts"), "missing touched path");
    if (gitOk) assert.ok(snap.includes("### Recent Commits"), "missing Recent Commits");
    else console.log("    (skip commits assertion: not a git checkout)");
});

test("empty session in non-git dir yields empty snapshot", () => {
    const bare = mkdtempSync(resolve(tmpdir(), "snap-empty-"));
    const snap = createDelegationSnapshot(makeCtx([], "nope", bare));
    assert.equal(snap, "");
});

test("missing OM session adds no Active Context section", () => {
    const snap = createDelegationSnapshot(makeCtx([toolMsg("a/b.ts")]));
    assert.ok(!snap.includes("### Active Context"), "unexpected OM section without pending file");
});

test("attach preserves head, adds marker block, is idempotent", () => {
    const snap = createDelegationSnapshot(makeCtx([toolMsg("a/b.ts")]));
    assert.ok(snap, "need non-empty snapshot for this case");
    const task = "Review the fuzzy-search normalization";
    const once = attachDelegationSnapshot(task, snap);
    assert.ok(once.startsWith(task), "original task must stay at head");
    assert.ok(once.includes(MARKER), "missing marker");
    assert.ok(once.includes("<DELEGATION_SNAPSHOT>"), "missing snapshot block");
    assert.equal(attachDelegationSnapshot(once, snap), once, "must be idempotent");
    assert.equal(attachDelegationSnapshot(task, ""), task, "empty snapshot must pass through");
    assert.equal(
        attachDelegationSnapshot(`${MARKER} already here`, snap),
        `${MARKER} already here`,
        "already-marked task must pass through",
    );
});

test("{previous} inside snapshot survives chain templating", () => {
    const snap = createDelegationSnapshot(makeCtx([toolMsg("src/{previous}/x.ts")]));
    assert.ok(!snap.includes("{previous}"), "raw token leaked into snapshot");
    assert.ok(snap.includes("{ previous }"), "expected neutralized token");
    const combined = attachDelegationSnapshot("Do X with {previous} data", snap);
    const filled = fillPrevious(combined, "PREV-OUTPUT");
    const refRegion = filled.slice(filled.indexOf(MARKER));
    assert.ok(!refRegion.includes("PREV-OUTPUT"), "frozen reference was rewritten");
    assert.ok(filled.startsWith("Do X with PREV-OUTPUT data"), "task templating still works");
});

test("oversized snapshot is truncated at cap", () => {
    const msgs = Array.from({ length: 400 }, (_, i) =>
        toolMsg(`some/very/long/component/path/number-${String(i).padStart(3, "0")}/module-file.ts`),
    );
    const snap = createDelegationSnapshot(makeCtx(msgs));
    assert.ok(snap.length > MAX, "fixture too small to trigger truncation");
    assert.ok(snap.length <= MAX + 64, `snapshot not capped: ${snap.length}`);
    assert.ok(snap.endsWith("... (snapshot truncated)"), "missing truncation suffix");
});

test("apply covers single/parallel/chain/hybrid with one shared snapshot", () => {
    const SNAP = "SHARED-SNAPSHOT";
    const fixtures = {
        single: { agent: "scout", task: "map auth" },
        parallel: { tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] },
        chain: { chain: [{ agent: "worker", task: "step1 {previous}" }] },
        hybrid: {
            hybrid: [
                { mode: "single", agent: "scout", task: "recon" },
                {
                    mode: "parallel",
                    tasks: [{ agent: "scout", task: "p1" }],
                },
                { mode: "chain", tasks: [{ agent: "worker", task: "c1 {previous}" }] },
            ],
        },
    };
    const collect = (p) => {
        if (p.task) return [p.task];
        if (p.tasks) return p.tasks.map((t) => t.task);
        if (p.chain) return p.chain.map((t) => t.task);
        return p.hybrid.flatMap((ph) => (ph.tasks ? ph.tasks.map((t) => t.task) : [ph.task]));
    };
    for (const [mode, params] of Object.entries(fixtures)) {
        const before = structuredClone(params);
        const out = applyDelegationSnapshot(params, SNAP);
        for (const t of collect(out)) assert.ok(t.includes(SNAP), `${mode}: task missing snapshot`);
        assert.deepEqual(params, before, `${mode}: input params were mutated`);
    }
});

test("apply ignores unknown hybrid phase and empty snapshot", () => {
    const weird = { mode: "weird", task: "untouched" };
    const out = applyDelegationSnapshot({ hybrid: [weird] }, "SNAP");
    assert.equal(out.hybrid[0], weird, "unknown phase must pass through by reference");
    const params = { agent: "scout", task: "t" };
    assert.equal(applyDelegationSnapshot(params, ""), params, "empty snapshot must pass through");
    console.log("    (skip OM-file inclusion: would write to the real agent dir)");
});

// ── Run ───────────────────────────────────────────────────────────────────
await runCases(cases);
