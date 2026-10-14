# 05 — Upstream Comparison & Verdict

Comparison of our local `agent/extensions/blackhole/` (4 files, 51 KB, 1,297 lines) against its
reference implementation and the two projects that reference merges.

| Reference | Role |
|---|---|
| [k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole) | **Our upstream** — the published npm + git package we ran before plan 025, and the source of our config schema |
| [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) | The deterministic compaction half (section model), merged by upstream |
| [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) | The memory half (session ledger, fold/tombstones), merged by upstream |

Method: downloaded the upstream source over HTTPS (no git operations, per `AGENTS.md`) at
`HEAD = 1907ede0` — 143 `src` files / 1,668 KB, plus `index.ts`, `example-config.json`,
`package.json` — then compared mechanism-by-mechanism. Our repo's legacy-era compaction entries
(`details` keys `compactor, version, sections, sourceMessageCount, previousSummaryUsed, om.folded`,
130 of them) match upstream's `PiVccCompactionDetailsV1` exactly (`src/details.ts:11-18`), which
confirms our repo previously ran genuine upstream and that the current native extension is a
from-scratch minimal reimplementation of it (plans 022–027).

## Scale and provenance

| | Upstream | Local port |
|---|---|---|
| Source files | 143 (~150 with tests) | **4** |
| Source size | 1,668 KB | **51 KB** |
| Lines | ~40,000+ (largest single file `om/consolidation.ts` = 136 KB) | **1,297** |
| Tests | ~150 vitest files incl. `tests/auto-compact-permutations.test.ts`, `tests/multi-cycle-compaction.test.ts`, `tests/example-config-completeness.test.ts`, `tests/config-exhaustive.test.ts` | none (repo-level `npm test` covers subagents only) |
| Docs | `docs/{vcc-compaction,observational-memory,CONFIG,APPEND_COMPACTION,mid-run-compaction,recall,architecture}.md`, 131 KB `CHANGELOG.md`, 43 KB `llms.txt` | none |
| Upstream tracking | `.pi/skills/lockstep/` — a skill that mechanically diffs both ancestors (`scripts/upstream-diff.js`, `lockstep-mapping.json`, `.upstream-om-head`, `.upstream-vcc-head`) | — |
| Config surface | `example-config.json` **50 keys** + interactive `/blackhole settings` overlay | 27 typed keys, 33-key file, no validation |
| Budget modules | `prompt-budget`, `model-budget`, `recall-budget`, `tool-output-budget` | **none** |

The local port is ≈3.5% of upstream's size. That is not automatically wrong — the repo's own
`AGENTS.md` mandates single-file/<5-file extensions — but it defines what the port could and could
not preserve.

## Lineage map

| Subsystem | Upstream module | Local equivalent | Status |
|---|---|---|---|
| Deterministic summary | `src/core/build-sections.ts`, `src/sections.ts`, `src/extract/*` | `compaction.ts:56-82` | **2 of 6 sections kept** |
| Summary merge across compactions | `src/core/summarize.ts` (`mergeHeaderSection`, `mergeFileLines`) | — | **dropped** |
| Compaction chain / segments | `src/core/compaction-chain.ts`, `src/details.ts` (V1 + V2 segments) | — | **dropped** |
| Hook + trigger | `src/hooks/before-compact.ts` (34 KB), `src/om/compaction-trigger.ts` (25 KB) | `index.ts:52-190` | simplified |
| OM workers | `src/om/agents/{observer,reflector,dropper}/*`, `src/om/consolidation.ts` (136 KB) | `om.ts:237-457` | **shape only** |
| OM ledger (durable) | `src/om/ledger/{index,fold,projection,recall,render-summary,progress,types}.ts` | — | **dropped** (pending file only) |
| OM work buffer | `src/om/pending.ts` | `om.ts:36-72` | **backup + empty-delete dropped** |
| Cooldown / fallback chains | `src/om/cooldown.ts`, `src/om/worker-attempt.ts`, `src/om/retryable-error.ts` | — | **dropped (keys still read from config? no — inert)** |
| Budgets | 4 budget modules + `src/om/turn-cap.ts` | — | **dropped** |
| Recall tool | `src/tools/recall.ts` (21 KB) + `src/core/search-entries.ts` (BM25 + regex) | `index.ts:222-512` | **description copied, engine replaced** |
| Worker display | `src/om/status-bar.ts` + `src/hooks/cosmetic-output.ts` | `om.ts:193-235` | **inverted (see H3)** |
| Config | `src/core/unified-config.ts`, `src/pi-base/config.ts`, settings overlay | `config.ts` | **schema copied, features not** |

Upstream's own README is candid about the design contract: *"a deterministic, zero-cost `compile()`
pipeline extracts structured sections (**goal, files, commits, preferences, brief transcript**)"*
and *"Per-worker model fallback chains with persisted cooldowns."*

## The summary contract: upstream vs local

`src/sections.ts` — annotated *"Upstream: sting8k/pi-vcc (src/sections.ts) — Unmodified."*

```ts
export interface SectionData {
  sessionGoal: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  commits: string[];
  userPreferences: string[];
  briefTranscript: string;
}
```

| Section | Upstream | Local port | Consequence |
|---|---|---|---|
| Session Goal | ✅ capped 8 lines, first-N keep | ❌ | *why* the session exists is lost on compaction |
| Outstanding Context | ✅ always fresh | ❌ | open threads/todos lost |
| Files And Changes | ✅ merged by category, path-deduped, git tags stripped | ⚠️ flat list, never deduped, re-emitted whole | drives H1 growth |
| Commits | ✅ capped 8 | ✅ (5, via `git log`) | parity |
| User Preferences | ✅ capped 15, deduped | ❌ | durable preferences lost |
| Brief Transcript | ✅ capped (`capBrief`, `src/core/format.ts`) | ❌ | **the conversation itself is dropped** |
| OM observations/reflections | ✅ folded, capped (`reflectionsPoolMaxTokens` 8k / `observationsPoolMaxTokens` 20k, newest-first) | ⚠️ dumped entire, uncapped | H1 + M2 |
| Previous summary | ✅ per-header merge, line dedup, caps 8/8/15, `Outstanding Context` fresh-only | ❌ **verbatim blob** | **H1 ratchet** |

## Finding-by-finding re-verdict

Legend: **PORT DEFECT** = upstream already solved it, our port lost the guarantee · **SHARED** =
upstream has the same weakness (mitigated or not) · **LOCAL ONLY** = introduced by our port.

| Finding | Upstream state | Verdict |
|---|---|---|
| **H1** summary ratchet, verbatim re-embed, 30.8k-token worst case | `mergeHeaderSection` dedupes lines + caps (Session Goal 8, Commits 8, else 15); `mergeFileLines` dedupes paths by category; `compaction-chain.ts` + `details.ts` V2 store immutable append **segments** with `coverage {firstCoveredEntryId,lastCoveredEntryId,firstKeptEntryId}` instead of a growing blob | **PORT DEFECT** — the entire merge/cap layer was replaced by `### Previous Context\n{previousSummary}` (`compaction.ts:77-79`) |
| **H2** no semantic fallback / narrative loss | 6 sections incl. `sessionGoal`, `outstandingContext`, `userPreferences`, `briefTranscript` are emitted *regardless of OM state*; OM is an additional fold, not the sole semantic carrier | **PORT DEFECT — largest regression.** The port kept the two mechanical sections (files, commits) and dropped all four semantic ones, then made OM the only meaning channel |
| **H3** worker notices in LLM context w/ raw ANSI | OM + display data go through `pi.appendEntry` (`OM_OBSERVATIONS_RECORDED`, `OM_REFLECTIONS_RECORDED`, `OM_OBSERVATIONS_DROPPED`, `OM_OBSERVATIONS_UNANCHORED`, `PRE_COMPACTION_OUTPUT_TYPE`) with `pi.registerEntryRenderer` (`src/hooks/cosmetic-output.ts:179-181`); text passes `stripTerminalSequences` + `truncateToBytes` before storage; `status-bar.ts` carries live status | **PORT DEFECT** — our port swapped the official non-context path for `pi.sendMessage`, which the host converts to user-role text with escapes intact |
| **M1** 20 inert config keys | Every one is live upstream — hit counts in upstream `src`: `debugLog` 106, `compactionEngine` 42, `compactAfterPreset` 38, `midRunCompaction` 37, `cooldownHours` 36, `dropperPoolFullnessThreshold` 26, `tailBehavior` 26, `observerPreambleMaxTokens` 18, `compactionSummaryMode` 18, `retainedToolOutputMaxTokens` 13, `reflectorInputMaxTokens` 13, `dropperInputMaxTokens` 11, `sessionFallback` 14, `skipForProviders` 14, `agentMaxTurns` 15, `fullFoldAlways` 9, `observerFallbackModels` 8. Upstream also has **`reflectionsPoolMaxTokens`**, which our file lacks entirely | **PORT DEFECT** — schema copied, features not implemented; upstream even enforces completeness with `tests/example-config-completeness.test.ts` + `tests/config-exhaustive.test.ts` |
| **M2** reflections unbounded; observer preamble unbounded | `unified-config.ts:201-204`: *"Cap for rendered reflection lines in the compaction output (newest-first keep). **Reflections otherwise accumulate without bound across compactions.**"* → `reflectionsPoolMaxTokens` default 8,000; `observerPreambleMaxTokens` auto-computed at 30% of `observerChunkMaxTokens`; `ledger/fold.ts` dedupes + tombstones dropped items | **PORT DEFECT** — upstream named and fixed exactly this bug; the port kept the bug and dropped the key |
| **M4** silent memory loss (non-atomic write, corrupt read → empty) | Corrupt read still degrades to `defaultState()` (`om/pending.ts`), but: (a) writes preserve the previous state as `<sessionId>-pending.stale.json`, (b) empty state deletes the file, (c) `pending.json` is only a **buffer** — durable memory lives in session entries and is rebuilt via `ledger/fold.ts` with tombstones, explicitly *"safe (idempotent by design)"* | **PORT DEFECT (severity)** — the port made the disposable buffer the only store, so corruption now equals amnesia |
| **M5** worker failure starves pipeline, retries every turn | `worker-attempt.ts` (per-worker attempts), `retryable-error.ts` (`isRetryableError`, `isDeterministicError`, `isCooldownWorthyError`, `isStaleExtensionContextError`), `cooldown.ts` (`recordCooldown`/`expireCooldowns`/`isCooldownActive`), `turn-cap.ts`, `provider-stream.ts`, `workerAttemptTimeoutMs`, `providerIdleTimeoutMs` | **PORT DEFECT** — no isolation, no classification, no cooldown, no timeout, no turn cap |
| **M6** recall advertises regex + file content, implements neither | `search-entries.ts` — real BM25 + regex with per-term intent (`REGEX_TERM_HINT`, `safeRegex` fallback to literal); `tools/recall.ts` implements `mode:file`, `mode:touched`, `scope`, drill-downs; `recall-budget.ts` caps responses | **PORT DEFECT with a false-advertising edge** — our `recall.ts` description/promptGuidelines strings are **verbatim copies** of upstream's (`src/tools/recall.ts:419-432`), while the engine is a ~40-line literal substring scan |
| **M3** split-turn file tracking lost | Upstream also ignores `preparation.turnPrefixMessages` (single hit: `before-compact.ts:636`) but builds its own message set (`core/load-messages.ts`, `tests/vcc-own-cut-robust.test.ts`) | **PORT DEFECT (missing substitute)** — same input, no replacement mechanism locally |
| **L1** `compactInFlight` latch | Upstream has `tests/auto-compact-permutations.test.ts` (24 KB) covering trigger state | **LOCAL ONLY** (low) |
| **L3/L4/L8** cursor scope, token overcount, chunk skip | `core/lineage.ts`, `core/global-indices.ts`, `om/tokens.ts`, `om/agents/observer/agent.ts` (batch/coverage logic, `unanchoredObservations`, cited-prefix checkpoint) | **LOCAL ONLY** (low) |
| **L2** three divergent default sets | `unified-config.ts` is the single source (observe 15,000 / reflect 25,000 / observations pool 20,000 / reflections pool 8,000 / target 10,000), validated | **LOCAL ONLY** |
| **L6** orphan ledger files + stale leftovers | `src/om/cleanup.ts` + `src/commands/cleanup.ts` (11.6 KB) manage pending **and** stale files | **PORT DEFECT (partial)** — our cleanup handles only `-pending.json`, so `.stale.json` leftovers persist |
| **L7** duplicate config file | `core/unified-config.ts` merges global → project → env → session explicitly, with a settings overlay | **LOCAL ONLY** |

## Where upstream itself is weak (the honest counterweight)

Our port is minimal; minimal is not automatically wrong, and upstream is not a gold standard:

- **Upstream calls itself experimental**: *"I merged them and vibeslopped a lot on top… The recap is pattern-matching, not understanding… The memory is model-written… it can keep what sounds right but isn't. Assume both need the search tool as a backstop."*
- **Not a token saver by default**: *"Untuned, on your main coding model, this costs more than doing nothing. It only earns its keep with the workers on something cheap or free."* Our local worker models point at 9router `session-compaction`, which is the cheap-worker setup upstream recommends — the economics are fine, the guarantees are not.
- **Unbounded reflections existed upstream too** — hence the `reflectionsPoolMaxTokens` fix and the explicit doc note. That is a bug class upstream hit *and* solved.
- **Corrupt-state degradation is shared**: upstream's `readSessionState` also returns `defaultState()` on parse failure. It is mitigated (stale backup + idempotent ledger rebuild), not eliminated.
- **Heavy surface**: 143 files, ~40k lines, a lockstep skill to track two ancestor repos, and ~150 test files. Maintaining parity is real work — which is presumably exactly why the native port was written small.

## Verdict on our local implementation

**1. It is not "broken code" — it is a port that kept the shape of a system and dropped its
guarantees.** Every mechanism a reader would look for is present (deterministic compile, three
workers, hook, trigger, recall tool, cleanup, config file), which is why the audit findings are
silent degradations rather than crashes: no exception is thrown, the session simply remembers less.

**2. 11 of 13 findings are port defects, not design disagreements.** For H1 (ratchet), H2
(narrative loss), H3 (context pollution), M1 (inert keys), M2 (unbounded reflections), M4
(ledger-only memory), M5 (no isolation), M6 (recall semantics) upstream already contains the exact
remedy — several of them with the bug named in the source comment. The port's own bugs
(H1's verbatim blob, ANSI into context, literal-only recall with upstream's wording) are all
*substitutions*: 1,297 lines that re-express what ≥30 upstream modules do.

**3. The four decisions that actually matter now:**

| Option | What it means | Cost / risk |
|---|---|---|
| **A. Re-adopt upstream** | `pi install npm:pi-blackhole` (v0.5.13, published, tested), disable the local extension, revert plan 025's purge decision | Reverses a deliberate repo decision; conflicts with `AGENTS.md` rules 2–3 (no duplicated deps, official way) unless treated as "use the reference implementation"; upstream README itself says remove standalone `pi-vcc`/`pi-observational-memory` — they conflict |
| **B. Port the dropped guarantees into the local 4 files** | Bounded scope, honours the <5-file rule: port (1) semantic sections + brief, (2) merge/dedup/cap layer, (3) `reflectionsPoolMaxTokens` + preamble cap, (4) `appendEntry` + entry renderer, (5) stale backup + empty-delete + ledger-from-session, (6) worker isolation + cooldown, (7) recall honesty | Still a fraction of upstream; each item is verifiable against a named upstream module. Realistically doubles the port's size |
| **C. Fix only the HIGH set** | H1 (cap + no verbatim blob), H2 (semantic section + fall through to pi-default when OM empty), H3 (`appendEntry` + `registerEntryRenderer`) | ≈150 lines; leaves M1/M2/M4/M5/M6 as documented debt |
| **D. Keep it minimal and tell the truth** | Correct the `recall` description to literal search; delete the 20 inert keys; treat the extension as "cheap compaction, thin memory" | Cheapest; honest; does not fix the memory-loss paths |

> **Cross-extension caveat (applies to all four options).** `subagents/src/run.ts:35-50` lazy-imports
> blackhole's `compileVccSummary` and `buildOmCompactionSummary` for the delegation snapshot, and
> blackhole reaches back through `getExtensionApi("subagents")` for `recall source:"parent"`. Option A
> breaks that import outright (typecheck failure + silently empty child snapshots); options B/C/D keep
> it, except M4's ledger rework, which needs a joint change. Full analysis, pinned contracts and
> per-fix hazard matrix: `06-subagents-blast-radius.md`.

**4. My recommendation.** Option **C now, then B selectively** — with one exception that should not
be deferred: whatever we do, the *descriptions and config keys must stop promising upstream
behaviour* (M1, M6). A tool whose text says "regex" and "file write/edit content" while scanning
literal substrings is worse than a smaller tool that says what it does, because it manufactures
false negatives in the one place the user goes to recover context.

**5. Constraint conflict to resolve explicitly.** `AGENTS.md` demands extensions stay single-file
or <5 `.ts` files and forbids re-implementing what exists elsewhere. Upstream cannot satisfy that
rule, and the local port cannot satisfy upstream's guarantees at 51 KB. The two goals are
incompatible; the user must pick a side rather than iterate on a port that is structurally
under-budgeted for the job.

## Reproducing this comparison

```powershell
# Snapshot used here (no git; HTTPS only): HEAD = 1907ede09b5f81922a149ff1622a42325b60b87e
$tmp = "$env:TEMP\pi-audit-upstream"
$hdr = @{ "User-Agent" = "pi-audit" }
$tree = Invoke-RestMethod "https://api.github.com/repos/k0valik/pi-blackhole/git/trees/HEAD?recursive=1" -Headers $hdr
$tree.tree | Where-Object { $_.type -eq 'blob' -and $_.path -like 'src/*' } | ForEach-Object {
  $dest = Join-Path $tmp $_.path.Replace('/', '\'); New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  Invoke-WebRequest "https://raw.githubusercontent.com/k0valik/pi-blackhole/main/$($_.path)" -OutFile $dest -Headers $hdr
}
```

Then verify the key claims directly:

| Claim | Upstream evidence |
|---|---|
| 6 semantic sections | `src/sections.ts` (`SectionData`, annotated "Unmodified" from pi-vcc) |
| Previous summary merged with dedup + caps | `src/core/summarize.ts:130-160` (`mergeHeaderSection`, `CAP = 8/8/15`), `mergeFileLines` |
| Immutable segment chain instead of a blob | `src/details.ts` (`PiVccSegment`, `PiVccSegmentCoverage`, `PiVccCompactionDetailsV2`) |
| Non-context worker persistence | `src/hooks/cosmetic-output.ts:179-181, 223`; `src/commands/pi-vcc.ts:195-221` |
| ESC stripped + byte-capped before storage | `src/hooks/cosmetic-output.ts:150-160` (`stripTerminalSequences`, `truncateToBytes`) |
| Reflection cap exists | `src/core/unified-config.ts:200-210` (`reflectionsPoolMaxTokens`, doc note) |
| Defaults | `src/core/unified-config.ts:305-325` (observe 15,000 / reflect 25,000 / obs pool 20,000 / refl pool 8,000 / target 10,000) |
| Cooldown + fallback implementation | `src/om/cooldown.ts`, `src/om/retryable-error.ts`, `src/om/worker-attempt.ts` |
| Real regex/BM25 recall | `src/core/search-entries.ts:61-104`, `src/tools/recall.ts` |
| Inert keys are live features | hit counts listed under M1 |

Snapshot directory: `%TEMP%\pi-audit-upstream\upstream\` (146 files, 1.7 MB) — external to the
repository, and no `.js`/`.mjs` files were added to the repo.
