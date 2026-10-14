# 01 — Compaction Engine (VCC)

Scope: `agent/extensions/blackhole/compaction.ts` + the `session_before_compact` hook and the
deferred trigger in `agent/extensions/blackhole/index.ts`.

## Mechanism as implemented

```
agent_settled (index.ts:52)
  → threshold gate: getAutoCompactThreshold(config, ctx.model.contextWindow)   (config.ts:78-92)
  → token gate: ctx.getContextUsage()?.tokens ?? rawTokensSinceLastCompaction(branch)
  → deferred IIFE: wait for ctx.isIdle(), re-check threshold, then ctx.compact() (index.ts:92-156)

session_before_compact (index.ts:163)
  → omSummary = buildOmCompactionSummary(sessionId)                            (index.ts:170)
  → messages  = event.preparation.messagesToSummarize                          (index.ts:171-176)
  → summary   = compileVccSummary({ messages, previousSummary, cwd, omSummary }) (index.ts:178)
  → return { compaction: { summary, firstKeptEntryId, tokensBefore } } if non-empty (index.ts:183-190)
```

`compileVccSummary` (`compaction.ts:56-82`) emits at most four sections, joined by `---`:

| Section | Source | Bound |
|---|---|---|
| `### Files Touched` | `collectTouchedFiles(messages)` — `toolCall` args `path \| file \| filePath` (`compaction.ts:31-54`) | none; re-emitted cumulatively every compaction |
| `### Recent Commits` | `git log -n 5 --oneline` via `execSync` (`compaction.ts:12-28`, called at `:66`) | 5 lines |
| `### Active Context & Insights` | `buildOmCompactionSummary` = **all** observations + **all** reflections (`om.ts:74-90`) | none |
| `### Previous Context` | `input.previousSummary` **verbatim** (`compaction.ts:77-79`) | none |

There is **no size budget, no dedupe, and no truncation anywhere in this path.**

---

## H1 — Summary ratchet (HIGH)

**Claim.** Each compaction stores the previous summary verbatim inside the new one, while also
re-emitting the cumulative file list, a fresh `git log`, and the full OM pool. Within a session
chain the compaction payload therefore grows monotonically, is never trimmed, and at its worst
exceeds pi's retained-context budget.

**Evidence — code.** `compaction.ts:77-79`:

```ts
if (input.previousSummary?.trim()) {
    sections.push(`### Previous Context\n${input.previousSummary.trim()}`);
}
```

**Evidence — measured (current-vcc era only).**

- Single-session chain, nesting increments exactly 1 per compaction:

  | nesting | chars | ≈ tokens |
  |---|---|---|
  | 1 | 8,449 | 2,113 |
  | 2 | 16,524 | 4,131 |
  | 3 | 21,507 | 5,377 |
  | 4 | 40,119 | 10,030 |

- Current-era maxima: **123,219 chars ≈ 30,805 tokens** (nesting 4, 2026-10-08) and
  **87,949 chars ≈ 21,988 tokens** (nesting 5, 2026-10-13). Median for the era: 21,507 chars.
- pi's retained budget is `keepRecentTokens: 20000` and `reserveTokens: 16384`
  (`dist/core/compaction/compaction.js`, `DEFAULT_COMPACTION_SETTINGS`; `agent/settings.json`
  sets no compaction overrides). The worst observed summary is **154% of the retained budget** —
  i.e. after compaction the model can spend more context on duplicated history than on the
  messages pi deliberately kept.
- File-list growth drives part of it: bullet (`- `) counts measured across consecutive summaries
  in one chain: 124 → 186 → 312 → 401 → 496, and 43 → 74 → 162 → 267 in another.
- Legacy-era corroboration (`[Session Goal]` engine, not current code, but same failure mode):
  a 29-compaction chain grew 57,049 → 67,088 → … → 111,737 chars, with **26 of 28** successive
  summaries containing the previous summary's first 400 chars verbatim, across 33 sessions.

**Impact.** A permanent context floor that rises with every compaction; duplicated tokens paid on
every subsequent request; the summarization artifact is itself re-summarized indefinitely. No
code path ever shrinks it (nesting depth is unbounded until the session ends).

**Fix direction (not implemented).**
1. Drop the verbatim `### Previous Context` block, or replace it with a bounded digest
   (e.g. only the `### Active Context & Insights` + commit sections of the predecessor).
2. Impose a hard cap on the compiled summary (chars or estimated tokens) and truncate the file
   list / OM pool to fit — the same budget pi applies to kept messages.
3. Consider deduplicating `### Files Touched` against the predecessor's file list.

---

## H2 — No semantic fallback: the hook always replaces pi's summarizer (HIGH)

**Claim.** Any non-empty deterministic summary suppresses pi's built-in LLM summarization, so in
the (rare but real) case where OM is empty, the summarized span — routinely ~254k tokens — is
replaced by a file list plus a truncated git log.

**Evidence — contract.** `agent-session.js:2223-2267` (manual) and `2513-2556` (threshold): if a
handlers' result contains `compaction`, it is used **instead of** `_runDefaultCompaction`;
`fromExtension = true`. Confirmed empirically: **161 of 164** compaction entries are
`fromHook: true`; the 3 exceptions are pi-default summaries.
The guard in the hook is only `if (summary && summary.trim().length > 0)` (`index.ts:183`) — it
does not require that OM contributed anything.

**Evidence — OM presence by era** (see `README.md` for the era split): current-vcc 30/31 (97%)
carry OM; the single exception is the 2026-10-07 entry — 111,737 chars, `### Files Touched`
present, `### Recent Commits` **absent** (non-git cwd), no OM, nesting 1. That entry replaced a
full summarized span with a file list and a predecessor's summary.

**Impact.** Memory quality is gated entirely on OM quality, with no safety net and no diagnostic.
Failure modes that produce an OM-less summary: worker model unavailable/misconfigured, a session
shorter than `observeAfterTokens`, ledger corruption (see M4), a new session whose first
compaction precedes any observation, or a non-git cwd.

**Related finding — the `details` metadata channel was dropped in the native rewrite.**

| Era | entries | hook-provided | with `details` | with `usage` |
|---|---|---|---|---|
| current-vcc | 31 | 31 | **0** | 0 |
| legacy-vcc | 130 | 130 | **130** | 0 |
| pi-default | 3 | 0 | 3 | 3 |

- pi's default path records `CompactionDetails` (`readFiles`, `modifiedFiles`,
  `agent-session.js:3323-3324`) as documented in `docs/compaction.md` — the current hook records
  nothing.
- The **legacy** engine's `details` keys were
  `compactor, version, sections, sourceMessageCount, previousSummaryUsed, om.folded`
  (later variants add `retainedToolOutputProjection`). So the native port lost two capabilities the
  previous implementation had: a self-describing provenance record, and `om.folded` — the signal
  that says whether OM actually contributed to a summary. Without it, H2's failure mode (an OM-less
  summary) is undetectable after the fact.
- Because blackhole keeps its file list inside the summary text instead of in `details`, it must be
  re-emitted in full every compaction — one of the direct drivers of H1.

**Corollary:** the 10 undeclared config keys in the effective file (`retainedToolOutputMaxTokens`,
`fullFoldAlways`, `midRunCompaction`, `observerPreambleMaxTokens`, `dropperPoolFullnessThreshold`,
`compactionSummaryMode`, `tailBehavior`, `skipForProviders`, `sessionFallback`, `debugLog`)
correspond one-for-one to legacy-engine features that were not ported — they are not random
leftovers, they are unimplemented features still advertised by the config (see M1).

**Fix direction (not implemented).**
1. `if (!omSummary?.trim()) return;` — fall through to pi's default LLM summarizer instead of
   shipping a files-only summary.
2. Optionally return `details: { readFiles, modifiedFiles }` so pi's documented file tracking
   stays intact, and let the summary carry only the semantic payload.

---

## M3 — Split-turn compactions silently lose file tracking (MEDIUM)

**Evidence.** `CompactionPreparation` exposes `messagesToSummarize` (`compaction.d.ts:122`),
`turnPrefixMessages` (`:124`), `isSplitTurn` (`:126`). `docs/compaction.md` documents that when a
single user-message span exceeds `keepRecentTokens`, the cut lands mid-span and
**`messagesToSummarize = []`**, with the prefix living in `turnPrefixMessages`.
The hook reads only `messagesToSummarize` (`index.ts:171-176`), so `collectTouchedFiles` returns
nothing for split spans and `### Files Touched` is omitted — with no warning.

**Impact.** Long single-instruction sessions (large refactors, long audits) lose file tracking at
exactly the moment it matters most. OM/commits/previous-summary still survive, so the loss is
silent.

**Fix direction.** `collectTouchedFiles([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages], ctx.cwd)`.

---

## L1 — `compactInFlight` can stay latched for the rest of a run (LOW)

`compactInFlight = true` is set at `index.ts:80`; the deferred IIFE returns early without
resetting it at four gates (signal aborted, session id changed, branch empty or already ending
with a compaction, re-checked tokens below threshold). Only the `ctx.compact()` callbacks
(`index.ts:139-142`) and the `catch` (`index.ts:155-156`) reset it, and
`autoCompactionController` is nulled only at `index.ts:135`.

Recovery exists: `pi.on("agent_start")` → `abortInFlightCompaction()` (`index.ts:48`, `:38-46`)
clears both at the start of the next run, which is why this is LOW. Residual effect: after a
bailed-out deferred compaction, proactive compaction is disabled for the remainder of that run.

## L5 — Blocking git call on the compaction path (LOW)

`extractGitCommits` (`compaction.ts:12-28`) uses `execSync` (synchronous, blocking) and falls back
to `process.cwd()` when no cwd is supplied (`compaction.ts:66`). In a non-git working directory the
section simply disappears (observed: the 2026-10-07 OM-less entry has `files: true`,
`commits: false`).

## Verified-sound pieces (do not "fix")

- **Hook return shape is correct.** `Summary + firstKeptEntryId + tokensBefore` matches
  `CompactionResult` (`compaction.d.ts:18-26`) and `SessionBeforeCompactResult`
  (`types.d.ts:1137-1140`); omitting `usage` is valid because the summary is deterministic
  (no LLM call, no usage to attribute) — verified: 0/31 current-era entries carry usage.
- **Token accounting is correct.** `getUsageTokens` (`compaction.ts:90-106`) delegates to
  `calculateContextTokens`, whose semantics were verified as
  `usage.totalTokens || input + output + cacheRead + cacheWrite` (`compaction.js:65-67`) — cache
  tokens included, and it rejects `stopReason: "error" | "aborted"`. The
  `rawTokensSinceLastCompaction` fallback (`compaction.ts:108-150`) is a sound approximation used
  only when `getContextUsage()` returns `tokens: null` (a documented post-compaction state).
- **Trigger is empirically correct.** Observed `tokensBefore` 254,847 / 266,594 / 269,568 /
  310,144 against `compactAfterTokens: 254000` with 300k-window models; pi's own threshold for
  that window is 283,616, so blackhole intentionally compacts first.
- **Race guards.** The deferred IIFE re-checks `signal.aborted`, the session id, and the branch
  tail before calling `ctx.compact()` — no phantom compaction after an abort or a session switch.
