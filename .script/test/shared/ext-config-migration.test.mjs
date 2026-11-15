// The ext-config migration must move every legacy config file exactly once, never overwrite
// a destination that already exists, never touch blackhole's runtime session store, and be
// safe to re-run. Each case builds its own temp layout and invokes the real script.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "../subagent/helpers.mjs";

const SCRIPT = join(ROOT, ".script", "migrate-ext-config.mjs");

const LEGACY = [
    ["zentui.json", "zentui.json"],
    ["pi-speeed.json", "pi-speeed.json"],
    ["ext-presets.json", "ext-presets.json"],
    ["db-config.example.json", "db-config.example.json"],
    ["db-config.json", "db-config.json"],
    ["subagents.json", "subagents.json"],
    ["session-mgr-settings.json", "session-mgr-settings.json"],
    ["pi-blackhole/pi-blackhole-config.json", "pi-blackhole-config.json"],
];

const run = (root) => spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
const write = (root, relative, body) => {
    const path = join(root, "agent", relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
};

let failures = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const tempRoot = () => mkdtempSync(join(tmpdir(), "ext-config-migration-"));

test("moves every legacy file and keeps its bytes", () => {
    const root = tempRoot();
    try {
        for (const [from] of LEGACY) write(root, from, `{"from":"${from}"}`);
        const res = run(root);
        assert.equal(res.status, 0, res.stderr);
        for (const [from, to] of LEGACY) {
            assert.equal(existsSync(join(root, "agent", from)), false, `old ${from} still present`);
            assert.equal(
                readFileSync(join(root, "agent", "ext-config", to), "utf8"),
                `{"from":"${from}"}`,
                `content lost for ${to}`,
            );
        }
        assert.match(res.stdout, /8 file\(s\) migrated/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("never overwrites an existing destination and keeps the old copy", () => {
    const root = tempRoot();
    try {
        write(root, "zentui.json", "old");
        mkdirSync(join(root, "agent", "ext-config"), { recursive: true });
        writeFileSync(join(root, "agent", "ext-config", "zentui.json"), "new", "utf8");
        const res = run(root);
        assert.equal(res.status, 0, res.stderr);
        assert.equal(readFileSync(join(root, "agent", "ext-config", "zentui.json"), "utf8"), "new");
        assert.equal(readFileSync(join(root, "agent", "zentui.json"), "utf8"), "old");
        assert.match(res.stdout, /skip\s+agent\/zentui\.json/);
        assert.match(res.stdout, /1 collision\(s\) left in place/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("leaves blackhole's runtime session store alone", () => {
    const root = tempRoot();
    try {
        write(root, "pi-blackhole/abc-pending.json", "{}");
        write(root, "pi-blackhole/pi-blackhole-config.json", "{}");
        const res = run(root);
        assert.equal(res.status, 0, res.stderr);
        assert.equal(existsSync(join(root, "agent", "pi-blackhole", "abc-pending.json")), true);
        assert.equal(existsSync(join(root, "agent", "pi-blackhole", "pi-blackhole-config.json")), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("is a no-op on an already migrated layout", () => {
    const root = tempRoot();
    try {
        write(root, "zentui.json", "config");
        assert.equal(run(root).status, 0);
        const second = run(root);
        assert.equal(second.status, 0, second.stderr);
        assert.match(second.stdout, /nothing to migrate/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("does nothing on a fresh checkout", () => {
    const root = tempRoot();
    try {
        mkdirSync(join(root, "agent"), { recursive: true });
        const res = run(root);
        assert.equal(res.status, 0, res.stderr);
        assert.match(res.stdout, /nothing to migrate/);
        assert.equal(existsSync(join(root, "agent", "ext-config")), false, "created an empty target dir");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

for (const [name, fn] of cases) {
    try {
        fn();
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures++;
        console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
    }
}

console.log(`\n${cases.length - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
