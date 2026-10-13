#!/usr/bin/env node
// Runs every *.test.mjs under .script/test/ sequentially and aggregates results.
// Each test file is a standalone node script: exit 0 = pass, non-zero = fail.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testDir = join(root, ".script", "test");

const files = readdirSync(testDir, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".test.mjs"))
    .map((entry) => join(testDir, entry))
    .sort();

if (files.length === 0) {
    console.error("No *.test.mjs files found under .script/test/");
    process.exit(1);
}

const failed = [];
for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    console.log(`\n=== ${rel} ===`);
    const res = spawnSync(process.execPath, [file], { cwd: root, stdio: "inherit" });
    if (res.status !== 0) failed.push(rel);
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
for (const rel of failed) console.error(`FAIL ${rel}`);
process.exit(failed.length === 0 ? 0 : 1);
