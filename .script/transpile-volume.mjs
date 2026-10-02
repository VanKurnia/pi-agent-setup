// Split pi-tool-display's graph into boot-static (sync imports) vs lazy (dynamic import only).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = resolve("agent/extensions/pi-tool-display");
function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules") continue;
        const p = join(dir, e);
        const s = statSync(p);
        if (s.isDirectory()) walk(p, out);
        else if (/\.ts$/.test(e)) out.push(p);
    }
    return out;
}
const files = walk(root);
const rel = (f) => relative(root, f).replace(/\\/g, "/");
const size = (f) => statSync(f).size;

function resolveSpec(spec, from) {
    const base = resolve(dirname(from), spec.replace(/\.js$/, ".ts"));
    for (const c of [base, base + ".ts", base + "/index.ts"])
        if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
}

const staticDeps = new Map();
const dynamicDeps = new Map();
for (const f of files) {
    const s = readFileSync(f, "utf-8");
    const st = new Set(), dy = new Set();
    // static: import/export ... from "x"   (not preceded by `(`)
    const sre = /(?:^|[\s;}])import\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|(?:^|[\s;}])export\s+(?:[^'"]*?\sfrom\s+)["']([^"']+)["']/g;
    let m;
    while ((m = sre.exec(s))) { const sp = m[1] ?? m[2]; if (sp?.startsWith(".")) st.add(resolveSpec(sp, f)); }
    const dre = /import\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dre.exec(s))) { const sp = m[1]; if (sp.startsWith(".")) dy.add(resolveSpec(sp, f)); }
    staticDeps.set(f, [...st].filter(Boolean));
    dynamicDeps.set(f, [...dy].filter(Boolean));
}

const entry = resolve(root, "index.ts");
const seen = new Set();
const st2 = [entry];
while (st2.length) {
    const f = st2.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of staticDeps.get(f) ?? []) st2.push(d);
}
const lazy = files.filter((f) => !seen.has(f));

const sum = (arr) => arr.reduce((a, f) => a + size(f), 0);

console.log(`TOTAL .ts: ${files.length} files, ${(sum(files) / 1024).toFixed(1)} KB\n`);
console.log(`BOOT-STATIC (transpiled every boot): ${seen.size} files, ${(sum([...seen]) / 1024).toFixed(1)} KB`);
console.log(`LAZY (dynamic import, only on /tool-display): ${lazy.length} files, ${(sum(lazy) / 1024).toFixed(1)} KB\n`);
console.log("--- boot-static modules by size ---");
for (const f of [...seen].sort((a, b) => size(b) - size(a)))
    console.log("  " + String(size(f)).padStart(7) + " B  " + rel(f));
console.log("\n--- lazy modules ---");
for (const f of lazy.sort((a, b) => size(b) - size(a)))
    console.log("  " + String(size(f)).padStart(7) + " B  " + rel(f) + "   <- " + (dynamicDeps.get([...seen].find((s) => (dynamicDeps.get(s) ?? []).includes(f))) ?? []).map(rel).join(", "));