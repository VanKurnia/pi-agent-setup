// Test: isQuerySafe never throws — invalid input returns {safe:false}.
// Run from repo root: node .script/test/db-viewer/param-guards.test.mjs
//
// Guards the v1.3.0 strict-validation contract at the shared choke point all
// four db-viewer tools funnel through: a non-string query (reachable via
// direct/test invocation outside host validation) must produce an isError-style
// {safe:false}, never a TypeError out of execute.
import assert from "node:assert/strict";
import { createTestJiti, importProd } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const { isQuerySafe } = await importProd(jiti, "agent/extensions/shared/query-safe.js");

const cases = [
    [undefined, false, "non-string (undefined) returns safe:false"],
    ["", false, "empty returns safe:false"],
    ["DROP TABLE x", false, "write returns safe:false"],
    ["SELECT 1", true, "valid select returns safe:true"],
];

let n = 0;
for (const [input, wantSafe, label] of cases) {
    const result = isQuerySafe(input); // must not throw
    assert.equal(result.safe, wantSafe, label);
    console.log(`ok ${++n} - ${label}`);
}
console.log("param-guards: all ok");
