// Test: character-capped truncation never splits a surrogate pair.
// Run from repo root: node .script/test/shared/text-format.test.mjs
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const textMod = await importProd(jiti, "agent/extensions/shared/text-format.js");
const { truncateChars } = textMod;
assert.equal(typeof truncateChars, "function", "truncateChars missing");

const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("cuts ASCII at the limit", () => {
    assert.equal(truncateChars("hello world", 5), "hello");
});

test("returns text that already fits unchanged", () => {
    assert.equal(truncateChars("hello", 5), "hello");
});

test("drops a high surrogate that would be left alone", () => {
    assert.equal(truncateChars("x😀y", 2), "x");
});

test("empties the result when the cut falls on a leading surrogate", () => {
    assert.equal(truncateChars("😀😀", 1), "");
});

test("never ends on a lone high surrogate at any limit", () => {
    for (let i = 0; i <= 6; i++) {
        const cut = truncateChars("a😀b😀", i);
        assert.ok(!LONE_HIGH_SURROGATE.test(cut), `limit ${i} left a lone surrogate: ${cut}`);
    }
});

await runCases(cases, "\nshared text-format truncation");
