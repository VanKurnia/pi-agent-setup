// Test: Observational Memory pending-state durability (atomic write, backup,
// recovery). Run from repo root: node .script/test/blackhole/pending-state.test.mjs
//
// The module under test writes into the REAL agent data directory
// (getAgentDir()/pi-blackhole). Every case therefore uses one synthetic session
// id, touches only files whose name starts with that id, and removes them in a
// finally block.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ROOT, createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const om = await importProd(jiti, "agent/extensions/blackhole/om.js");
const { cleanupOrphanedPendingFiles, getPendingFilePath, readPendingState, writePendingState } = om;
assert.equal(typeof readPendingState, "function");
assert.equal(typeof writePendingState, "function");
assert.equal(typeof cleanupOrphanedPendingFiles, "function");

const SESSION = `pending-test-${Math.random().toString(16).slice(2, 10)}`;
const mainPath = getPendingFilePath(SESSION);
const backupPath = mainPath.replace(/-pending\.json$/, "-pending.stale.json");
const tmpPath = `${mainPath}.tmp`;
const unrelatedPath = `${mainPath.replace(/-pending\.json$/, "")}-other.json`;

const stateA = {
    observations: [{ id: "aaaaaaaaaaaa", text: "first observation", createdAt: 1 }],
    reflections: [{ id: "bbbbbbbbbbbb", text: "first reflection", createdAt: 2 }],
    lastObservedEntryId: "e1",
};
const stateB = {
    observations: [{ id: "cccccccccccc", text: "second observation", createdAt: 3 }],
    reflections: [],
    lastObservedEntryId: "e2",
    lastReflectedEntryId: "e1",
};

const cleanupFiles = () => {
    for (const p of [mainPath, backupPath, tmpPath, unrelatedPath]) {
        rmSync(p, { force: true });
    }
};

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("missing file reads as an empty state", () => {
    cleanupFiles();
    const state = readPendingState(SESSION);
    assert.deepEqual(state, { observations: [], reflections: [] });
});

test("round-trip preserves observations, reflections and cursors", () => {
    writePendingState(SESSION, stateA);
    const state = readPendingState(SESSION);
    assert.equal(state.observations.length, 1);
    assert.equal(state.observations[0].text, "first observation");
    assert.equal(state.reflections[0].id, "bbbbbbbbbbbb");
    assert.equal(state.lastObservedEntryId, "e1");
});

test("write is atomic: no .tmp file is left behind", () => {
    writePendingState(SESSION, stateA);
    assert.equal(existsSync(tmpPath), false, "tmp file survived the write");
    assert.equal(existsSync(mainPath), true, "main file missing after write");
});

test("second write rotates the previous state into the backup", () => {
    writePendingState(SESSION, stateA);
    writePendingState(SESSION, stateB);
    const main = JSON.parse(readFileSync(mainPath, "utf8"));
    const backup = JSON.parse(readFileSync(backupPath, "utf8"));
    assert.equal(main.observations[0].id, "cccccccccccc");
    assert.equal(backup.observations[0].id, "aaaaaaaaaaaa");
});

test("corrupt main file recovers from the backup and keeps the evidence", () => {
    writePendingState(SESSION, stateA);
    writePendingState(SESSION, stateB);
    const corrupt = "{ not json";
    writeFileSync(mainPath, corrupt, "utf8");

    const state = readPendingState(SESSION);
    assert.equal(state.observations[0]?.id, "aaaaaaaaaaaa", "backup state was not recovered");
    assert.equal(readFileSync(mainPath, "utf8"), corrupt, "corrupt file must be preserved");
});

test("corrupt main file without a backup degrades to empty without throwing", () => {
    cleanupFiles();
    writeFileSync(mainPath, "garbage", "utf8");
    const state = readPendingState(SESSION);
    assert.deepEqual(state, { observations: [], reflections: [] });
});

test("cleanup removes the pending trio and leaves unrelated files alone", () => {
    writePendingState(SESSION, stateA);
    writePendingState(SESSION, stateB);
    writeFileSync(tmpPath, "{}", "utf8");
    writeFileSync(unrelatedPath, "{}", "utf8");

    const report = cleanupOrphanedPendingFiles();
    assert.equal(existsSync(mainPath), false, "pending file not cleaned");
    assert.equal(existsSync(backupPath), false, "backup file not cleaned");
    assert.equal(existsSync(tmpPath), false, "tmp file not cleaned");
    assert.equal(existsSync(unrelatedPath), true, "unrelated file must survive cleanup");
    assert.ok(report.removed >= 3, `expected >=3 removals, got ${report.removed}`);
});

try {
    await runCases(cases, `\nblackhole pending-state durability (ROOT=${ROOT})`);
} finally {
    cleanupFiles();
}
