# Blackhole Audit — Findings

Audit of the native `blackhole` extension at `agent/extensions/blackhole/` (4 files, 42 KB),
performed 2026-10-14 against the installed host `@earendil-works/pi-coding-agent` **1.2.0**.

Status: **findings only — nothing implemented.** No source file was modified during the audit.

## Relationship to the reference (read `05-upstream-comparison.md` first)

This extension is a **minimal native reimplementation** of the upstream package
[k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole) (itself a merge of
[sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) + [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)),
which this repo ran until plan 025 purged it. Upstream is 143 source files / 1.7 MB; the port is
4 files / 51 KB / 1,297 lines.

Consequence for reading this audit: **most findings below are port defects, not novel bugs** —
upstream contains the working remedy for the ratchet, the semantic loss, the context pollution,
the inert keys, the unbounded reflections, the ledger durability and the recall semantics. The
port kept upstream's *shape* (deterministic compile, three workers, hook, trigger, recall tool,
config schema) and dropped the *bounds and guarantees* that make the shape safe. The two
projects' goals are structurally incompatible: `AGENTS.md` mandates <5 files per extension, while
upstream's guarantees do not fit in 51 KB.

## Verdict

The extension's **mechanisms work**: every host API it calls exists and behaves as assumed, the
proactive compaction trigger demonstrably fires at its configured threshold, and the
Observational Memory (OM) workers produce real output. What is defective is the **summary
composition design** — the artifact that compaction writes into the session. It is
self-amplifying (each compaction re-embeds the previous summary verbatim), it exceeds pi's
retained-context budget at its worst, and it replaces pi's LLM summarizer unconditionally, so
semantic memory rests entirely on OM quality.

Severity summary:

| ID | Finding | Severity | File |
|----|---------|----------|------|
| H1 | Summary ratchet — previous summary re-embedded verbatim; worst case 30.8k tokens > `keepRecentTokens` 20k | HIGH | `01-compaction-engine.md` |
| H2 | Hook always overrides pi's default summarizer; no fallback when OM is empty | HIGH | `01-compaction-engine.md` |
| H3 | Worker transparency injected into LLM context with raw ANSI escape sequences | HIGH | `02-observational-memory.md` |
| M1 | 20 of 33 effective config keys are inert (10 declared-but-unread + 10 absent from the type) — no model fallback, no cooldown, no retained-tool-output projection | MEDIUM | `03-config-and-recall.md` |
| M2 | Reflection pool is never pruned; observer prompt re-sends the whole pool | MEDIUM | `02-observational-memory.md` |
| M3 | Split-turn compactions silently lose file tracking (`turnPrefixMessages` ignored) | MEDIUM | `01-compaction-engine.md` |
| M4 | Non-atomic ledger writes + silent empty-state fallback = silent total memory loss | MEDIUM | `02-observational-memory.md` |
| M5 | Observer failure starves reflector + dropper and retries every `turn_end` | MEDIUM | `02-observational-memory.md` |
| M6 | `recall` does not implement its advertised search semantics | MEDIUM | `03-config-and-recall.md` |
| L1–L8 | State-hygiene, default divergence, dead artifacts, duplicate config, chunk skip | LOW | all three |

## Method

1. Read all 4 source files in full (`config.ts`, `compaction.ts`, `index.ts`, `om.ts`).
2. Verified every host API against the installed 1.2.0 declarations and runtime
   (`dist/core/extensions/types.d.ts`, `dist/core/compaction/*`, `dist/core/agent-session.js`,
   `dist/core/messages.js`) plus `docs/compaction.md`, `docs/extensions.md`, `docs/message-types.md`.
3. Analyzed the real corpus: 283 session files, 164 unique compaction entries (deduped across
   fork copies of 300 raw), 309 OM ledger files.
4. Re-ran the probes in `04-verification-probes.md` to confirm the numbers below.
5. Downloaded upstream `k0valik/pi-blackhole` (`HEAD 1907ede0`, 146 files / 1.7 MB, HTTPS only) and
   compared it mechanism-by-mechanism (`05-upstream-comparison.md`).
6. Mapped the cross-extension coupling with `subagents/` — `run.ts` lazy-imports blackhole's summary
   modules, and blackhole reaches back through `getExtensionApi("subagents")`
   (`06-subagents-blast-radius.md`).

## Corrected evidence baseline (era split)

Compaction entries split into three populations. **Only the `current-vcc` era is this
extension's current code**; `legacy-vcc` was an earlier engine with a `[Session Goal]` format and
is *not* part of these findings.

| Era | Marker | n | OM present | median chars | max chars | max tokens | nesting |
|---|---|---|---|---|---|---|---|
| current-vcc | `### Files Touched` | 31 | **30 (97%)** | 21,507 | **123,219** | **30,805** | 0 → 5 |
| legacy-vcc | `[Session Goal]` | 130 | 0 | 28,188 | 127,009 | 31,753 | 0 |
| pi-default | `## …` | 3 | 0 | 7,390 | 8,669 | 2,168 | 0 |

> Correction to an earlier verbal summary: the "81% of compactions carry no OM" figure was
> skewed by the 130 legacy-era entries. Within the current engine, OM presence is 97% (30/31).
> The single OM-less current-era entry is the concrete failure case in H2.

Compaction-entry metadata, same measurement — this is where the native rewrite regressed:

| Era | entries | hook-provided | with `details` | with `usage` | `details` keys seen |
|---|---|---|---|---|---|
| current-vcc | 31 | 31 | **0** | 0 | — |
| legacy-vcc | 130 | 130 | **130** | 0 | `compactor, version, sections, sourceMessageCount, previousSummaryUsed, om.folded` (*+ `retainedToolOutputProjection`*) |
| pi-default | 3 | 0 | 3 | 3 | `readFiles, modifiedFiles` (pi's `CompactionDetails`) |

The previous engine wrote a self-describing `details` record — including `om.folded` and
`retainedToolOutputProjection` — and the native port dropped it entirely. That is also why 10 of
the config keys in the effective file are ported-but-unimplemented (see M1).

## What is *not* broken (avoid over-correcting)

- **API conformance.** `agent_settled.aborted`, `ctx.compact({ onComplete, onError })`,
  `ctx.getContextUsage()`, `ctx.isIdle()`, `pi.sendMessage(…, { triggerTurn: false })`,
  `pi.registerMessageRenderer`, `pi.registerTool`, `pi.registerCommand` all match 1.2.0.
  `ContextUsage.tokens: number | null` is handled correctly (`!= null` check, not truthiness).
- **Hook return shape.** `{ summary, firstKeptEntryId, tokensBefore }` matches
  `SessionBeforeCompactResult` / `CompactionResult`; `usage` is optional and correctly omitted.
- **Proactive trigger works.** Observed `tokensBefore` = 254,847 / 266,594 / 269,568 / 310,144
  against the configured `compactAfterTokens: 254000`
  (custom models in `agent/models.json` are 300k context → 84.7% of window).
  pi's own threshold for that window would be 283,616, so blackhole correctly fires first.
- **Compaction is zero-LLM and instant.** Hook-produced entries carry no `usage`, consistent
  with a purely deterministic summary — a genuine design win, keep it.
- **Abort/race guards** around the deferred compaction (`signal.aborted`, session-id re-check
  before `ctx.compact()`), so no phantom compaction after a run is aborted.
- **Ledger cleanup is safe.** Session header `{ type: "session", id }` matches the
  `<id>-pending.json` prefix, and the recursive walk covers nested session dirs
  (`agent/sessions/<slug>/*.jsonl`) — verified against real files, no live-ledger deletion risk.
- **`source: "parent"` recall path** (registry + `globalThis` fallback for isolated subagent
  processes) is sound.

## Fix priority (official-API-only, unapproved — for discussion)

1. **H1** — stop re-embedding the previous summary verbatim; impose a hard char/token budget on
   the compiled summary. (`compaction.ts:56-82`)
2. **H2** — `return` (fall through to pi's default summarizer) when OM is empty, instead of
   emitting a files-only summary. (`index.ts:163-190`)
3. **H3** — move worker transparency to `pi.appendEntry()` + `pi.registerEntryRenderer()`.
   (`om.ts:215-235`)
4. **M4, M2, M5** — atomic ledger write, prune reflections, isolate worker failures.
5. **M1, M3, M6** — implement or delete inert config keys; include `turnPrefixMessages`; fix
   recall's regex/`mode: "file"` semantics.

## Files

| File | Contents |
|---|---|
| `01-compaction-engine.md` | H1, H2, M3 + L1, L5 — summary composition and the hook contract |
| `02-observational-memory.md` | H3, M2, M4, M5 + L3, L4 — workers, ledger, context injection |
| `03-config-and-recall.md` | M1, M6 + L2, L6, L7 — config surface, dead keys, recall tool |
| `04-verification-probes.md` | Re-runnable Node probes and the exact numbers they produced |
| `05-upstream-comparison.md` | **Upstream vs local:** lineage map, section-by-section contract, finding-by-finding re-verdict, options + recommendation |
| `06-subagents-blast-radius.md` | **Cross-extension blast radius:** the three `blackhole` → `subagents` seams, what is type/test-pinned, per-fix hazard matrix, frozen surfaces |

## Boundaries

- Static gates (`npm run typecheck`, eslint, prettier) were **not** run; every finding here is a
  runtime/behavioral or contract-level observation, not a type error.
- 130 legacy-era compactions and the 309-file ledger backlog were left untouched — no cleanup,
  no git operation, per `AGENTS.md`.
