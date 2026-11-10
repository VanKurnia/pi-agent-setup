// Test: a cancelled fetch reports cancellation, not a timeout.
// Run from repo root: node .script/test/smart-web-access/abort-signal.test.mjs
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const fetchMod = await importProd(jiti, "agent/extensions/smart-web-access/fetch.js");
const { executeFetchToolCall, buildFetchErrorResponseText } = fetchMod;

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("an already-aborted signal is reported as cancelled, not as a timeout", async () => {
    const result = await executeFetchToolCall(
        { url: "https://example.com" },
        {},
        {},
        AbortSignal.abort(),
    );

    assert.equal(result.code, "aborted");
    assert.equal(result.retryable, false);
    assert.equal(result.error, "Fetch cancelled by the user.");
});

test("cancellation text carries no timeout advice", () => {
    const responseText = buildFetchErrorResponseText({
        error: "Fetch cancelled by the user.",
        code: "aborted",
    });

    assert.ok(responseText.includes("Fetch cancelled by the user."), "message missing");
    assert.ok(!responseText.includes("Suggested timeoutMs"), "timeout header must not appear");
    assert.ok(!responseText.includes("higher timeoutMs"), "retry advice must not appear");
});

await runCases(cases, "\nsmart-web-access abort signal");
