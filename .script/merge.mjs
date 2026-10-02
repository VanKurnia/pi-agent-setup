// Merge N TypeScript modules into one, preserving `export` and hoisting/deduping imports.
// Usage: node merge.mjs <out.ts> <in1.ts> <in2.ts> ...   (caller supplies dependency order)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const [, , outArg, ...rest] = process.argv;
const TOPO = rest.includes("--topo");
let inputs = rest.filter((a) => a !== "--topo");
const out = resolve(outArg);
const root = resolve("agent/extensions/pi-tool-display/src");

// Resolve an import specifier (relative, .js -> .ts) to a repo file.
function resolveSpec(spec, fromFile) {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ".ts"));
    for (const c of [base, base.replace(/\.ts$/, "/index.ts")])
        if (existsSync(c)) return c;
    return null;
}

// Topologically order so top-level consts never reference a later TDZ binding.
if (TOPO) {
    const set = new Set(inputs.map((f) => resolve(f)));
    const edges = new Map();
    const IMP = /^import\s+(?:type\s+)?[\s\S]*?["']([^"']+)["'];?[ \t]*$/gm;
    for (const f of set) {
        const src = readFileSync(f, "utf-8");
        const deps = new Set();
        let m; IMP.lastIndex = 0;
        while ((m = IMP.exec(src))) { const t = resolveSpec(m[1], f); if (t && set.has(t)) deps.add(t); }
        edges.set(f, deps);
    }
    const ordered = [], seen = new Set();
    const visit = (f, stack = new Set()) => {
        if (seen.has(f) || stack.has(f)) return;
        stack.add(f);
        for (const d of [...(edges.get(f) ?? [])].sort()) visit(d, stack);
        stack.delete(f);
        seen.add(f); ordered.push(f);
    };
    for (const f of [...set].sort()) visit(f);
    console.log("topo order: " + ordered.map((f) => f.replace(/^.*[\\/]/, "")).join(" -> "));
    inputs = ordered;
}

const members = new Set(inputs.map((f) => resolve(f)));
const IMPORT_RE = /^import\s+(?:type\s+)?[\s\S]*?["'][^"']+["'];?[ \t]*$/gm;

// specifier -> { named: Map<name, {name, typeOnly}>, default, namespace }
const extImports = new Map();
const bodies = [];

for (const input of inputs) {
    const file = resolve(input);
    const src = readFileSync(file, "utf-8");
    let body = src;

    // Pull out every top-level import statement.
    let m;
    IMPORT_RE.lastIndex = 0;
    const statements = [];
    while ((m = IMPORT_RE.exec(src))) statements.push({ text: m[0], index: m.index, length: m[0].length });

    for (const st of statements) {
        const specMatch = /["']([^"']+)["']/.exec(st.text);
        const spec = specMatch[1];
        const clause = st.text.slice(0, specMatch.index).replace(/^import\s+/, "").replace(/\s*from\s*$/, "").trim();

        if (members.has(resolveSpec(spec, file))) continue; // becomes local scope

        const isTypeOnly = /^type\s/.test(clause);
        if (!extImports.has(spec)) extImports.set(spec, { named: new Map(), typeOnlyAll: isTypeOnly });
        const bucket = extImports.get(spec);

        // `import type { A } from "x"` -> clause is `type { A }`; the `type` is a modifier,
        // not a default binding.
        const clauseBody = isTypeOnly ? clause.replace(/^type\s+/, "") : clause;
        const braceMatch = /\{([\s\S]*)\}/.exec(clauseBody);
        const head = clauseBody.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
        if (head.startsWith("*")) bucket.namespace = head.replace(/^\*\s*as\s*/, "");
        else if (head) bucket.default = head;
        if (braceMatch) {
            for (const part of braceMatch[1].split(",")) {
                const t = part.trim();
                if (!t) continue;
                const entry = /^type\s+/.test(t)
                    ? { local: t.replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim(), typeOnly: true }
                    : { local: t.split(/\s+as\s+/).pop().trim(), typeOnly: false };
                bucket.named.set(entry.local + (entry.typeOnly ? ":type" : ""), entry);
            }
        }
    }

    // Strip every top-level import statement from the body: in-group ones become local
    // scope, external ones are hoisted into the merged header.
    const dropRanges = [];
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) dropRanges.push([m.index, m.index + m[0].length]);
    for (const [a, b] of dropRanges.reverse()) body = body.slice(0, a) + body.slice(b);
    bodies.push({ file, text: body.replace(/^\s*\n/gm, "").trim() });
}

// Emit imports
const importLines = [];
for (const [spec, b] of extImports) {
    const parts = [];
    if (b.namespace) parts.push(`* as ${b.namespace}`);
    if (b.default) parts.push(b.default);
    const names = [...b.named.values()].map((n) => (n.typeOnly ? `type ${n.local}` : n.local));
    if (names.length) parts.push(`{ ${names.join(", ")} }`);
    if (!parts.length) continue;
    // `import type {...}` is only valid when EVERY binding from this specifier is type-only.
    const allType = !b.namespace && !b.default && [...b.named.values()].every((n) => n.typeOnly);
    const prefix = allType ? "import type " : "import ";
    importLines.push(`${prefix}${parts.join(", ")} from "${spec}";`);
}

const header = [
    "/**",
    " * GENERATED BY .script/merge.mjs - do not edit by hand; edit the sources it lists instead.",
    " * Merged to cut boot cost: jiti pays ~19ms per module regardless of size.",
    " */",
    ...importLines,
    "",
].join("\n");

const outText = header + bodies.map((b) => `\n// ${"=".repeat(60)}\n// from: ${relative(root, b.file)}\n// ${"=".repeat(60)}\n\n${b.text}\n`).join("\n");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, outText, "utf-8");
console.log(`wrote ${relative(root, out)}  (${(outText.length / 1024).toFixed(1)} KB) from ${inputs.length} files`);
for (const [spec, b] of extImports) console.log(`  import ${spec}  named=${b.named.size} ns=${b.namespace ?? "-"} def=${b.default ?? "-"}`);