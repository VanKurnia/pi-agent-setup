// Test: worker notices go through the non-context entry channel.
// Run from repo root: node .script/test/blackhole/worker-notice.test.mjs
//
// notifyWorkerAction only touches the pi object handed to it, so a recording
// stub is enough: no ctx, no filesystem, no model calls.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const om = await importProd(jiti, "agent/extensions/blackhole/om.js");
const { notifyWorkerAction } = om;
assert.equal(typeof notifyWorkerAction, "function");

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("worker notices are appended as entries, never sent as messages", () => {
    const calls = [];
    const piStub = {
        appendEntry: (customType, data) => calls.push({ customType, data }),
        sendMessage: () => {
            throw new Error("sendMessage must not be used for worker notices");
        },
    };
    notifyWorkerAction(piStub, "observer", "SUMMARY", "DETAILS");
    assert.equal(calls.length, 1, "expected exactly one appendEntry call");
    assert.equal(calls[0].customType, "blackhole:observer");
    assert.equal(calls[0].data.summary, "SUMMARY");
    assert.equal(calls[0].data.details, "DETAILS");
});

test("a pi without appendEntry does not throw", () => {
    notifyWorkerAction({}, "reflector", "SUMMARY");
});

test("the compaction notice uses the same channel", () => {
    const calls = [];
    notifyWorkerAction(
        { appendEntry: (customType, data) => calls.push({ customType, data }) },
        "compaction",
        "threshold reached",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].customType, "blackhole:compaction");
    assert.equal(calls[0].data.summary, "threshold reached");
    assert.equal(calls[0].data.details, undefined);
});

await runCases(cases, "\nblackhole worker notice channel");
