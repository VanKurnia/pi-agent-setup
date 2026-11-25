// Selection rules for session cleanup: user sessions age out on their own
// mtime, subagent transcripts live and die with the session that spawned them.
// Run from repo root: node .script/test/session-mgr/cleanup.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const cleanup = await importProd(jiti, "agent/extensions/session-mgr/cleanup.js");

const DAY = 86400000;
const CWD = "C:/work/proj";
const THRESHOLD = 30;

function workspace() {
    const agentDir = mkdtempSync(join(tmpdir(), "session-mgr-cleanup-"));
    const dir = join(agentDir, "sessions", "--C-work-proj--");
    mkdirSync(dir, { recursive: true });
    return { agentDir, dir, dispose: () => rmSync(agentDir, { recursive: true, force: true }) };
}

function writeSession(dir, { id, ageDays = 0, parentSession, name }) {
    const stamp = new Date(Date.now() - ageDays * DAY).toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `${stamp}_${id}.jsonl`);
    const header = {
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: CWD,
    };
    if (parentSession !== undefined) header.parentSession = parentSession;
    const lines = [JSON.stringify(header)];
    if (name !== undefined) lines.push(JSON.stringify({ type: "session_info", id: "s1", name }));
    lines.push(JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }));
    writeFileSync(file, `${lines.join("\n")}\n`);
    const touched = new Date(Date.now() - ageDays * DAY);
    utimesSync(file, touched, touched);
    return file;
}

await runCases(
    [
        [
            "roots: an expired user session is a candidate, a fresh one is not",
            () => {
                const ws = workspace();
                try {
                    writeSession(ws.dir, { id: "old-root", ageDays: 40 });
                    writeSession(ws.dir, { id: "new-root", ageDays: 1 });
                    const cands = cleanup.collectCleanupCandidates(ws.agentDir, THRESHOLD);
                    assert.equal(cands.length, 1);
                    assert.equal(basename(cands[0].file).endsWith("_old-root.jsonl"), true);
                } finally {
                    ws.dispose();
                }
            },
        ],
        [
            "subagent transcript: never expires on its own age",
            () => {
                const ws = workspace();
                try {
                    const root = writeSession(ws.dir, { id: "root", ageDays: 1 });
                    writeSession(ws.dir, {
                        id: "herdr-scout-00000001",
                        ageDays: 90,
                        parentSession: root,
                    });
                    assert.deepEqual(cleanup.collectCleanupCandidates(ws.agentDir, THRESHOLD), []);
                } finally {
                    ws.dispose();
                }
            },
        ],
        [
            "subagent transcript: an orphan is a candidate at any age",
            () => {
                const ws = workspace();
                try {
                    writeSession(ws.dir, {
                        id: "herdr-scout-00000002",
                        ageDays: 0,
                        parentSession: join(ws.dir, "gone.jsonl"),
                    });
                    const cands = cleanup.collectCleanupCandidates(ws.agentDir, THRESHOLD);
                    assert.equal(cands.length, 1);
                    assert.equal(cands[0].cwd, CWD);
                } finally {
                    ws.dispose();
                }
            },
        ],
        [
            "threshold 0 browses every root but still skips attached transcripts",
            () => {
                const ws = workspace();
                try {
                    const root = writeSession(ws.dir, { id: "root", ageDays: 0 });
                    writeSession(ws.dir, { id: "herdr-scout-00000003", ageDays: 0, parentSession: root });
                    const cands = cleanup.collectCleanupCandidates(ws.agentDir, 0);
                    assert.equal(cands.length, 1);
                    assert.equal(basename(cands[0].file).endsWith("_root.jsonl"), true);
                } finally {
                    ws.dispose();
                }
            },
        ],
        [
            "the open session is never a candidate",
            () => {
                const ws = workspace();
                try {
                    const current = writeSession(ws.dir, { id: "current", ageDays: 90 });
                    writeSession(ws.dir, { id: "other", ageDays: 90 });
                    const cands = cleanup.collectCleanupCandidates(ws.agentDir, THRESHOLD, current);
                    assert.equal(cands.length, 1);
                    assert.equal(basename(cands[0].file).endsWith("_other.jsonl"), true);
                } finally {
                    ws.dispose();
                }
            },
        ],
        [
            "a candidate carries the session's display name",
            () => {
                const ws = workspace();
                try {
                    writeSession(ws.dir, { id: "named", ageDays: 40, name: "Nightly refactor" });
                    const [cand] = cleanup.collectCleanupCandidates(ws.agentDir, THRESHOLD);
                    assert.equal(cand.name, "Nightly refactor");
                } finally {
                    ws.dispose();
                }
            },
        ],
        [
            "expand: descendants follow the chain, a clone is left alone",
            () => {
                const ws = workspace();
                try {
                    const root = writeSession(ws.dir, { id: "root" });
                    const child = writeSession(ws.dir, { id: "herdr-scout-00000004", parentSession: root });
                    const grandchild = writeSession(ws.dir, {
                        id: "herdr-worker-00000005",
                        parentSession: child,
                    });
                    writeSession(ws.dir, {
                        id: "11111111-2222-3333-4444-555555555555",
                        parentSession: root,
                    });
                    assert.deepEqual(cleanup.expandWithSubagentDescendants([root]).sort(), [
                        root,
                        child,
                        grandchild,
                    ].sort());
                } finally {
                    ws.dispose();
                }
            },
        ],
        [
            "expand: a transcript with no descendants is returned unchanged",
            () => {
                const ws = workspace();
                try {
                    const root = writeSession(ws.dir, { id: "solo" });
                    assert.deepEqual(cleanup.expandWithSubagentDescendants([root]), [root]);
                } finally {
                    ws.dispose();
                }
            },
        ],
    ],
    "session-mgr cleanup selection",
);
