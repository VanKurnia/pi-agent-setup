# 02 — Observational Memory (workers, ledger, context injection)

Scope: `agent/extensions/blackhole/om.ts` (plus the renderer registration consumed by
`pi-tool-display`/TUI).

## Mechanism as implemented

```
pi.on("turn_end")                                    (om.ts:488)
  → runBackgroundConsolidation(ctx, config, pi)       (om.ts:346, fired per turn, not awaited)
      guard: isConsolidationRunning / config.memory === false  (om.ts:165, :347)
      → OBSERVER   : tokens since lastObservedEntryId ≥ observeAfterTokens → LLM → observations
      → REFLECTOR  : ≥4 observations AND tokens since lastReflectedEntryId ≥ reflectAfterTokens → LLM → reflections
      → DROPPER    : observations pool ≥ poolMax × dropperPressureThreshold → prune oldest
ledger: agent/pi-blackhole/<sessionId>-pending.json   (om.ts:36-72)
```

Config resolution: model = `config.observerModel || config.model`, looked up via
`ctx.modelRegistry.find(provider || "9router", id)` with fallback to `ctx.model` (`om.ts:380-385`
and the reflector equivalent).

---

## H3 — Worker transparency is injected into the LLM context, with raw ANSI escapes (HIGH)

**Claim.** Every worker notification becomes a permanent conversation message. It is not a UI-only
notice: the host converts custom messages to **user-role text** for the model, escape sequences
included, and the content is deliberately duplicated (summary line + details).

**Evidence — code.** `notifyWorkerAction` (`om.ts:215-235`) builds
`text = details ? `${summary}\n${details}` : summary` and calls `pi.sendMessage({ customType:
"blackhole:<worker>", content: [{ type: "text", text }], display: true, details }, { triggerTurn:
false })` (`om.ts:223`).

**Evidence — host contract.**

- `CustomMessage` has **no** `excludeFromContext` field (`docs/message-types.md`, CustomMessage
  interface ≈ L212-224); only `BashExecutionMessage` has it, and it is honoured in
  `convertToLlm` (`dist/core/messages.js`: `case "bashExecution": if (m.excludeFromContext) return undefined`).
- The same `convertToLlm` maps `case "custom"` → `{ role: "user", content }` with the content
  **unchanged** — no ANSI stripping, no filtering. So the escapes are sent to the provider.
- `display: true` only controls TUI rendering; it has no effect on context inclusion.
- Official non-context alternative that exists in 1.2.0 and is unused here:
  `pi.appendEntry(customType, data)` (`types.d.ts:1272`) + `pi.registerEntryRenderer(customType, renderer)`
  (`types.d.ts:1254`), whose own doc comment reads *"Register a custom renderer for CustomEntry.
  Custom entries do not participate in LLM context"* (`types.d.ts:1253`), and
  `docs/extensions.md` lists "Persist non-context session data | `pi.appendEntry()`".
  The existing collapsible `WorkerMessageComponent` + `registerMessageRenderer` wiring
  (`om.ts:193-213`, `:483-486`) would port to an entry renderer directly.

**Evidence — stored data.** Verified in a real session file:

```json
{"type":"custom_message","customType":"blackhole:observer","display":true,
 "content":[{"type":"text","text":"\u001b[90m\u001b[39m **Blackhole Observer** recorded 2 observation(s):\n- [35969e4724ca] …"}]}
```

**Evidence — measured volume** (last 8 sessions by mtime):

| Session | worker msgs | worker tokens | % of raw context | contain `\u001b[` |
|---|---|---|---|---|
| 2026-10-13T06-58-24 | 33 | 7,962 | 0.5% | 33/33 |
| 2026-10-12T06-26-57 | 47 | 10,446 | 0.4% | 47/47 |
| 2026-10-14T01-03-59 | 6 | 1,391 | 0.9% | 6/6 |
| small sessions | 0–1 | 0–317 | ≤0.5% | — |

**Impact.**

1. Raw escape sequences are billed as tokens and consume model attention for zero semantic value.
2. Summary + details duplicate the same information (the TUI only needs one).
3. **Self-inflation loop:** worker messages are counted both by pi's context accounting and by
   blackhole's own `calculateTokensAfter` → they advance `observeAfterTokens` and
   `compactAfterTokens` sooner → more worker activity and more compaction (feeds H1). An audit of
   context bloat that itself pollutes context is the clearest demonstration.

**Fix direction (not implemented).** Move `notifyWorkerAction` to `pi.appendEntry` +
`pi.registerEntryRenderer`; if a worker message must be model-visible, strip ANSI and send the
summary only.

---

## M2 — Reflections are never pruned; the observer prompt grows with the whole pool (MEDIUM)

**Evidence — code.** `runDropperWorker` (`om.ts:306-344`) prunes **only** `state.observations`
(`om.ts:318-330`), while `buildOmCompactionSummary` (`om.ts:74-90`) injects **all** reflections and
**all** observations into every compaction summary. The observer prompt embeds the entire current
pool (`om.ts:407-415`: `CURRENT REFLECTIONS … CURRENT OBSERVATIONS … NEW CONVERSATION CHUNK`),
whereas the reflector only uses the last 8 observations (`om.ts:253`) — an asymmetry with no
rationale in the code.

**Evidence — measured (309 ledgers).**

- Largest reflection pool: **125 reflections / 12,135 tokens** (session `2a71a60c…`) while the
  same ledger held only 1,577 tokens of observations — i.e. reflections are an order of magnitude
  larger than the pool that is actually capped.
- Largest observation pool: 79 observations / 5,864 tokens.
- Files exceeding the dropper's pressure gate (0.7 × 45,000 = 31,500 tokens): **0 of 309**.
  Consequence: the dropper has almost certainly never executed in production, so the pool cap is
  an untested code path, and nothing bounds the reflection pool at all.

**Impact.** `observationsPoolMaxTokens` / `observationsPoolTargetTokens` do not bound what
ultimately matters (the summary payload and the observer prompt). Combined with H1, an
OM-heavy session ships a multi-thousand-token reflection dump into the summary — and the
predecessor's copy of it as well.

**Fix direction.** Prune reflections with the same policy as observations (shared pool accounting),
or cap the `buildOmCompactionSummary` output independently.

## M4 — Non-atomic ledger write + silent empty-state fallback = silent memory loss (MEDIUM)

**Evidence — code.** `writePendingState` (`om.ts:66-72`) calls `writeFileSync` directly
(`om.ts:69`) — no temp file + rename, so a crash/partial write leaves truncated JSON.
`readPendingState` (`om.ts:48-64`) catches parse errors and returns `{ observations: [],
reflections: [] }`. The observer then appends to that empty state and persists it
(`om.ts:452` / `:443`), permanently discarding the session's OM history, with no notice.

**Impact.** Silent total loss of a session's semantic memory — the exact payload H2 depends on.
`/blackhole memory` would report `0 observations, 0 reflections` without explaining why.

**Fix direction.** Atomic write (write `*.tmp` → `rename`), and on unparsable read either keep the
previous file untouched and skip the write, or surface a warning instead of silently starting empty.

## M5 — Observer failure starves the rest of the pipeline and retries every turn (MEDIUM)

**Evidence — code.** `runBackgroundConsolidation` (`om.ts:346-457`) awaits the observer stream
inside the same `try` whose `catch` swallows everything (`om.ts:452`) and whose `finally` only
resets `isConsolidationRunning` (`om.ts:455`). The reflector (`om.ts:450`) and dropper (`om.ts:451`)
run *after* the observer block, in that same `try`. The cursor is advanced only on success
(`om.ts:422-423`).

**Behaviour on a worker-model failure.** The thrown stream error skips reflector **and** dropper
for that turn; `lastObservedEntryId` is not advanced; the next `turn_end` (`om.ts:488`) retries the
same call — every turn, for the entire session, with no cooldown and no fallback model
(`observerFallbackModels`/`cooldownHours` are inert — see M1) even though
`agent/pi-blackhole/pi-blackhole-cooldown.json` exists. No `AbortSignal` is passed to
`streamSimple`, so in-flight worker requests are not cancelled on reload/abort.

**Fix direction.** Per-worker try/catch; advance the cursor when the chunk was consumed but the
model failed (or keep a separate failure count with backoff); honor the declared cooldown/fallback
configuration.

## L8 — Chunk truncation can silently skip an unobserved span (LOW)

`formatChunkEntries` (`om.ts:121-140`) builds the chunk backwards from the newest entry up to
`observerChunkMaxTokens` (60,000 by default) and returns the newest kept id as the cursor
(`om.ts:422-423`). If a single turn appends more than the chunk budget — a large tool-output burst,
for example — the older unobserved entries between the previous cursor and the chunk start are
never observed and never will be, because the cursor jumps past them. No count or notice is
emitted.

## L3 — Cursor is session-scoped while entries are branch-scoped (LOW)

`calculateTokensAfter` (`om.ts:106-119`) resolves the cursor with
`entries.findIndex(e => e.id === cursorId)`; when the id is absent it falls back to `startIndex -1`,
which counts the **entire branch**. Because the ledger is keyed by session id and never
branch-aware, a `/tree` navigation or a fork can leave `lastObservedEntryId` off the active branch
→ the observer re-processes the whole branch, duplicating observations, and the compaction path
reads that same polluted pool.

## L4 — `estimateEntryTokens` overcounts blackhole's own messages (LOW)

`om.ts:92-104`: for `custom_message` entries it uses `Math.ceil(String(entry.content).length / 4)`
where `content` is a block array — the serialized JSON framing and escapes are counted as text, so
worker messages are overcounted. This interacts with H3's self-inflation loop and with the
observer's cadence.

## Verified-sound pieces (do not "fix")

- **Ledger I/O shape.** `readPendingState` validates `observations` / `reflections` arrays and the
  optional cursors; `getPendingFilePath` keying by session id is correct (`om.ts:36-46`).
- **Cleanup IDs match reality.** Session header `{ "type": "session", "id": "<uuid>" }` was verified
  in real files and matches the `<id>-pending.json` prefix; the recursive walk covers
  `agent/sessions/<slug>/*.jsonl`. No risk of deleting a live session's ledger.
- **Re-entrancy guard.** `isConsolidationRunning` (`om.ts:165`, `:347`, `:355`) prevents
  overlapping worker runs across turns.
- **Transparency plumbing itself works.** Four `registerMessageRenderer` registrations
  (`om.ts:483-486`) + click-to-expand `WorkerMessageComponent` (`om.ts:193-213`) render correctly;
  `notifyWorkerAction`'s `try/catch` keeps non-interactive modes safe.
- **OM is genuinely alive.** 90 of 309 ledgers hold observations, 40 hold reflections; during this
  audit the session's own ledger advanced in real time (9 observations / 2 reflections within
  minutes), so the observer→reflector→dropper chain is not vestigial.
