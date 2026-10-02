// Rewire importers of a merged module set to the new single file, then delete the originals.
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const srcRoot = resolve("agent/extensions/pi-tool-display/src");
const [, , newFile, ...oldRel] = process.argv;
// oldRel like "pistyle/features/tools/boxed/git.ts" (relative to src/)

const oldStems = new Set(oldRel.map((p) => basename(p).replace(/\.ts$/, "")));
const newStem = basename(newFile).replace(/\.ts$/, "");

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.ts$/.test(e)) out.push(p);
    }
    return out;
}

let touched = 0;
for (const f of walk(srcRoot)) {
    const relFromSrc = f.slice(srcRoot.length + 1).replace(/\\/g, "/");
    if (oldRel.map((p) => p.replace(/\\/g, "/")).includes(relFromSrc)) continue;
    if (relFromSrc === newFile.replace(/\\/g, "/")) continue;

    const before = readFileSync(f, "utf-8");
    // rewrite any relative specifier whose basename is one of the merged stems
    const after = before.replace(
        /(from\s+["'])((?:\.\.?\/)+[^"']*?)(["'])/g,
        (whole, pre, spec, post) => {
            const stem = basename(spec).replace(/\.js$/, "");
            if (!oldStems.has(stem)) return whole;
            // same directory? keep it flat; otherwise point at the new file
            const depth = spec.split("/").length - 1; // ../ count
            const targetDir = spec.replace(/[^/]+$/, "");
            const newSpec = `${targetDir}${newStem}.js`;
            return `${pre}${newSpec}${post}`;
        },
    );
    if (after !== before) {
        writeFileSync(f, after, "utf-8");
        touched++;
    }
}
console.log(`rewrote ${touched} files`);

for (const p of oldRel) {
    const abs = join(srcRoot, p);
    if (existsSync(abs)) { unlinkSync(abs); console.log(`deleted ${p}`); }
}