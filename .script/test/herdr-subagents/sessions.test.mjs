// Tests for the fork-link session helpers in agent/extensions/herdr-subagents/session.ts.
// Run from repo root: node .script/test/herdr-subagents/sessions.test.mjs
// Pure helpers with injectable fs; lock tests use real files under os.tmpdir().
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const session = await importProd(jiti, "agent/extensions/herdr-subagents/session.js");
const sharedApi = await importProd(jiti, "agent/extensions/shared/blackhole-api.js");

// Real snapshot provider, registered the way production does: drive the
// blackhole factory with a stub pi (registration is its first act).
const blackholeMod = await importProd(jiti, "agent/extensions/blackhole/index.js");
const blackholeFactory = blackholeMod.default ?? blackholeMod;
assert.equal(typeof blackholeFactory, "function", "blackhole factory missing");
blackholeFactory({
    on: () => {},
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
});
assert.ok(sharedApi.getBlackholeSnapshotApi(), "provider not registered");

const stubCtx = (messages) => ({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "herdr-snap-ctx-")),
    sessionManager: {
        getSessionId: () => "test-no-such-session",
        buildSessionProjection: () => ({ messages }),
    },
});
const parentMessages = [
    { role: "user", content: [{ type: "text", text: "fix auth" }] },
    {
        role: "assistant",
        content: [
            { type: "text", text: "reading" },
            { type: "toolCall", args: { path: "src/auth.ts" } },
        ],
    },
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-sessions-test-"));
const stubFs = (files) => ({
    readdirSync: () => Object.keys(files),
    statSync: (p) => {
        const name = p.split("/").pop();
        if (!(name in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { mtimeMs: files[name] };
    },
});

await runCases(
    [
        [
            "pane and session names are project-scoped",
            () => {
                const cwd = "C:\\proj-a";
                const key = session.projectKey(cwd);
                assert.equal(session.paneNameFor("scout", cwd), `subagent - scout - ${key}`);
                assert.equal(session.agentSessionId("scout", cwd), `herdr-scout-${key}`);
                assert.ok(session.isSafeAgentName("scout"));
                assert.ok(!session.isSafeAgentName("has space"));
                assert.ok(!session.isSafeAgentName(""));
                assert.ok(!session.isSafeAgentName("../evil"));
            },
        ],
        [
            "findAgentSessionFile: none and unsafe",
            () => {
                assert.equal(
                    session.findAgentSessionFile("/nope", "scout", "C:\\proj-a", stubFs({})),
                    undefined,
                );
                assert.equal(
                    session.findAgentSessionFile("/dir", "has space", "C:\\proj-a", stubFs({})),
                    undefined,
                );
            },
        ],
        [
            "findAgentSessionFile: one match and latest wins",
            () => {
                const cwd = "C:\\proj-a";
                const scoutId = session.agentSessionId("scout", cwd);
                const workerId = session.agentSessionId("worker", cwd);
                const one = stubFs({ [`2026-01-01T00-00-00-000Z_${scoutId}.jsonl`]: 10 });
                assert.equal(
                    session.findAgentSessionFile("/dir", "scout", cwd, one),
                    `/dir/2026-01-01T00-00-00-000Z_${scoutId}.jsonl`,
                );
                const two = stubFs({
                    [`2026-01-01T00-00-00-000Z_${scoutId}.jsonl`]: 10,
                    [`2026-02-01T00-00-00-000Z_${scoutId}.jsonl`]: 20,
                    [`2026-03-01T00-00-00-000Z_${workerId}.jsonl`]: 30,
                });
                assert.equal(
                    session.findAgentSessionFile("/dir", "scout", cwd, two),
                    `/dir/2026-02-01T00-00-00-000Z_${scoutId}.jsonl`,
                );
            },
        ],
        [
            "agentSessionId differs per project",
            () => {
                const a = session.agentSessionId("scout", "C:\\proj-a");
                const b = session.agentSessionId("scout", "C:\\proj-b");
                assert.notEqual(a, b);
                for (const id of [a, b]) {
                    assert.match(id, /^herdr-[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
                }
            },
        ],
        [
            "agentSessionId is stable for the same cwd",
            () => {
                assert.equal(
                    session.agentSessionId("scout", "C:\\proj-a"),
                    session.agentSessionId("scout", "C:\\proj-a"),
                );
            },
        ],
        [
            "findAgentSessionFile never crosses projects",
            () => {
                const cwdA = "C:\\proj-a";
                const cwdB = "C:\\proj-b";
                const idA = session.agentSessionId("scout", cwdA);
                const idB = session.agentSessionId("scout", cwdB);
                const onlyA = stubFs({ [`2026-01-01T00-00-00-000Z_${idA}.jsonl`]: 10 });
                assert.equal(
                    session.findAgentSessionFile("/dir", "scout", cwdB, onlyA),
                    undefined,
                );
                const both = stubFs({
                    [`2026-01-01T00-00-00-000Z_${idA}.jsonl`]: 10,
                    [`2026-02-01T00-00-00-000Z_${idB}.jsonl`]: 20,
                });
                assert.equal(
                    session.findAgentSessionFile("/dir", "scout", cwdB, both),
                    `/dir/2026-02-01T00-00-00-000Z_${idB}.jsonl`,
                );
                assert.equal(
                    session.findAgentSessionFile("/dir", "scout", cwdA, both),
                    `/dir/2026-01-01T00-00-00-000Z_${idA}.jsonl`,
                );
            },
        ],
        [
            "paneNameFor differs per project",
            () => {
                const a = session.paneNameFor("scout", "C:\\proj-a");
                const b = session.paneNameFor("scout", "C:\\proj-b");
                assert.notEqual(a, b);
                assert.ok(a.startsWith("subagent - scout"));
                assert.ok(b.startsWith("subagent - scout"));
            },
        ],
        [
            "projectKey is stable 8-hex per cwd",
            () => {
                for (const k of [session.projectKey("C:\\a"), session.projectKey("C:\\b")]) {
                    assert.match(k, /^[0-9a-f]{8}$/);
                }
                assert.equal(session.projectKey("C:\\a"), session.projectKey("C:\\a"));
                assert.notEqual(session.projectKey("C:\\a"), session.projectKey("C:\\b"));
            },
        ],
        [
            "unsafe agent names stay rejected after scoping",
            () => {
                assert.ok(!session.isSafeAgentName("../evil"));
                const files = stubFs({ "2026-01-01T00-00-00-000Z_herdr-scout-12345678.jsonl": 10 });
                assert.equal(
                    session.findAgentSessionFile("/dir", "../evil", "C:\\a", files),
                    undefined,
                );
            },
        ],
        [
            "legacyAgentSessionFiles: only unkeyed files match",
            () => {
                const key = session.projectKey("C:\\proj-a");
                const files = stubFs({
                    "2026-01-01T00-00-00-000Z_herdr-scout.jsonl": 1,
                    [`2026-01-02T00-00-00-000Z_herdr-scout-${key}.jsonl`]: 1,
                    "2026-01-03T00-00-00-000Z_herdr-worker.jsonl": 1,
                    "2026-01-04T00-00-00-000Z_unrelated.jsonl": 1,
                });
                assert.deepEqual(session.legacyAgentSessionFiles("/dir", "scout", files), [
                    "2026-01-01T00-00-00-000Z_herdr-scout.jsonl",
                ]);
                assert.deepEqual(session.legacyAgentSessionFiles("/dir", "../evil", files), []);
            },
        ],
        [
            "buildChildHeader: parent link present or omitted",
            () => {
                const linked = JSON.parse(
                    session.buildChildHeader("herdr-scout", "C:\\p", "C:\\p\\s.jsonl", "2026-10-17T00:00:00.000Z"),
                );
                assert.equal(linked.type, "session");
                assert.equal(linked.version, 3);
                assert.equal(linked.id, "herdr-scout");
                assert.equal(linked.parentSession, "C:\\p\\s.jsonl");
                const bare = JSON.parse(
                    session.buildChildHeader("herdr-scout", "C:\\p", undefined, "2026-10-17T00:00:00.000Z"),
                );
                assert.ok(!("parentSession" in bare));
                assert.equal(
                    session.childSessionFilename("herdr-scout", "2026-10-17T00:00:00.000Z"),
                    "2026-10-17T00-00-00-000Z_herdr-scout.jsonl",
                );
                assert.ok(session.lockFileFor("/tmp", "scout", "C:\\a b").endsWith(".lock"));
            },
        ],
        [
            "lock: acquire, contend, release, stale takeover",
            () => {
                const lock = path.join(root, "scout.lock");
                assert.equal(session.acquireLock(lock), true);
                assert.equal(session.acquireLock(lock), false);
                session.releaseLock(lock);
                assert.equal(session.acquireLock(lock), true);
                session.releaseLock(lock);
                session.releaseLock(lock);
                fs.writeFileSync(lock, "{}");
                const stale = Date.now() - 11 * 60 * 1000;
                fs.utimesSync(lock, new Date(stale), new Date(stale));
                assert.equal(session.acquireLock(lock), true);
                session.releaseLock(lock);
            },
        ],
        [
            "extractIfTurnComplete: only a landed turn counts",
            () => {
                const msg = (id, parent, role, text) =>
                    JSON.stringify({
                        type: "message",
                        id,
                        parentId: parent,
                        timestamp: "2026-10-17T00:00:00.000Z",
                        message: {
                            role,
                            content: [{ type: "text", text }],
                            timestamp: 0,
                        },
                    });
                assert.equal(session.extractIfTurnComplete(""), undefined);
                assert.equal(session.extractIfTurnComplete("not json\n"), undefined);
                const partial = [msg("u1", null, "user", "hi")].join("\n");
                assert.equal(session.extractIfTurnComplete(partial), undefined);
                const complete = [
                    msg("u1", null, "user", "hi"),
                    msg("a1", "u1", "assistant", "PONG"),
                ].join("\n");
                assert.equal(session.extractIfTurnComplete(complete), "PONG");
                const stale = [
                    msg("u1", null, "user", "hi"),
                    msg("a1", "u1", "assistant", "OLD"),
                    msg("u2", "a1", "user", "again"),
                ].join("\n");
                assert.equal(session.extractIfTurnComplete(stale), undefined);
            },
        ],
        [
            "snapshot: real provider builds a bounded snapshot",
            async () => {
                const snap = await session.createDelegationSnapshot(stubCtx(parentMessages));
                assert.ok(snap.length > 0);
                assert.ok(snap.length <= session.SNAPSHOT_MAX_CHARS);
                assert.ok(snap.includes("### Files Touched"));
                assert.ok(snap.includes("src/auth.ts"));
                const attached = session.attachDelegationSnapshot("do it", snap);
                assert.ok(attached.includes(session.SNAPSHOT_MARKER));
                assert.ok(attached.includes("<DELEGATION_SNAPSHOT>"));
                assert.ok(attached.startsWith("do it\n\n---\n"));
            },
        ],
        [
            "snapshot: attach is idempotent",
            async () => {
                const snap = await session.createDelegationSnapshot(stubCtx(parentMessages));
                const once = session.attachDelegationSnapshot("do it", snap);
                assert.equal(session.attachDelegationSnapshot(once, snap), once);
                assert.equal(session.attachDelegationSnapshot("has Reference context", snap), "has Reference context");
                assert.equal(session.attachDelegationSnapshot("", snap), "");
                assert.equal(session.attachDelegationSnapshot("do it", ""), "do it");
            },
        ],
        [
            "snapshot: absent provider degrades to bare task",
            async () => {
                const prev = sharedApi.getBlackholeSnapshotApi();
                sharedApi.setBlackholeSnapshotApi(undefined);
                try {
                    assert.equal(await session.createDelegationSnapshot(stubCtx(parentMessages)), "");
                } finally {
                    sharedApi.setBlackholeSnapshotApi(prev);
                }
                assert.ok(sharedApi.getBlackholeSnapshotApi(), "provider not restored");
            },
        ],
        [
            "snapshot: chain token neutralized at creation",
            async () => {
                const prev = sharedApi.getBlackholeSnapshotApi();
                sharedApi.setBlackholeSnapshotApi({
                    compileVccSummary: () => "uses {previous} here",
                    buildOmCompactionSummary: () => "",
                });
                try {
                    const snap = await session.createDelegationSnapshot(stubCtx(parentMessages));
                    assert.equal(snap, "uses { previous } here");
                } finally {
                    sharedApi.setBlackholeSnapshotApi(prev);
                }
                sharedApi.setBlackholeSnapshotApi({
                    compileVccSummary: () => "   ",
                    buildOmCompactionSummary: () => "",
                });
                try {
                    assert.equal(await session.createDelegationSnapshot(stubCtx(parentMessages)), "");
                } finally {
                    sharedApi.setBlackholeSnapshotApi(prev);
                }
            },
        ],
        [
            "matchPane: label wins over title, title is fallback",
            () => {
                assert.equal(session.matchPane([], "subagent - scout"), undefined);
                const titleOnly = [{ paneId: "a", title: "subagent - scout" }];
                assert.equal(session.matchPane(titleOnly, "subagent - scout")?.paneId, "a");
                const both = [
                    { paneId: "a", title: "subagent - scout" },
                    { paneId: "b", label: "subagent - scout" },
                ];
                assert.equal(session.matchPane(both, "subagent - scout")?.paneId, "b");
                assert.equal(
                    session.matchPane(both, "subagent - missing"),
                    undefined,
                );
            },
        ],
    ],
    { suite: "herdr-subagents sessions" },
);

fs.rmSync(root, { recursive: true, force: true });
