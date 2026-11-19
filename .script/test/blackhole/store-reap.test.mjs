// Test: the orphan-store sweep decides once per session id and applies that
// decision to every file of that id.
// Run from repo root: node .script/test/blackhole/store-reap.test.mjs
//
// Hermetic: PI_CODING_AGENT_DIR points at a temp agent dir, so no case touches the
// operator's live OM data. The store dir is asserted to resolve inside it first.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT, createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "blackhole-reap-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = await createTestJiti();
const { getAgentDir } = await jiti.import("@earendil-works/pi-coding-agent");
assert.equal(getAgentDir(), agentDir, "PI_CODING_AGENT_DIR ignored; refusing to write elsewhere");

const om = await importProd(jiti, "agent/extensions/blackhole/om.js");
const { cleanupOrphanedPendingFiles, getPendingFilePath, writePendingState } = om;
assert.equal(typeof cleanupOrphanedPendingFiles, "function");

const dataDir = dirname(getPendingFilePath("probe"));
const sessionsDir = join(agentDir, "sessions");
assert.ok(
    dataDir.startsWith(agentDir),
    `store dir ${dataDir} is not inside the temp agent dir ${agentDir}`,
);

const DAY_MS = 24 * 60 * 60 * 1000;
const stateA = {
    observations: [{ id: "aaaaaaaaaaaa", text: "first observation", createdAt: 1 }],
    reflections: [{ id: "bbbbbbbbbbbb", text: "first reflection", createdAt: 2 }],
    lastObservedEntryId: "e1",
};
const stateB = {
    observations: [{ id: "cccccccccccc", text: "second observation", createdAt: 3 }],
    reflections: [],
    lastObservedEntryId: "e2",
};

const mainOf = (id) => getPendingFilePath(id);
const staleOf = (id) => mainOf(id).replace(/-pending\.json$/, "-pending.stale.json");
const tmpOf = (id) => `${mainOf(id)}.tmp`;

const reset = () => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
};

const ageFile = (path, ms) => {
    const t = new Date(Date.now() - ms);
    utimesSync(path, t, t);
};

/** A transcript the sweep can read, named `<timestamp>_<id>.jsonl` like the real ones. */
const writeTranscript = (id, subdir = "proj") => {
    const dir = join(sessionsDir, subdir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, `2026-10-09T01-09-00-289Z_${id}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id })}\n`,
        "utf8",
    );
};

/** A transcript whose header has not been written yet: only the filename carries the id. */
const writeHeaderlessTranscript = (id, subdir = "proj") => {
    const dir = join(sessionsDir, subdir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-10-09T01-09-00-289Z_${id}.jsonl`), "", "utf8");
};

await runCases(
    [
        [
            "orphan store, fresh: every shape is deleted at once",
            () => {
                reset();
                const id = "reap-orphan-shapes";
                writePendingState(id, stateA);
                writePendingState(id, stateB);
                writeFileSync(tmpOf(id), "{}", "utf8");
                writeFileSync(join(dataDir, `${id}-other.json`), "{}", "utf8");

                const report = cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), false, "main survived");
                assert.equal(existsSync(staleOf(id)), false, "stale survived");
                assert.equal(existsSync(tmpOf(id)), false, "tmp survived");
                assert.equal(existsSync(join(dataDir, `${id}-other.json`)), false, "other shape survived");
                assert.ok(report.removed >= 4, `expected >=4 removals, got ${report.removed}`);
            },
        ],
        [
            "orphan store, 30 days old: deleted",
            () => {
                reset();
                const id = "reap-orphan-old";
                writePendingState(id, stateA);
                ageFile(mainOf(id), 30 * DAY_MS);
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), false, "old orphan survived");
            },
        ],
        [
            "transcript only under sessions/.trash: store deleted",
            () => {
                reset();
                const id = "reap-trashed";
                writeTranscript(id, join(".trash", "proj"));
                writePendingState(id, stateA);
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), false, "trashed session store survived");
            },
        ],
        [
            "headerless transcript, fresh store: preserved",
            () => {
                reset();
                const id = "reap-headerless";
                writeHeaderlessTranscript(id);
                writePendingState(id, stateA);
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), true, "a session that is starting lost its store");
            },
        ],
        [
            "active session, fresh store: preserved",
            () => {
                reset();
                const id = "reap-active-fresh";
                writeTranscript(id);
                writePendingState(id, stateA);
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), true, "live store was reaped");
            },
        ],
        [
            "active session, 30-day-old store: deleted by the retention bound",
            () => {
                reset();
                const id = "reap-active-old";
                writeTranscript(id);
                writePendingState(id, stateA);
                ageFile(mainOf(id), 30 * DAY_MS);
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), false, "idle store outlived the retention window");
            },
        ],
        [
            "orphan .json.tmp, fresh: deleted",
            () => {
                reset();
                const id = "reap-orphan-tmp";
                mkdirSync(dataDir, { recursive: true });
                writeFileSync(tmpOf(id), "{}", "utf8");
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(tmpOf(id)), false, "in-flight tmp of a dead session survived");
            },
        ],
        [
            "active .json.tmp, fresh: preserved",
            () => {
                reset();
                const id = "reap-active-tmp";
                writeTranscript(id);
                mkdirSync(dataDir, { recursive: true });
                writeFileSync(tmpOf(id), "{}", "utf8");
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(tmpOf(id)), true, "live session's tmp was reaped");
            },
        ],
        [
            "stale copy with a parseable main: stale deleted, main preserved",
            () => {
                reset();
                const id = "reap-stale-clean";
                writeTranscript(id);
                writePendingState(id, stateA);
                writePendingState(id, stateB);
                assert.equal(existsSync(staleOf(id)), true, "no backup was rotated");
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(staleOf(id)), false, "redundant stale survived");
                assert.equal(existsSync(mainOf(id)), true, "main store of a live session was reaped");
            },
        ],
        [
            "stale copy with a corrupt main, both 30 days old: both preserved",
            () => {
                reset();
                const id = "reap-stale-corrupt";
                writeTranscript(id);
                writePendingState(id, stateA);
                writePendingState(id, stateB);
                writeFileSync(mainOf(id), "{ not json", "utf8");
                ageFile(mainOf(id), 30 * DAY_MS);
                ageFile(staleOf(id), 30 * DAY_MS);

                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), true, "corrupt main was reaped; it is the evidence");
                assert.equal(existsSync(staleOf(id)), true, "the last recovery copy was reaped");
            },
        ],
        [
            "stale copy with a missing main, live session: preserved",
            () => {
                reset();
                const id = "reap-stale-orphan";
                writeTranscript(id);
                writePendingState(id, stateA);
                writePendingState(id, stateB);
                rmSync(mainOf(id), { force: true });
                ageFile(staleOf(id), 30 * DAY_MS);

                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(staleOf(id)), true, "the last recovery copy was reaped");
            },
        ],
        [
            "headerless transcript whose id contains an underscore: preserved",
            () => {
                reset();
                const id = "herdr-code_review-5f82bf4a";
                writeHeaderlessTranscript(id);
                writePendingState(id, stateA);
                cleanupOrphanedPendingFiles();
                assert.equal(
                    existsSync(mainOf(id)),
                    true,
                    "a live session whose id contains an underscore lost its store",
                );
            },
        ],
        [
            "transcript named without an id: the header keeps its store",
            () => {
                reset();
                const id = "reap-named-no-id";
                const dir = join(sessionsDir, "proj");
                mkdirSync(dir, { recursive: true });
                writeFileSync(
                    join(dir, "copied-transcript.jsonl"),
                    `${JSON.stringify({ type: "session", version: 3, id })}\n`,
                    "utf8",
                );
                writePendingState(id, stateA);
                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), true, "the header id was ignored");
            },
        ],
        [
            "no store dir: reports zero and does not throw",
            () => {
                reset();
                assert.equal(existsSync(dataDir), false);
                assert.deepEqual(cleanupOrphanedPendingFiles(), { removed: 0, preserved: 0 });
            },
        ],
        [
            "orphan pair: main and stale are both gone after a single sweep",
            () => {
                reset();
                const id = "reap-orphan-pair";
                writePendingState(id, stateA);
                writePendingState(id, stateB);
                assert.equal(existsSync(staleOf(id)), true, "no backup was rotated");

                cleanupOrphanedPendingFiles();
                assert.equal(existsSync(mainOf(id)), false, "main survived the sweep");
                assert.equal(
                    existsSync(staleOf(id)),
                    false,
                    "stale outlived its orphan main; the decision is per session, not per file",
                );
            },
        ],
    ],
    `\nblackhole store reaping (ROOT=${ROOT})`,
);
