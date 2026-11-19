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
    [
        "WITH t AS (SELECT 1) UPDATE users SET admin = 1 -- select",
        false,
        "a trailing line comment cannot hide a CTE ending in UPDATE",
    ],
    [
        "WITH c AS (SELECT 1) DELETE FROM users -- select",
        false,
        "a trailing line comment cannot hide a CTE ending in DELETE",
    ],
    [
        "WITH x AS (SELECT 1) SELECT * FROM x -- update",
        true,
        "a comment naming a write keyword must not false-reject a read",
    ],
    ["SELECT 1 /* delete */", true, "a block comment cannot make a read look like a write"],
    ["PRAGMA user_version = 42", false, "an assigning PRAGMA mutates and is rejected"],
];

let n = 0;
for (const [input, wantSafe, label] of cases) {
    const result = isQuerySafe(input); // must not throw
    assert.equal(result.safe, wantSafe, label);
    console.log(`ok ${++n} - ${label}`);
}
console.log("param-guards: all ok");
