# 04 — Verification Probes

Read-only Node probes used for every measurement in this directory. They read
`agent/sessions/**/*.jsonl` and `agent/pi-blackhole/*.json`; they write nothing and touch no
repository file. Run any of them with:

```powershell
node <file>.mjs        # Node >= 22.19 (repo engine requirement)
```

Save them outside the repo (e.g. `$env:TEMP`) — `AGENTS.md` forbids stray `.js`/`.mjs` files in the
repository.

---

## P1 — Compaction corpus + era attribution

Attributes every compaction entry to a generator (current VCC vs legacy engine vs pi default) and
reports size/OM/nesting per era. This is the probe that **corrected** the earlier "81% carry no OM"
figure.

```js
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const AGENT = "C:/Users/Ivan/.pi/agent";
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
function walk(dir, out = []) {
  let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".jsonl")) out.push(p); }
  return out;
}
const seen = new Set(), rows = [];
for (const f of walk(join(AGENT, "sessions"))) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.includes('"type":"compaction"')) continue;
    const e = parse(line); if (e?.type !== "compaction") continue;
    const s = String(e.summary ?? "");
    const key = `${e.timestamp}|${s.length}|${s.slice(0, 40)}`;   // dedupe fork copies
    if (seen.has(key)) continue; seen.add(key);
    rows.push({
      ts: String(e.timestamp).slice(0, 10),
      era: s.startsWith("### Files Touched") ? "current-vcc"
        : s.startsWith("[Session Goal]") ? "legacy-vcc"
        : s.startsWith("## ") ? "pi-default" : "other",
      len: s.length, om: /#### Key Observations|#### Key Reflections/.test(s),
      nest: (s.match(/### Previous Context/g) || []).length,
    });
  }
}
const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
for (const era of ["current-vcc", "legacy-vcc", "pi-default"]) {
  const g = rows.filter((r) => r.era === era);
  const len = g.map((r) => r.len);
  console.log(era, {
    n: g.length, omPct: g.length ? Math.round(100 * g.filter((r) => r.om).length / g.length) : 0,
    medChars: med(len), maxChars: Math.max(0, ...len), maxTokens: Math.ceil(Math.max(0, ...len) / 4),
    maxNest: Math.max(0, ...g.map((r) => r.nest)),
    range: g.length ? `${g.map(r => r.ts).sort()[0]}…${g.map(r => r.ts).sort().at(-1)}` : "-",
  });
}
```

**Observed (2026-10-14):** `current-vcc` n=31 omPct=97 medChars=21507 maxChars=123219
maxTokens=30805 maxNest=5 · `legacy-vcc` n=130 omPct=0 medChars=28188 maxChars=127009 ·
`pi-default` n=3. Total unique 164 (of 300 raw entries → fork duplication).

---

## P2 — Ratchet: nesting chain vs length

Proves the monotonic growth claim by printing each compaction in a session chain ordered by time
with its nesting depth.

```js
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
function walk(dir, out = []) { let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; } for (const e of es) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".jsonl")) out.push(p); } return out; }
const rows = [];
for (const f of walk("C:/Users/Ivan/.pi/agent/sessions")) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.includes('"type":"compaction"')) continue;
    const e = parse(line); if (e?.type !== "compaction") continue;
    const s = String(e.summary);
    if (!s.startsWith("### Files Touched")) continue;                  // current VCC only
    rows.push({ ts: e.timestamp, len: s.length, nest: (s.match(/### Previous Context/g) || []).length, sess: f.split(/[\\/]/).pop().slice(0, 24) });
  }
}
// contiguous chains: keep only strictly increasing nesting within one session file
rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
for (const r of rows) console.log(String(r.ts).slice(0, 16), r.nest, r.len, r.sess);
```

**Observed:** a single-session chain with nesting 1 → 2 → 3 → 4 at 8,449 → 16,524 → 21,507 →
40,119 chars; era maximum 123,219 chars ≈ 30,805 tokens at nesting 4, and 87,949 at nesting 5 —
against pi's `keepRecentTokens: 20000`.

Corroboration (legacy era, different marker): 26 of 28 successive summaries contained the previous
summary's first 400 chars verbatim, across 33 sessions — measured by testing
`summary[i].includes(summary[i-1].slice(0, 400))` within the same session file.

---

## P3 — Ledger health + context tax of worker messages

```js
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const AGENT = "C:/Users/Ivan/.pi/agent", BH = join(AGENT, "pi-blackhole");
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const est = (m) => Math.ceil(JSON.stringify(m).length / 4);

// (a) pool pressure
const rows = [];
for (const f of readdirSync(BH).filter((x) => x.endsWith("-pending.json"))) {
  const raw = parse(readFileSync(join(BH, f), "utf8")); if (!raw) continue;
  const obs = raw.observations ?? [], refs = raw.reflections ?? [];
  const tk = (a) => a.reduce((s, x) => s + Math.ceil(String(x?.text ?? "").length / 4), 0);
  rows.push({ obs: obs.length, refs: refs.length, obsTok: tk(obs), refTok: tk(refs) });
}
console.log("ledgers", rows.length, "withObs", rows.filter(r => r.obs).length, "withRefs", rows.filter(r => r.refs).length,
  "maxObsTok", Math.max(0, ...rows.map(r => r.obsTok)), "maxRefTok", Math.max(0, ...rows.map(r => r.refTok)),
  "overPressureGate31500", rows.filter(r => r.obsTok > 31500).length);

// (b) worker-message share of context, and ANSI presence
function walk(dir, out = []) { let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; } for (const e of es) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".jsonl")) out.push(p); } return out; }
const recent = walk(join(AGENT, "sessions")).map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 8);
for (const { f } of recent) {
  let bh = 0, total = 0, n = 0, ansi = 0;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = parse(line); if (!e) continue;
    if (e.type === "custom_message") { total += est(e.content); if (String(e.customType).startsWith("blackhole:")) { bh += est(e.content); n++; if (line.includes("\\u001b[")) ansi++; } }
    else if (e.type === "message" && e.message) total += est(e.message);
    else if (e.type === "compaction") total += est(e.summary);
  }
  console.log(f.split(/[\\/]/).pop().slice(0, 19), { bhMsgs: n, bhTok: bh, totalTok: total, pct: total ? +(100 * bh / total).toFixed(1) : 0, ansiEscaped: ansi });
}
```

**Observed (2026-10-14):** 309 ledgers · 90 with observations · 40 with reflections ·
max observation pool 5,864 tokens · **max reflection pool 12,135 tokens (125 reflections)** ·
**0 of 309** above the 31,500-token pressure gate (dropper dormant).
Worker messages: 6–47 per session, 160–10,446 tokens, 0.3–0.9% of raw context, **all** containing
literal `\u001b[` escapes.

---

## P4 — Config usage matrix

Compares `BlackholeConfig` (interface), `DEFAULT_CONFIG`, the effective file, the project-level
file, and every `config.<key>` read in the logic files.

```js
import { readFileSync } from "node:fs";
const BH = "C:/Users/Ivan/.pi/agent/extensions/blackhole";
const cfg = readFileSync(`${BH}/config.ts`, "utf8");
const file = JSON.parse(readFileSync("C:/Users/Ivan/.pi/agent/pi-blackhole/pi-blackhole-config.json", "utf8"));
const iface = cfg.slice(cfg.indexOf("export interface BlackholeConfig"), cfg.indexOf("export const DEFAULT_CONFIG"));
const ifaceKeys = [...iface.matchAll(/^\s{4}([a-zA-Z]+)\??:/gm)].map((m) => m[1]);
const logic = ["index.ts", "om.ts", "compaction.ts"].map((f) => readFileSync(`${BH}/${f}`, "utf8"));
const read = (k) => logic.some((s) => new RegExp(`config\\.${k}\\b`).test(s));
const configTs = /config\.(compactAfterTokens|compactAfterRatio|compactReserveTokens)\b/.test(cfg);
console.log("effectiveFileKeys", Object.keys(file).length);
console.log("read in logic  ", Object.keys(file).filter(read));
console.log("inert          ", Object.keys(file).filter((k) => !read(k) && !["compactAfterTokens", "compactAfterRatio", "compactReserveTokens"].includes(k)));
console.log("file-only keys ", Object.keys(file).filter((k) => !ifaceKeys.includes(k)));
```

**Observed (2026-10-14):** 33 effective keys · **13 read** · **20 inert** — of which 10 are declared
in the type but never read (`debug`, `compactionEngine`, `compactAfterPreset`,
`reflectorInputMaxTokens`, `dropperInputMaxTokens`, `agentMaxTurns`, `observerFallbackModels`,
`reflectorFallbackModels`, `dropperFallbackModels`, `dropperModel`, `cooldownHours`) and 10 are not
in the type at all (`compactionSummaryMode`, `debugLog`, `dropperPoolFullnessThreshold`,
`fullFoldAlways`, `midRunCompaction`, `observerPreambleMaxTokens`, `retainedToolOutputMaxTokens`,
`sessionFallback`, `skipForProviders`, `tailBehavior`).

Note: `compactAfterTokens` / `compactAfterRatio` / `compactReserveTokens` are read *inside*
`config.ts` by `getAutoCompactThreshold`, not via `config.` in `index.ts` — the probe's third line
accounts for that.

---

## P5 — Compaction-entry metadata by era (`details` / `usage`)

Uncovered the legacy→native regression on the metadata channel (see H2).

```js
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
function walk(dir, out = []) { let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; } for (const e of es) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".jsonl")) out.push(p); } return out; }
const seen = new Set(), rows = [];
for (const f of walk("C:/Users/Ivan/.pi/agent/sessions")) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.includes('"type":"compaction"')) continue;
    const e = parse(line); if (e?.type !== "compaction") continue;
    const s = String(e.summary ?? "");
    const key = `${e.timestamp}|${s.length}|${s.slice(0, 40)}`;
    if (seen.has(key)) continue; seen.add(key);
    rows.push({
      era: s.startsWith("### Files Touched") ? "current-vcc" : s.startsWith("[Session Goal]") ? "legacy-vcc" : "pi-default",
      hook: e.fromHook === true, details: e.details !== undefined, usage: e.usage !== undefined,
      detailKeys: e.details ? Object.keys(e.details).join(",") : "",
    });
  }
}
for (const era of ["current-vcc", "legacy-vcc", "pi-default"]) {
  const g = rows.filter((r) => r.era === era);
  console.log(era, { n: g.length, hook: g.filter(r => r.hook).length, withDetails: g.filter(r => r.details).length,
    withUsage: g.filter(r => r.usage).length, detailKeySets: [...new Set(g.filter(r => r.details).map(r => r.detailKeys))] });
}
```

**Observed (2026-10-14):** `current-vcc` 31 entries, 31 hook, **0 details** · `legacy-vcc` 130
entries, 130 hook, **130 details** with keys
`compactor, version, sections, sourceMessageCount, previousSummaryUsed, om.folded`
(+ `retainedToolOutputProjection`) · `pi-default` 3 entries, `readFiles, modifiedFiles` + usage.

---

## Cross-checks performed against the host (not scripted)

| Check | Command / file | Result |
|---|---|---|
| Hook result applied verbatim | `dist/core/agent-session.js:2223-2267`, `:2513-2556` | `summary/firstKeptEntryId/tokensBefore/usage/details` used as-is, `fromExtension = true` |
| Custom messages enter context | `dist/core/messages.js` `convertToLlm` `case "custom"` | mapped to `role: "user"`, content unchanged (no ANSI strip) |
| Only bashExecution can opt out | `dist/core/messages.js` + `docs/message-types.md` | `if (m.excludeFromContext) return undefined` only for `bashExecution` |
| Official non-context persistence | `dist/core/extensions/types.d.ts:1253-1254`, `:1272` | `registerEntryRenderer` doc: "Custom entries do not participate in LLM context"; `appendEntry` |
| Context token semantics | `dist/core/compaction/compaction.js:65-67` | `usage.totalTokens \|\| input + output + cacheRead + cacheWrite` |
| Retained budgets | same file, `DEFAULT_COMPACTION_SETTINGS` | `reserveTokens: 16384`, `keepRecentTokens: 20000`, `enabled: true`; `agent/settings.json` sets no overrides |
| Split-turn preparation shape | `dist/core/compaction/compaction.d.ts:122-126` + `docs/compaction.md` | `turnPrefixMessages`, `isSplitTurn`; `messagesToSummarize` is empty for split spans |
| API presence in 1.2.0 | `dist/core/extensions/types.d.ts` | `agent_settled` `:801-805`, `ContextUsage` `:197-203`, `CompactOptions` `:204-208`, `isIdle` `:236`, `getContextUsage` `:248`, `compact` `:~250`, `SessionBeforeCompactResult` `:1137-1140` |
| Session header id ↔ ledger name | 283 real `*.jsonl` first lines vs 309 ledger names | `{ "type": "session", "id": "<uuid>" }` matches `<uuid>-pending.json` — cleanup is safe |
