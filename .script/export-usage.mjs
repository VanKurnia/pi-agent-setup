// Which exports in pi-tool-display are actually consumed by another module?
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve("agent/extensions/pi-tool-display/src");
function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.ts$/.test(e)) out.push(p);
    }
    return out;
}
const files = walk(root);
const rel = (f) => relative(root, f).replace(/\\/g, "/");
const text = new Map(files.map((f) => [f, readFileSync(f, "utf-8")]));

const exported = new Map(); // name -> Set(files exporting)
for (const [f, s] of text) {
    const re = /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(s))) {
        const n = m[1];
        if (!exported.has(n)) exported.set(n, new Set());
        exported.get(n).add(f);
    }
    const re2 = /^export\s*\{([^}]*)\}/gm;
    while ((m = re2.exec(s)))
        for (const part of m[1].split(",")) {
            const t = part.trim();
            if (!t) continue;
            const as = t.split(/\s+as\s+/);
            const n = (as[1] ?? as[0]).trim();
            if (!exported.has(n)) exported.set(n, new Set());
            exported.get(n).add(f);
        }
}

const unused = [];
const usedElsewhere = [];
for (const [name, exps] of exported) {
    const rx = new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\b", "g");
    let external = false;
    let internal = 0;
    for (const [g, gs] of text) {
        const c = (gs.match(rx) ?? []).length;
        if (exps.has(g)) internal += c;
        else if (c) external = true;
    }
    const entry = { name, files: [...exps].map(rel), internal, external };
    if (external) usedElsewhere.push(entry);
    else unused.push(entry);
}

console.log(`TOTAL exports: ${exported.size}\n`);
console.log(`=== EXPORTED BUT NEVER IMPORTED ELSEWHERE (${unused.length}) ===`);
for (const u of unused.sort((a, b) => b.internal - a.internal))
    console.log(`  ${u.name.padEnd(36)} refs-in-own-file=${String(u.internal).padStart(3)}  ${u.files.join(", ")}`);

console.log(`\n=== IMPORTED ELSEWHERE (${usedElsewhere.length}) ===`);
for (const u of usedElsewhere.sort((a, b) => a.name.localeCompare(b.name)))
    console.log(`  ${u.name.padEnd(36)} <- ${u.files.join(", ")}`);