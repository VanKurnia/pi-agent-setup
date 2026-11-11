// Tests for the herdr sub-agent session helpers: keyed transcript delete,
// blackhole memory clear and terminal names.
// Run from repo root: node .script/test/herdr-app-subagent/fresh.test.mjs
//
// Hermetic: PI_CODING_AGENT_DIR points at a temp agent dir, so no case writes
// to the operator's live OM data. Real temp dirs everywhere; no herdr socket,
// no model calls. The reap loop itself needs a live herdr-core session and is
// not covered here.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "fresh-session-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = await createTestJiti();
const { getAgentDir } = await jiti.import("@earendil-works/pi-coding-agent");
assert.equal(getAgentDir(), agentDir, "PI_CODING_AGENT_DIR ignored; refusing to write elsewhere");

const session = await importProd(jiti, "agent/extensions/herdr-app-subagent/session.js");
const { agentNameFor, agentSessionId, clearChildMemory, deleteChildSessionFiles } = session;
assert.equal(typeof deleteChildSessionFiles, "function");
assert.equal(typeof clearChildMemory, "function");

const sharedApi = await importProd(jiti, "agent/extensions/shared/blackhole-api.js");
const { getBlackholeSnapshotApi, setBlackholeSnapshotApi } = sharedApi;

const om = await importProd(jiti, "agent/extensions/blackhole/om.js");
const { getPendingFilePath } = om;

const CWD = "C:\\work\\proj";
const backupFor = (mainPath) => mainPath.replace(/-pending\.json$/, "-pending.stale.json");

await runCases(
    [
        [
            "delete: removes every transcript of this agent, folder and parent only",
            () => {
                const dir = mkdtempSync(join(tmpdir(), "fresh-group-"));
                const id = agentSessionId("worker", CWD);
                const gone = [`t1_${id}.jsonl`, `t2_${id}.jsonl`];
                const kept = [
                    `t3_herdr-scout-deadbeef.jsonl`,
                    `t4_${id}.jsonl.bak`,
                    `${id}.jsonl`,
                ];
                for (const name of [...gone, ...kept]) writeFileSync(join(dir, name), "x");
                assert.equal(deleteChildSessionFiles(dir, "worker", CWD), 2);
                for (const name of gone) assert.equal(existsSync(join(dir, name)), false);
                for (const name of kept) assert.equal(existsSync(join(dir, name)), true);
                rmSync(dir, { recursive: true, force: true });
            },
        ],
        [
            "delete: the parent key differentiates files with the same agent and folder",
            () => {
                const dir = mkdtempSync(join(tmpdir(), "fresh-group-"));
                const plainId = agentSessionId("worker", CWD);
                const parentId = agentSessionId("worker", CWD, "9f");
                writeFileSync(join(dir, `t1_${plainId}.jsonl`), "x");
                writeFileSync(join(dir, `t2_${parentId}.jsonl`), "x");
                assert.equal(deleteChildSessionFiles(dir, "worker", CWD, "9f"), 1);
                assert.equal(existsSync(join(dir, `t2_${parentId}.jsonl`)), false);
                assert.equal(existsSync(join(dir, `t1_${plainId}.jsonl`)), true);
                rmSync(dir, { recursive: true, force: true });
            },
        ],
        [
            "delete: a missing directory returns 0 without throwing",
            () => {
                assert.equal(
                    deleteChildSessionFiles(join(tmpdir(), "fresh-nope"), "worker", CWD),
                    0,
                );
            },
        ],
        [
            "memory: with no provider, clearing is a no-op and the store survives",
            () => {
                setBlackholeSnapshotApi(undefined);
                assert.equal(getBlackholeSnapshotApi(), undefined);
                const id = `fresh-noprovider-${Math.random().toString(16).slice(2, 10)}`;
                const mainPath = getPendingFilePath(id);
                mkdirSync(dirname(mainPath), { recursive: true });
                writeFileSync(mainPath, JSON.stringify({ observations: [], reflections: [] }));
                clearChildMemory(id);
                assert.equal(readFileSync(mainPath, "utf8").includes("observations"), true);
                rmSync(mainPath, { force: true });
            },
        ],
        [
            "memory: with the provider, clearing drops main, backup and tmp but keeps other ids",
            async () => {
                const blackholeMod = await importProd(jiti, "agent/extensions/blackhole/index.js");
                const factory = blackholeMod.default ?? blackholeMod;
                factory({
                    on: () => {},
                    registerTool: () => {},
                    registerCommand: () => {},
                    registerMessageRenderer: () => {},
                    registerEntryRenderer: () => {},
                });
                assert.ok(getBlackholeSnapshotApi(), "provider not registered");
                const id = `fresh-live-${Math.random().toString(16).slice(2, 10)}`;
                const other = `fresh-other-${Math.random().toString(16).slice(2, 10)}`;
                const mainPath = getPendingFilePath(id);
                mkdirSync(dirname(mainPath), { recursive: true });
                const files = [mainPath, backupFor(mainPath), `${mainPath}.tmp`];
                for (const p of files) writeFileSync(p, "{}");
                const otherPath = getPendingFilePath(other);
                writeFileSync(otherPath, "{}");
                clearChildMemory(id);
                for (const p of files) assert.equal(existsSync(p), false);
                assert.equal(existsSync(otherPath), true);
                rmSync(otherPath, { force: true });
            },
        ],
        // The registry rejects a name another live terminal already holds, in any
        // project, so the owner is part of the name.
        [
            "name: the owner terminal keeps same-agent names apart",
            () => {
                assert.equal(agentNameFor("scout", "t95"), "herdr-scout-t95");
                assert.notEqual(agentNameFor("scout", "t95"), agentNameFor("scout", "t8p"));
                assert.notEqual(agentNameFor("scout", "t95"), agentNameFor("worker", "t95"));
            },
        ],
        [
            "name: folded to the registry alphabet",
            () => {
                assert.equal(agentNameFor("My.Agent", "T9B"), "herdr-my-agent-t9b");
            },
        ],
        [
            "name: stays inside the 32-char registry limit",
            () => {
                const name = agentNameFor("a".repeat(40), "t95");
                assert.ok(name.length <= 32, `${name} is ${name.length} chars`);
                assert.ok(name.endsWith("-t95"));
                assert.match(name, /^[a-z0-9_-]+$/);
            },
        ],
    ],
    "subagent session helpers",
);
