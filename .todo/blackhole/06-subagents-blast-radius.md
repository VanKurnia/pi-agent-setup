# 06 — Blast Radius: `subagents/` ↔ `blackhole/`

Answer to: *"have you made sure any VCC change in `blackhole/` won't break `subagents/`, which uses it?"*

**No — that check was missing from the audit, and none of options A–D accounted for it.** This file
closes that gap. The coupling turns out to be **bidirectional, type-pinned, test-pinned and
documented**, so it belongs inside any implementation plan rather than after it.

## 1. The coupling is real and deliberate

`agent/extensions/subagents/src/run.ts:35-50` — a hard, lazy import of blackhole internals:

```ts
// Blackhole's summary modules are needed only when a subagent is dispatched.
compileVccSummary: typeof import("../../blackhole/compaction.js").compileVccSummary;
buildOmCompactionSummary: typeof import("../../blackhole/om.js").buildOmCompactionSummary;
...
import("../../blackhole/compaction.js"),
import("../../blackhole/om.js"),
```

`run.ts:53-83` — the **delegation snapshot**: every subagent dispatch freezes the parent's VCC and
appends it to the child's task.

| Seam | Direction | Mechanism | Degradation |
|---|---|---|---|
| **S1 Delegation snapshot** | `subagents` → `blackhole` | `loadSnapshotModules()` lazy `import()` of `compileVccSummary` + `buildOmCompactionSummary`; wrapped in `try { … } catch { return "" }` | silent — child loses the snapshot, task still runs (`subagents/README.md:119`) |
| **S2 Parent-link registry** | `blackhole` → `subagents` | `blackhole/index.ts:9,289`: `getExtensionApi<SubagentsApi>("subagents")` for `registerChildSession` / `unregisterChildSession` / `resolveParentLink`, used by `recall` `source:"parent"` | graceful — *"No parent session linked"* |
| **S3 Tool allowlists + skill text** | prompts → `recall` | `subagents/agents/scout.md:4`, `agents/worker.md:4` list `recall`; `skills/orchestrator/SKILL.md:93` tells the parent that children get a read-only VCC snapshot and can drill with `recall source=parent` | none — text just goes stale |

Exhaustive consumer list (agent + `.script` + skills/prompts, excluding `blackhole/` itself,
`node_modules`, `cache/`): `subagents/src/run.ts` (S1), `subagents/README.md:119`,
`blackhole/index.ts` (S2 consumer), `.script/test/subagent/{snapshot,recall}.test.mjs`,
`skills/orchestrator/SKILL.md:93`. **There is no third consumer** — no other extension imports or
reaches blackhole.

## 2. What is pinned today

`npm test` → `.script/test/run-all.mjs` globs every `*.test.mjs`, so both seam tests run.

| Pinned by | Contract |
|---|---|
| `run.ts:39-40` (`typeof import(...)`) | **Export names** `compileVccSummary`, `buildOmCompactionSummary` — renaming them fails `npm run typecheck`, not just runtime |
| `run.ts:72-76` | **Call signatures**: `compileVccSummary({ messages, cwd, omSummary })` → `string`; `buildOmCompactionSummary(sessionId)` → `string` |
| `snapshot.test.mjs` | `createDelegationSnapshot` / `attachDelegationSnapshot` / `applyDelegationSnapshot` exist and behave; `SNAPSHOT_MAX_CHARS`, `SNAPSHOT_MARKER` unchanged |
| `recall.test.mjs` | `recall.parameters` still exposes `source`/`parent`; `source:"parent"` keyword search; `#N` expand (must show `blackhole/om.ts`); `#N:text` drill-down; `mode:"touched"` lists parent files; `scope:"all"` reads via `getEntries`; unmapped → message containing `No parent session linked`; output capped 4096 chars ending `... (truncated)`; child→parent links survive `moduleCache:false` via `globalThis` |

**Two blind spots** — the pins do **not** cover content semantics:

1. `snapshot.test.mjs` drives the seam with `sessionId: "test-no-such-session"` and a stubbed
   `gitOk`, so the OM branch returns `""` and the commit branch is stubbed. A change to summary
   *content* passes the test suite untouched.
2. No test asserts that the blackhole summary is non-empty for a real session, or that a child's
   snapshot matches the parent's compaction summary.

## 3. Per-fix hazard matrix

| Finding / fix | Touches S1? | Verdict |
|---|---|---|
| **H1** cap + drop the verbatim `### Previous Context` blob | accidentally beneficial | `run.ts:63-66` already caps the child snapshot at `SNAPSHOT_MAX_CHARS = 6000` chars with a `... (snapshot truncated)` suffix and neutralizes `{previous}` → `{ previous }`. The 123k-char / 30.8k-token worst case **never reaches children**; it only pollutes the parent's own context. Capping blackhole makes the child snapshot informative *earlier* (currently the 6k prefix is spent on files/commits/OM, ordered by section, so the cap can cut before OM) |
| **H2** semantic sections (`sessionGoal`, `outstandingContext`, `briefTranscript`) | yes, positive | Child snapshots get meaning instead of file lists. Requires **no** subagents change; ordering matters for the 6k prefix — keep short/high-value sections first |
| **H3** `sendMessage` → `appendEntry` + `registerEntryRenderer` | no | Children are fresh one-shot sessions; they receive only the snapshot *string*, never entries. Only the parent UI/SessionManager changes. `blackhole/index.ts:483-486` currently registers `registerMessageRenderer` for `blackhole:*`; those must be replaced consistently or you get unrendered entries |
| **M1** delete/implement inert keys | no | Nothing imports `BlackholeConfig` outside `blackhole/`. Keep the exported type's name |
| **M2** `reflectionsPoolMaxTokens` + preamble cap | yes, positive | Smaller, bounded OM text feeds `omSummary` into the snapshot |
| **M4** durable ledger (session entries instead of `pending.json` only) | **YES — breaking** | `buildOmCompactionSummary(sessionId)` reads **only a file** (`om.ts:44-91`) and has no session handle. A real ledger fix cannot be reached from a `sessionId` string. Either (a) change the signature and update `run.ts:75` + `snapshot.test.mjs` in the same change, or (b) keep a file-backed mirror so the existing signature still returns OM — a decision that must be explicit, not discovered |
| **M5** worker isolation / cooldown / timeout | no | Worker dispatch is internal to `om.ts` |
| **M6** recall honesty: literal→real regex, working `mode:"file"` | no | **If** the tool name, its parameter names (`query`, `mode`, `scope`, `source`, `expand`, …) and the `No matches` / 4096-char + `... (truncated)` behaviour stay intact. `mode:"file"` and regex are **not** pinned by any test — they can be implemented without touching subagents. Removing `recall` from `scout.md`/`worker.md` would be a prompt-level change (would need the same sweep) |

**Option-specific:**

| Option | Subagents cost |
|---|---|
| **A — adopt upstream npm package** | **Highest.** `../../blackhole/compaction.js` and `../../blackhole/om.js` cease to exist → `npm run typecheck` fails on `run.ts:39-40`, and at runtime `loadSnapshotModules()` throws into the `catch` → every child silently gets an empty snapshot. Requires either a thin re-export shim at those two paths, or rewriting S1 to `getExtensionApi("blackhole")` (the pattern `.todo/native-pi-ocr/BLAST-RADIUS.md` already prescribes) + updating `snapshot.test.mjs` |
| **B / C — fix the local port in place** | **Low.** Exports and signatures stay; only content changes. One exception: M4 (above) |
| **D — trim keys, fix recall text** | **Lowest.** Neither blackhole's exports nor recall's parameter names change |

## 4. Required additions to any plan (do not skip)

1. **Compatibility gate**: `npm run typecheck && npm test` must pass *including* `.script/test/subagent/snapshot.test.mjs` and `recall.test.mjs`. Add them as named gates in the plan, not implied by "run tests".
2. **Frozen surfaces** (changing any of these is a subagents change, same commit): exports `compileVccSummary`, `buildOmCompactionSummary`; signatures at `run.ts:72-76`; `recall` tool name + parameter names; `No parent session linked`; 4096-char recall cap + `... (truncated)`.
3. **Close the blind spot**: extend `snapshot.test.mjs` (or add a case) so a session **with** pending memory asserts a non-empty `omSummary` in the snapshot. Today a broken `buildOmCompactionSummary` would pass every test.
4. **M4 decision recorded**: signature change + subagents update, *or* file-backed mirror. Pick before implementing the ledger.
5. **AGENTS.md rule 4 sweep**: `subagents/README.md:119` (describes the lazy import and graceful degradation), `skills/orchestrator/SKILL.md:93` (describes the VCC snapshot and `recall source=parent`), `agents/scout.md:4` / `agents/worker.md:4` (tool allowlists). These are the only docs whose wording depends on blackhole behaviour.
6. **Drop-in ordering rule**: sections in the summary are emitted in order and the child snapshot takes the first 6,000 chars — so any H2 section work must keep high-value content (goal, decisions, outstanding context) ahead of long file lists, or the child snapshot silently pays for it.

## 5. Verification performed

- Exhaustive reference grep over `agent/`, `.script/`, `.pi/` (excluding `node_modules`, `cache/`, `dist/`, `blackhole/`, session data) → consumer list in §1 is complete.
- Read: `subagents/src/run.ts:35-83`, `subagents/README.md:119`, `blackhole/index.ts:9,289`, `blackhole/om.ts:44-91,459-495`, `blackhole/compaction.ts:5-108`, `blackhole/config.ts:13-85`.
- Read both seam tests end-to-end (`snapshot.test.mjs`, `recall.test.mjs`) and the runner `.script/test/run-all.mjs`.
- No files changed; no git operations.
