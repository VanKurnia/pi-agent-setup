// Test: ext-mgr's settings reader distinguishes "no packages" from "cannot read".
// Run from repo root: node .script/test/ext-mgr/settings-parse.test.mjs
//
// Hermetic: PI_CODING_AGENT_DIR points at a temp dir and every file is real, so an
// unparsable settings.json never reaches the operator's own agent dir.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestJiti, importProd } from "../subagent/helpers.mjs";

const dir = mkdtempSync(join(tmpdir(), "extmgr-parse-"));
process.env.PI_CODING_AGENT_DIR = dir;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
assert.equal(getAgentDir(), dir, "agent dir redirect took effect");

const jiti = await createTestJiti();
const { readPackages } = await importProd(jiti, "agent/extensions/ext-mgr/manager.js");
assert.equal(typeof readPackages, "function", "readPackages is not exported");

const settings = join(dir, "settings.json");
const writeSettings = (text) => writeFile(settings, text, "utf8");

let n = 0;
const ok = (label) => console.log(`ok ${++n} - ${label}`);

try {
    await writeSettings(JSON.stringify({ packages: [{ source: "npm:x" }] }));
    const one = await readPackages(settings);
    assert.equal(one.ok, true, "a well-formed file must read");
    assert.equal(one.packages.length, 1);
    assert.equal(one.packages[0].source, "npm:x");
    ok("a packages array is read back");

    await writeSettings("{}");
    const empty = await readPackages(settings);
    assert.equal(empty.ok, true, "an absent key is not an error");
    assert.deepEqual(empty.packages, []);
    ok("a missing packages key reads as an empty list");

    await writeSettings('{"packages":');
    const broken = await readPackages(settings);
    assert.equal(broken.ok, false, "malformed JSON must not look like zero packages");
    assert.ok(broken.error.includes("not valid JSON"), broken.error);
    ok("malformed JSON is reported, not rendered as empty");

    rmSync(settings, { force: true });
    const missing = await readPackages(settings);
    assert.equal(missing.ok, false, "a missing file must not look like zero packages");
    assert.ok(missing.error.includes("Cannot read"), missing.error);
    ok("a missing settings file is reported");
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log("ext-mgr settings-parse: all ok");
