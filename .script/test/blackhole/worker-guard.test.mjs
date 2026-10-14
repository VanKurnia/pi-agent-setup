// Test: background-worker failure isolation (cooldown) and stream timeout.
// Run from repo root: node .script/test/blackhole/worker-guard.test.mjs
//
// The helpers are module-level and take an explicit `now`, so no timers and no
// pi/ctx fixtures are needed.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const om = await importProd(jiti, "agent/extensions/blackhole/om.js");
const { clearWorkerCooldown, isWorkerCoolingDown, markWorkerFailure, withTimeout } = om;
for (const [name, fn] of Object.entries({
    clearWorkerCooldown,
    isWorkerCoolingDown,
    markWorkerFailure,
    withTimeout,
})) {
    assert.equal(typeof fn, "function", `${name} missing`);
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("a fresh worker is not cooling down", () => {
    assert.equal(isWorkerCoolingDown("observer-fresh", 1_000), false);
});

test("a failure opens a five-minute window", () => {
    markWorkerFailure("observer-a", 1_000);
    assert.equal(isWorkerCoolingDown("observer-a", 1_001), true);
    assert.equal(isWorkerCoolingDown("observer-a", 1_000 + 300_001), false);
});

test("clearing releases the window", () => {
    markWorkerFailure("observer-b", 1_000);
    clearWorkerCooldown("observer-b");
    assert.equal(isWorkerCoolingDown("observer-b", 1_000), false);
});

test("workers are isolated from each other", () => {
    markWorkerFailure("reflector-c", 1_000);
    assert.equal(isWorkerCoolingDown("observer-c", 1_000), false);
    assert.equal(isWorkerCoolingDown("dropper-c", 1_000), false);
});

test("withTimeout rejects a hung stream and clears its timer", async () => {
    const started = Date.now();
    await assert.rejects(
        withTimeout(() => new Promise(() => {}), 5),
        /worker timeout after 5ms/,
    );
    assert.ok(Date.now() - started < 2_000, "timeout did not fire promptly");
});

test("withTimeout resolves fast work unchanged", async () => {
    assert.equal(await withTimeout(async () => "done", 1_000), "done");
});

await runCases(cases, "\nblackhole worker guard");
