# 03 — Config Surface & `recall` Tool

Scope: `agent/extensions/blackhole/config.ts`, the config file that is actually read, and the
`recall` tool registered in `agent/extensions/blackhole/index.ts`.

## Which config file is authoritative

`getBlackholeConfigPath()` = `join(getAgentDir(), "pi-blackhole", "pi-blackhole-config.json")`
(`config.ts:63-65`), so the effective file is:

```
agent/pi-blackhole/pi-blackhole-config.json          # 33 keys — THE effective config
.pi/pi-blackhole-config.json                          # 26 keys — never read (L7)
```

`loadBlackholeConfig()` (`config.ts:67-76`) merges the file over `DEFAULT_CONFIG` and silently
returns defaults if the file is unparsable (a corrupted file silently reverts every knob — no
notice).

---

## M1 — 20 of the 33 effective keys do nothing (MEDIUM)

Measured against the code: **13 keys are read; 20 are inert** — 10 are declared in
`BlackholeConfig` but never read outside the declaration, and 10 are not even in the type.

### A. Declared but never read (10 top-level keys, plus 2 fields nested in `ConfiguredModel`)

| Key | Declaration site | Only other occurrence | Configured in your file |
|---|---|---|---|
| `debug` | `config.ts:14` | — | yes |
| `compactionEngine` | `config.ts:17` | `DEFAULT_CONFIG` `:45` | yes (`"blackhole"`) |
| `compactAfterPreset` | `config.ts:21` | — | yes (`"default"`) |
| `reflectorInputMaxTokens` | `config.ts:27` | `DEFAULT_CONFIG` `:51` | yes (120000) |
| `dropperInputMaxTokens` | `config.ts:28` | `DEFAULT_CONFIG` `:52` | yes (120000) |
| `agentMaxTurns` | `config.ts:31` | `DEFAULT_CONFIG` `:55` | yes (16) |
| `observerFallbackModels` | `config.ts:34` | — | yes |
| `reflectorFallbackModels` | declaration only | — | yes |
| `dropperFallbackModels` | declaration only | — | yes |
| `dropperModel` | declaration only | — | yes |
| `cooldownHours` (+ `thinking`) | `config.ts:10` (inside `ConfiguredModel`) | — | yes (12h / 6h) |

### B. Present in the file but not in the type at all (10)

`compactionSummaryMode`, `debugLog`, `dropperPoolFullnessThreshold`, `fullFoldAlways`,
`midRunCompaction`, `observerPreambleMaxTokens`, `retainedToolOutputMaxTokens`, `sessionFallback`,
`skipForProviders`, `tailBehavior`.

### B2. Why they are there — unimplemented legacy features, not typos

The previous engine wrote a self-describing `details` record on every compaction entry
(130/130 entries), with keys:

```
compactor, version, sections, sourceMessageCount, previousSummaryUsed, om.folded
(+ retainedToolOutputProjection in later variants)
```

The current engine writes **no** `details` at all (0/31). `retainedToolOutputProjection` proves
`retainedToolOutputMaxTokens` was a real feature in the predecessor, and `om.folded` proves the
engine used to record whether OM contributed to a summary. The ten keys above map to legacy
features that were **not ported**:

| Inert key | Legacy feature it names |
|---|---|
| `retainedToolOutputMaxTokens` | projection of retained tool output into the summary (`retainedToolOutputProjection` in legacy `details`) |
| `fullFoldAlways` | full-fold OM strategy |
| `midRunCompaction` | mid-run compaction policy |
| `observerPreambleMaxTokens` | observer prompt preamble budget |
| `dropperPoolFullnessThreshold` | second dropper gate (only `dropperPressureThreshold` is implemented) |
| `compactionSummaryMode` | summary mode switch |
| `tailBehavior` | tail handling policy |
| `skipForProviders` | provider exclude list |
| `sessionFallback` | session-level fallback |
| `debugLog` | debug logging |

So M1 is not merely "dead config": the config still advertises a feature set the native port does
not implement. Treat each row as either *implement* or *delete*.

### Consequence

Every resilience and tuning knob you configured beyond model selection is decorative:

- **No model fallback.** `observerFallbackModels` / `reflectorFallbackModels` /
  `dropperFallbackModels` are never consulted, so the `|| ctx.model` session-model fallback at
  `om.ts:380-385` is the only one. A dead 9router model means worker calls fail with no backup (M5).
- **No cooldown.** `cooldownHours` is inert, and `agent/pi-blackhole/pi-blackhole-cooldown.json`
  exists in the data directory but is never read or written by this code.
- **No engine switch.** `compactionEngine: "blackhole"` looks like it selects an engine, but the
  `session_before_compact` hook has no engine branch at all — `"pi-default"` would behave
  identically to `"blackhole"` (and the hook would still override the summary whenever it returns
  one, see H2). Only `compaction: "off"` (skips everything) and `"manual"` (skips the proactive
  trigger but still overrides manual/threshold summaries) have any effect.
- **No input budgeting.** `reflectorInputMaxTokens` / `dropperInputMaxTokens` never bound anything;
  the only effective limits are `observerChunkMaxTokens`, `observationsPool*`,
  `dropperPressureThreshold` and `observeAfterTokens` / `reflectAfterTokens`.
- **`debug` / `debugLog`** produce no logging.

### C. Threshold precedence makes three keys unreachable

`getAutoCompactThreshold` (`config.ts:78-92`) tests in order:

```ts
if (config.compactAfterTokens > 0)      return config.compactAfterTokens;      // :79-80  ← your file sets 254000
if (config.compactAfterRatio …)         return floor(contextWindow * ratio);   // :83-87  unreachable
if (config.compactReserveTokens > 0)    return contextWindow - reserve;         // :88-89  unreachable
… tiered defaults by window size                                                // :90-92  unreachable
```

With `compactAfterTokens: 254000` present, `compactAfterRatio: 0.75`,
`compactReserveTokens` and the tiered preset defaults can never apply. On a 300k-window model the
ratio branch would give 225,000 — the effective trigger is 29k tokens later than the ratio
suggests. Consistent, deliberate-looking, but silent.

*(Verified live: observed `tokensBefore` 254,847 / 266,594 / 269,568 / 310,144 — the trigger
fires, so `compactAfterTokens` is genuinely the active knob.)*

---

## M6 — `recall` does not implement what it advertises (MEDIUM)

Tool registration: `index.ts:222`, description promises *"Search session history and earlier lines
omitted, file write/edit content by text/regex"* (and the third `promptGuidelines` entry repeats
"literal text/regex search").

| Advertised | Implementation | Evidence |
|---|---|---|
| "text/regex" search | Query metacharacters are escaped → **literal-only** matching | `index.ts:471`: `new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")` |
| "file write/edit content" searchable | Search text is built from block `.text` only; `write`/`edit` tool **arguments are never indexed** | `index.ts:474-483` (search loop maps `c.text`), `index.ts:460` filter |
| `mode: "file"` narrows to file activity | Narrows to messages containing a `toolCall` block — which contribute empty text to the search — so matches are only possible from unrelated text blocks in the same message | `index.ts:460-467` |
| `#N:path` locates a file in an entry | Matches `args.path \|\| args.file` but **not** `args.filePath`, unlike `collectTouchedFiles` which uses all three | `index.ts:383` vs `compaction.ts:31-54` |
| `#N` entry index | Two different index spaces: default = post-compaction **projection**, `scope: "all"` = raw `getEntries()` — the same number refers to different messages, and post-compaction entries are unreachable without `scope: "all"` | `index.ts` scope branch (projection vs entries) |

The tool's headline claim — searching *file write/edit content* — has no implementation at all;
what is actually searchable is message text and tool-result text. This is not a crash: the tool
returns confident, complete-looking "no matches" answers for queries that its description says
should match.

**Fix direction.** Either build the real index (collect `toolCall` args `path`/`content`/`oldText`/
`newText` per entry and search them) or correct the description, `promptSnippet` and
`promptGuidelines` to state literal-text-only search over message/tool-result text. Do not ship a
regex claim with an escaping regex.

---

## L2 — Three divergent default sets (LOW)

| Knob | `config.ts` `DEFAULT_CONFIG` (effective) | `om.ts` inline `??` fallback (unreachable) | Your file |
|---|---|---|---|
| `observeAfterTokens` | 25,000 | 20,000 | 25,400 |
| `reflectAfterTokens` | 80,000 | 60,000 | 60,000 |
| `observationsPoolMaxTokens` | 40,000 | 35,000 | 45,000 |
| `observationsPoolTargetTokens` | 20,000 | 18,000 | 22,000 |
| `observerChunkMaxTokens` | 60,000 | 60,000 | 60,000 |

Because `loadBlackholeConfig` merges `DEFAULT_CONFIG`, the `om.ts` fallbacks
(`om.ts:318`, `:319`, `:323`, and the `?? 20000` / `?? 60000` lines in
`runBackgroundConsolidation` / `runReflectorWorker`) can never trigger. Harmless today, but it
means the file contains two contradictory statements of intent — a reader cannot tell which is
authoritative (the answer is `config.ts`).

## L6 — Dead artifacts and manual-only cleanup (LOW)

- `agent/pi-blackhole/` holds **309** `*-pending.json` ledgers against **283** session files;
  only 90 ledgers contain observations. Orphaned ledgers are only removed by the manual
  `/blackhole cleanup` command (`index.ts:198-210` → `cleanupOrphanedPendingFiles`, `om.ts:495`).
- `pi-blackhole-cooldown.json` is dead weight (see M1); `824adf0e-…-pending.stale.json` is a
  leftover from an older write path.
- Cleanup correctness itself is verified sound (`README.md`, "What is not broken").

## L7 — Duplicate config file (LOW)

`.pi/pi-blackhole-config.json` (26 keys, project-level) is never read by the native extension.
It diverges from the effective file — e.g. it says `observeAfterTokens: 15000` while the effective
value is 25,400. Anyone tuning the wrong file gets no effect and no error. Either delete it or add
a pointer comment in the effective file.

## Verified-sound pieces (do not "fix")

- **Keys absent from the file use sane defaults.** `showWorkerMessages` (default `true` — relevant
  to H3, it is the only working mitigation today), `compactReserveTokens` (unreachable anyway, see
  C below), `recallResponseMaxChars` (default 4000).
- **Live keys behave sanely.** `compaction: "off"` short-circuits both the trigger and the hook;
  `memory: false` disables `runBackgroundConsolidation`; `showWorkerMessages` is honored at all
  four notify sites (`index.ts:86`, `om.ts:288`, `:335`, `:428`) — and it is the only available
  mitigation for H3 today.
- **Model resolution** (`config.observerModel || config.model`, provider defaulting to `"9router"`,
  fallback to `ctx.model`) is ordered correctly and works in practice (this session's ledger was
  written by the configured 9router `session-compaction` model).
- **`recall` mechanics that are correct:** 12-char hex observation/reflection lookup, paged
  keyword search (page size 5 with total counts), `expand`, `#N` / `#N:text` / `#N:path`
  drill-downs, `mode: "touched"` aggregation, `source: "parent"` resolution, and `maxChars`
  truncation applied on every output path.
