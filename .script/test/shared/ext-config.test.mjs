// Test: shared ext-config helper — single convention for extension-owned JSON.
// Run from repo root: node .script/test/shared/ext-config.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestJiti, importProd } from "../subagent/helpers.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "ext-config-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
assert.equal(getAgentDir(), agentDir, "PI_CODING_AGENT_DIR ignored; refusing to write anywhere else");

const jiti = await createTestJiti();
const mod = await importProd(jiti, "agent/extensions/shared/ext-config.js");

try {
    assert.equal(mod.extConfigPath("zentui.json"), join(agentDir, "ext-config", "zentui.json"));
    console.log("ok - path joins agent dir, ext-config, name");

    assert.equal(existsSync(join(agentDir, "ext-config")), false);
    mod.ensureExtConfigDir();
    assert.equal(existsSync(join(agentDir, "ext-config")), true);
    console.log("ok - ensure creates the dir and nothing else");
} finally {
    rmSync(agentDir, { recursive: true, force: true });
}
console.log("ext-config: all ok");
