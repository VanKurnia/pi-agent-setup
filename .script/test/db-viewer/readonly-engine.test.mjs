// Test: `PRAGMA query_only = ON` is db-viewer's real write gate for SQLite —
// it blocks writes at the engine, independent of the string allowlist.
// Run from repo root: node .script/test/db-viewer/readonly-engine.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "db-viewer-readonly-"));
const file = join(dir, "engine.db");

// Seed before the pragma, so the fixture itself is not blocked.
const seed = new DatabaseSync(file);
seed.exec("create table users(id integer primary key, name text not null)");
seed.exec("insert into users(name) values ('ada')");
seed.close();

// The handle db-viewer opens, made read-only exactly as index.ts does.
const db = new DatabaseSync(file);
db.exec("PRAGMA query_only = ON");

let n = 0;
const ok = (label) => console.log(`ok ${++n} - ${label}`);

assert.throws(
    () => db.exec("insert into users(name) values ('grace')"),
    /readonly/i,
    "INSERT must be blocked by query_only",
);
ok("INSERT throws under query_only");

assert.throws(
    () => db.prepare("insert into users(name) values ('grace')").run(),
    /readonly/i,
    "prepared INSERT must be blocked too",
);
ok("prepared INSERT throws under query_only");

const rows = db.prepare("select name from users").all();
assert.equal(rows.length, 1);
assert.equal(rows[0].name, "ada");
ok("SELECT still returns the seeded row");

assert.equal(db.prepare("select count(*) as c from users").all()[0].c, 1);
ok("the blocked write left no row behind");

db.close();
rmSync(dir, { recursive: true, force: true });
console.log("readonly-engine: all ok");
