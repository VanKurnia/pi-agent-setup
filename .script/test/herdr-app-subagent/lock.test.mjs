// Tests for the pid-aware dispatch lock (session.ts: acquireLock / isProcessAlive).
// Run from repo root: node .script/test/herdr-app-subagent/lock.test.mjs
//
// The staleness rule runs through the injectable `fs`, so a "live holder with an
// old mtime" is producible without spawning anything. The last case runs the
// real default filesystem, because `defaultFs` gained the readFileSync entry the
// pid branch reads through.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const session = await importProd(jiti, "agent/extensions/herdr-app-subagent/session.js");
const { acquireLock, isProcessAlive } = session;

assert.equal(typeof acquireLock, "function", "acquireLock is not exported");
assert.equal(typeof isProcessAlive, "function", "isProcessAlive is not exported");

const LOCK = "herdr-subagent-fixture.lock";
const STALE_MS = 60 * 1000;
const OLD = Date.now() - 2 * STALE_MS; // past any sane mtime horizon
const RECENT = Date.now() - 1000;
const deadPid = 999_999; // verified ESRCH on this platform

/** An in-memory fs implementing exactly the surface acquireLock injects. */
function memoryFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const open = new Map();
    let nextFd = 1;
    const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return {
        files,
        openSync(path, flags) {
            if (flags === "wx" && files.has(path)) {
                throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
            }
            files.set(path, { text: "", mtimeMs: Date.now() });
            open.set(nextFd, path);
            return nextFd++;
        },
        writeSync(fd, text) {
            const entry = files.get(open.get(fd));
            if (entry === undefined) throw missing(`fd ${fd}`);
            entry.text = text;
        },
        closeSync(fd) {
            open.delete(fd);
        },
        readFileSync(path, encoding) {
            const entry = files.get(path);
            if (entry === undefined) throw missing(path);
            assert.equal(encoding, "utf8", "acquireLock must read the lock as utf8");
            return entry.text;
        },
        statSync(path) {
            const entry = files.get(path);
            if (entry === undefined) throw missing(path);
            return { mtimeMs: entry.mtimeMs };
        },
        unlinkSync(path) {
            if (!files.delete(path)) throw missing(path);
        },
    };
}

const withLock = (text, mtimeMs) => memoryFs({ [LOCK]: { text, mtimeMs } });

await runCases(
    [
        [
            "isProcessAlive: true for this process, false for a pid that cannot exist",
            () => {
                assert.equal(isProcessAlive(process.pid), true);
                assert.equal(isProcessAlive(deadPid), false);
            },
        ],
        [
            "lock: a live holder is not stolen, however old the lock file is",
            () => {
                const fs = withLock(JSON.stringify({ pid: process.pid, startedAt: 0 }), OLD);
                assert.equal(acquireLock(LOCK, fs), false, "a live pid must never be treated as stale");
                // Untouched: still the holder's file, not ours.
                assert.equal(fs.files.get(LOCK).text, JSON.stringify({ pid: process.pid, startedAt: 0 }));
            },
        ],
        [
            "lock: a dead holder is stolen without waiting for the mtime horizon",
            () => {
                const fs = withLock(JSON.stringify({ pid: deadPid, startedAt: 0 }), RECENT);
                assert.equal(acquireLock(LOCK, fs), true, "a dead pid must not block dispatch");
                assert.equal(JSON.parse(fs.files.get(LOCK).text).pid, process.pid);
            },
        ],
        [
            "lock: a lock with no pid is treated as stale",
            () => {
                // Writers always record a pid, so a valid-JSON lock without one is
                // not a holder to honour: it is stolen rather than waited out. Only
                // an unreadable lock defers to the clock (next case).
                assert.equal(acquireLock(LOCK, withLock("{}", RECENT)), true);
            },
        ],
        [
            "lock: unparseable json falls back to the mtime horizon",
            () => {
                assert.equal(acquireLock(LOCK, withLock("not json", RECENT)), false);
                assert.equal(acquireLock(LOCK, withLock("not json", OLD)), true);
            },
        ],
        [
            "lock: no lock file → acquired, and the file now exists with our pid",
            () => {
                const fs = memoryFs();
                assert.equal(fs.files.has(LOCK), false);
                assert.equal(acquireLock(LOCK, fs), true);
                assert.equal(fs.files.has(LOCK), true, "the lock file must now exist");
                assert.equal(JSON.parse(fs.files.get(LOCK).text).pid, process.pid);
            },
        ],
        [
            "lock: the real default fs keeps a live holder and adopts a dead one",
            () => {
                const dir = mkdtempSync(join(tmpdir(), "herdr-lock-"));
                const path = join(dir, "x.lock");
                const old = new Date(OLD);
                try {
                    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: 0 }));
                    utimesSync(path, old, old);
                    assert.equal(acquireLock(path), false, "a live holder must not be stolen");
                    assert.equal(existsSync(path), true);
                    assert.equal(JSON.parse(readFileSync(path, "utf8")).startedAt, 0, "not rewritten");

                    writeFileSync(path, JSON.stringify({ pid: deadPid, startedAt: 0 }));
                    utimesSync(path, old, old);
                    assert.equal(acquireLock(path), true, "a dead holder is stolen on the real fs");
                    const adopted = JSON.parse(readFileSync(path, "utf8"));
                    assert.equal(adopted.pid, process.pid);
                    assert.ok(adopted.startedAt > 0, "the stolen lock was rewritten for the new holder");
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            },
        ],
    ],
    "subagent dispatch lock",
);
