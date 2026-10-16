// Test: ext-mgr preset store — names, keys, round-trip, apply plan, corrupt tolerance.
// Run from repo root: node .script/test/ext-mgr/preset-store.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "extmgr-preset-"));
process.env.PI_CODING_AGENT_DIR = dir;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
assert.equal(getAgentDir(), dir, "agent dir redirect took effect");

const { createTestJiti, importProd } = await import("../subagent/helpers.mjs");
const jiti = await createTestJiti();
const m = await importProd(jiti, "agent/extensions/ext-mgr/manager.js");

try {
    for (const name of ["work", "a1-b2", "x"]) {
        assert.equal(m.isValidPresetName(name), true, name);
    }
    for (const name of ["Work", "a/b", "../x", "", "y".repeat(33)]) {
        assert.equal(m.isValidPresetName(name), false, JSON.stringify(name));
    }
    console.log("ok - names");

    assert.equal(m.presetKeyFor("global", "/r", "/r/foo/index.ts"), "global/foo/index.ts");
    console.log("ok - keys");

    const cwd = "/proj";
    const live = [
        {
            scope: "project",
            state: "enabled",
            activePath: "/proj/.pi/extensions/x/index.ts",
            disabledPath: "/proj/.pi/extensions/x/index.ts.disabled",
        },
    ];
    const livePkgs = [{ source: "npm:foo" }];
    const snap = m.buildPresetSnapshot(live, cwd, [{ source: "npm:foo", autoload: false }]);
    assert.deepEqual(snap.extensions, { "project/x/index.ts": "enabled" });
    assert.equal(snap.cwd, cwd);
    await m.writePresetFile({ version: 1, presets: { work: snap } });
    assert.equal(existsSync(join(dir, "ext-presets.json")), true, "preset file in temp dir");
    const reread = await m.readPresetFile();
    assert.deepEqual(reread.presets.work.plugins, [{ source: "npm:foo", autoload: false }]);
    console.log("ok - round-trip verbatim");

    const snap2 = {
        ...snap,
        extensions: { "project/x/index.ts": "enabled", "project/gone/index.ts": "disabled" },
        plugins: [{ source: "npm:foo" }, { source: "npm:ghost" }],
    };
    const plan = m.planPresetApply(snap2, cwd, live, livePkgs);
    assert.equal(plan.skippedExt.length, 1);
    assert.equal(plan.skippedPlugins.length, 1);
    assert.equal(plan.pluginsChanged, true);
    const steady = m.planPresetApply(
        { ...snap2, extensions: { "project/x/index.ts": "enabled" }, plugins: livePkgs },
        cwd,
        live,
        livePkgs,
    );
    assert.deepEqual([steady.toEnable.length, steady.toDisable.length], [0, 0]);
    assert.equal(steady.pluginsChanged, false);
    const foreign = m.planPresetApply({ ...snap2, cwd: "/other" }, cwd, live, livePkgs);
    assert.ok(foreign.skippedExt.includes("project/x/index.ts"));
    console.log("ok - apply plan");

    await writeFile(join(dir, "ext-presets.json"), "{nope", "utf8");
    assert.deepEqual(await m.readPresetFile(), { version: 1, presets: {} });
    console.log("ok - corrupt reads empty");
} finally {
    rmSync(dir, { recursive: true, force: true });
}
console.log("preset-store: all ok");
