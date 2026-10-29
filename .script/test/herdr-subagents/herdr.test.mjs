// Tests for the herdr socket client's protocol gate in
// agent/extensions/herdr-subagents/herdr.ts.
// Run from repo root: node .script/test/herdr-subagents/herdr.test.mjs
// Pure helpers only: the socket calls need a live herdr and a live agent.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const herdr = await importProd(jiti, "agent/extensions/herdr-subagents/herdr.js");

await runCases(
    [
        [
            "protocol: current version accepted",
            () => assert.equal(herdr.protocolError(22), undefined),
        ],
        [
            "protocol: newer version accepted",
            () => assert.equal(herdr.protocolError(23), undefined),
        ],
        [
            "protocol: older version names required and found",
            () => {
                const message = herdr.protocolError(21);
                assert.equal(typeof message, "string");
                assert.ok(message.includes("21"));
                assert.ok(message.includes("22"));
            },
        ],
        [
            "protocol: missing version reported, not thrown",
            () => assert.equal(typeof herdr.protocolError(undefined), "string"),
        ],
        [
            "protocol: a string version is not a number",
            () => assert.equal(typeof herdr.protocolError("22"), "string"),
        ],
    ],
    "herdr protocol gate",
);
