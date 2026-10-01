/**
 * Fixture test for `src/plugins.ts`. Never writes to the real settings file.
 *
 * Run from the repo root (there is no test runner in this repo):
 *
 *   npx tsc agent/extensions/extmgr/test/plugins-fixtures.ts --outDir tmp/plugins-build \
 *     --rootDir agent/extensions/extmgr --module esnext --target esnext --moduleResolution bundler
 *   node tmp/plugins-build/test/plugins-fixtures.js
 *
 * Exits non-zero on the first failed expectation.
 */

/* eslint-disable no-console -- a CLI fixture reports through stdout */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    packageName,
    packageSource,
    packageState,
    readPackages,
    setPackageEnabled,
    writePackages,
    type PackageSetting,
} from "../src/plugins.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  PASS  ${label}`);
    } else {
        failures += 1;
        console.log(`  FAIL  ${label}\n        actual:   ${a}\n        expected: ${e}`);
    }
}

console.log("states");
check("bare source is enabled", packageState("npm:alpha"), "enabled");
check("object without filters is enabled", packageState({ source: "npm:alpha" }), "enabled");
check(
    "empty extension filter is disabled",
    packageState({ source: "npm:alpha", extensions: [] }),
    "disabled",
);
check(
    "another narrow filter is filtered",
    packageState({ source: "npm:alpha", skills: ["!x.md"] }),
    "filtered",
);

console.log("toggling");
const off = setPackageEnabled("npm:alpha", false);
check("disable a bare source", off, { source: "npm:alpha", extensions: [] });
check("disabled state", packageState(off), "disabled");
check("enable restores the bare source", setPackageEnabled(off, true), "npm:alpha");

const filtered: PackageSetting = { source: "npm:beta", skills: ["!skills/legacy.md"] };
check("disable keeps unrelated filters", setPackageEnabled(filtered, false), {
    source: "npm:beta",
    skills: ["!skills/legacy.md"],
    extensions: [],
});
check(
    "enable drops only the extension filter",
    setPackageEnabled({ source: "npm:beta", skills: ["!skills/legacy.md"], extensions: [] }, true),
    filtered,
);

console.log("naming");
check("npm prefix stripped", packageName("npm:@scope/tool"), "@scope/tool");
check("git url reduced to its name", packageName("git:https://example.com/team/tool.git"), "tool");
check("source passthrough", packageSource({ source: "npm:@scope/tool" }), "npm:@scope/tool");

console.log("settings file (synthetic)");
const dir = mkdtempSync(join(tmpdir(), "extmgr-plugins-"));
const synthetic = join(dir, "settings.json");
const fixture = {
    theme: "tokyo-night",
    packages: [
        "npm:alpha",
        { source: "npm:beta", extensions: [] },
        { source: "npm:gamma", skills: ["!skills/legacy.md"] },
    ],
};
writeFileSync(synthetic, JSON.stringify(fixture, null, 2));
const before = readFileSync(synthetic, "utf8");

const read = await readPackages(synthetic);
check("reads every entry", read.length, 3);
check(
    "reports each state",
    read.map((entry) => packageState(entry)),
    ["enabled", "disabled", "filtered"],
);

await writePackages(synthetic, read);
check("no-op write is byte-identical", readFileSync(synthetic, "utf8") === before, true);

const toggledOff = read.map((entry, index) =>
    index === 2 ? setPackageEnabled(entry, false) : entry,
);
await writePackages(synthetic, toggledOff);
const written = JSON.parse(readFileSync(synthetic, "utf8")) as {
    theme: string;
    packages: PackageSetting[];
};
check("unrelated keys survive", written.theme, "tokyo-night");
check("untouched entries are unchanged", written.packages.slice(0, 2), [
    "npm:alpha",
    { source: "npm:beta", extensions: [] },
]);
check("toggled entry keeps its other filters", written.packages[2], {
    source: "npm:gamma",
    skills: ["!skills/legacy.md"],
    extensions: [],
});

const restored = written.packages.map((entry, index) =>
    index === 2 ? setPackageEnabled(entry, true) : entry,
);
await writePackages(synthetic, restored);
check(
    "toggle off then on restores the original bytes",
    readFileSync(synthetic, "utf8") === before,
    true,
);

const newlineFile = join(dir, "newline.json");
writeFileSync(newlineFile, `${JSON.stringify({ packages: ["npm:alpha"] }, null, 2)}\n`);
await writePackages(newlineFile, await readPackages(newlineFile));
check(
    "trailing newline convention is preserved",
    readFileSync(newlineFile, "utf8").endsWith("}\n"),
    true,
);

console.log("settings file (real, copied)");
const real = join(process.cwd(), "agent", "settings.json");
if (!existsSync(real)) {
    console.log("  SKIP  agent/settings.json not found (run from the repo root)");
} else {
    const copy = join(dir, "real-settings.json");
    copyFileSync(real, copy);
    const realBefore = readFileSync(copy, "utf8");
    const realPackages = await readPackages(copy);
    check("every configured entry parses", Array.isArray(realPackages), true);
    await writePackages(copy, realPackages);
    check("rewrite is byte-identical", readFileSync(copy, "utf8") === realBefore, true);
    check("the real file was never written", readFileSync(real, "utf8") === realBefore, true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
