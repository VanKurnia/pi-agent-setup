// Test: Observational Memory pending-state durability (atomic write, backup,
// recovery, cleanup). Run from repo root: node .script/test/blackhole/pending-state.test.mjs
//
// Hermetic: PI_CODING_AGENT_DIR points at a temp agent dir, so no case writes to
// the operator's live OM data. The cleanup cases need a session file to exist,
// since prune keeps the stores of session ids that are still on disk.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "blackhole-pending-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = await createTestJiti();
const { getAgentDir } = await jiti.import("@earendil-works/pi-coding-agent");
assert.equal(getAgentDir(), agentDir, "PI_CODING_AGENT_DIR ignored; refusing to write elsewhere");

const om = await importProd(jiti, "agent/extensions/blackhole/om.js");
const { getBlackholeConfigPath } = await importProd(jiti, "agent/extensions/blackhole/config.js");
const { cleanupOrphanedPendingFiles, getPendingFilePath, readPendingState, writePendingState } = om;
assert.equal(typeof readPendingState, "function");
assert.equal(typeof writePendingState, "function");
assert.equal(typeof cleanupOrphanedPendingFiles, "function");

const SESSION = `pending-test-${Math.random().toString(16).slice(2, 10)}`;
const mainPath = getPendingFilePath(SESSION);
const backupPath = mainPath.replace(/-pending\.json$/, "-pending.stale.json");
const tmpPath = `${mainPath}.tmp`;
const unrelatedPath = `${mainPath.replace(/-pending\.json$/, "")}-other.json`;

const LIVE_SESSION = `pending-live-${Math.random().toString(16).slice(2, 10)}`;
const livePath = getPendingFilePath(LIVE_SESSION);
const STARTING_SESSION = `pending-start-${Math.random().toString(16).slice(2, 10)}`;
const configPath = getBlackholeConfigPath();

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
    for (const p of [mainPath, backupPath, tmpPath, unrelatedPath, livePath]) {
        rmSync(p, { force: true });
    }
};

/** A session file declaring `id`, as the prune scan reads them (header line). */
const writeSessionFile = (id) => {
    const sessionsDir = join(agentDir, "sessions", "proj");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
        join(sessionsDir, `${id}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id })}\n`,
        "utf8",
    );
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

test("cleanup removes every store shape of a session with no session file", () => {
    cleanupFiles();
    writePendingState(SESSION, stateA);
    writePendingState(SESSION, stateB);
    writeFileSync(tmpPath, "{}", "utf8");
    writeFileSync(unrelatedPath, "{}", "utf8");

    const report = cleanupOrphanedPendingFiles();
    assert.equal(existsSync(mainPath), false, "pending file not cleaned");
    assert.equal(existsSync(backupPath), false, "backup file not cleaned");
    assert.equal(existsSync(tmpPath), false, "tmp file not cleaned");
    assert.equal(existsSync(unrelatedPath), false, "obsolete store shape not cleaned");
    assert.ok(report.removed >= 4, `expected >=4 removals, got ${report.removed}`);
});

test("cleanup keeps the config and the stores of a live session", () => {
    cleanupFiles();
    writeSessionFile(LIVE_SESSION);
    writePendingState(LIVE_SESSION, stateA);
    writeFileSync(configPath, "{}", "utf8");

    cleanupOrphanedPendingFiles();
    assert.equal(existsSync(livePath), true, "live session store must survive cleanup");
    assert.equal(existsSync(configPath), true, "config file must survive cleanup");
});

test("cleanup keeps the stores of a session that is still starting", () => {
    cleanupFiles();
    const startingPath = getPendingFilePath(STARTING_SESSION);
    writePendingState(STARTING_SESSION, stateA);

    cleanupOrphanedPendingFiles(STARTING_SESSION);
    assert.equal(existsSync(startingPath), true, "starting session store must survive");

    cleanupOrphanedPendingFiles();
    assert.equal(existsSync(startingPath), false, "orphan must be reaped once unkept");
});

await runCases(cases, `\nblackhole pending-state durability (ROOT=${ROOT})`);
