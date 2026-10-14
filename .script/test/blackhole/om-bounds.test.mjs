// Test: Observational Memory pool bounds and cursor anchoring.
// Run from repo root: node .script/test/blackhole/om-bounds.test.mjs
//
// All helpers are pure (the state objects are in-memory), so no session and no
// filesystem are involved.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const om = await importProd(jiti, "agent/extensions/blackhole/om.js");
const {
    activeMemory,
    calculateTokensAfter,
    estimateTextTokens,
    reanchorMissingCursors,
    trimForDropper,
} = om;
for (const [name, fn] of Object.entries({
    activeMemory,
    calculateTokensAfter,
    estimateTextTokens,
    reanchorMissingCursors,
    trimForDropper,
})) {
    assert.equal(typeof fn, "function", `${name} missing`);
}

const observation = (i, chars = 400) => ({
    id: `o${i}`,
    text: `obs-${i} ${"x".repeat(chars)}`,
    createdAt: i,
});
const reflection = (i, chars = 400) => ({
    id: `r${i}`,
    text: `ref-${i} ${"x".repeat(chars)}`,
    createdAt: i,
});
const state = (observations, reflections) => ({
    observations,
    reflections,
    lastObservedEntryId: undefined,
    lastReflectedEntryId: undefined,
});

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("activeMemory keeps the newest items inside the pool budget", () => {
    const all = Array.from({ length: 100 }, (_, i) => observation(i));
    const unbounded = activeMemory(state(all, []), { observationsPoolMaxTokens: 1_000_000 });
    assert.equal(unbounded.observations.length, 100, "large pool must keep everything");

    const trimmed = activeMemory(state(all, []), { observationsPoolMaxTokens: 500 });
    assert.ok(trimmed.observations.length >= 1, "at least one item must survive");
    assert.equal(trimmed.observations.at(-1).id, "o99", "newest item missing");
    assert.equal(
        trimmed.observations[0].id,
        `o${100 - trimmed.observations.length}`,
        "oldest kept item wrong",
    );
    const tokens = trimmed.observations.reduce((s, o) => s + estimateTextTokens(o.text), 0);
    assert.ok(tokens <= 500 + 101, `budget exceeded: ${tokens}`);
});

test("activeMemory honours an explicit observation budget", () => {
    const all = Array.from({ length: 30 }, (_, i) => observation(i));
    const preamble = activeMemory(state(all, []), {}, { observationBudget: 300 });
    const tokens = preamble.observations.reduce((s, o) => s + estimateTextTokens(o.text), 0);
    assert.ok(tokens <= 300 + 101, `preamble budget exceeded: ${tokens}`);
    assert.ok(preamble.observations.length < 30, "budget had no effect");
});

test("a session without a pending file yields an empty summary", () => {
    const summary = om.buildOmCompactionSummary("om-bounds-no-such-session");
    assert.equal(summary, "");
});

test("a missing cursor counts zero tokens, not the whole branch", () => {
    const entries = [
        {
            id: "a",
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "x".repeat(2000) }] },
        },
        {
            id: "b",
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "y".repeat(2000) }] },
        },
    ];
    assert.equal(calculateTokensAfter(entries, "gone-entry"), 0, "vanished cursor must not replay");
    assert.ok(calculateTokensAfter(entries, undefined) > 0, "no cursor keeps counting the branch");
    assert.ok(calculateTokensAfter(entries, "a") > 0, "live cursor counts what follows it");
});

test("reanchorMissingCursors re-anchors vanished cursors only", () => {
    const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];

    const vanished = state([], []);
    vanished.lastObservedEntryId = "gone";
    vanished.lastReflectedEntryId = "gone";
    assert.equal(reanchorMissingCursors(vanished, entries), true);
    assert.equal(vanished.lastObservedEntryId, "c");
    assert.equal(vanished.lastReflectedEntryId, "c");

    const live = state([], []);
    live.lastObservedEntryId = "b";
    assert.equal(reanchorMissingCursors(live, entries), false);
    assert.equal(live.lastObservedEntryId, "b");

    const empty = state([], []);
    assert.equal(reanchorMissingCursors(empty, entries), false);
});

test("trimForDropper bounds both pools and keeps the newest entries", () => {
    const target = state(
        Array.from({ length: 50 }, (_, i) => observation(i)),
        Array.from({ length: 20 }, (_, i) => reflection(i)),
    );
    const result = trimForDropper(target, {
        observationsPoolTargetTokens: 1000,
        reflectionsPoolMaxTokens: 400,
    });
    assert.ok(result.droppedObservations > 0, "observations not trimmed");
    assert.ok(result.droppedReflections > 0, "reflections not trimmed");
    const obsTokens = target.observations.reduce((s, o) => s + estimateTextTokens(o.text), 0);
    const refTokens = target.reflections.reduce((s, r) => s + estimateTextTokens(r.text), 0);
    assert.ok(obsTokens <= 1000 + 101, `observation tokens: ${obsTokens}`);
    assert.ok(refTokens <= 400 + 101, `reflection tokens: ${refTokens}`);
    assert.equal(target.observations.at(-1).id, "o49", "newest observation lost");
    assert.equal(target.reflections.at(-1).id, "r19", "newest reflection lost");
});

await runCases(cases, "\nblackhole OM bounds and anchors");
