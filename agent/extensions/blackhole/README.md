# blackhole

Deterministic context compaction, background Observational Memory, and a
history-search `recall` tool for pi sessions.

This is a **bounded local port** of the upstream package
[`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole), not a copy of it. It exists to
fit this repository's rule that an extension stays at four `.ts` files, and it deliberately
implements only the parts that keep a session's memory intact across compaction. The audit that
produced it — findings, upstream comparison, and the `subagents` blast radius — lives in
`.todo/blackhole/`.

## Architecture

| File            | Role                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `index.ts`      | Trigger on `agent_settled`, the `session_before_compact` hook, the `/blackhole-*` commands, the settings editor, and the `recall` tool |
| `compaction.ts` | Summary composition (`compileVccSummary`), touched-file and commit extraction, token accounting                |
| `om.ts`         | Pending store, observer/reflector/dropper workers, worker renderers, cleanup                                   |
| `config.ts`     | Config load, the merge write behind `/blackhole-model`, and the auto-compaction threshold                |

Data flow: a settled agent run may exceed the threshold → `ctx.compact()` → the host asks
`session_before_compact` → the hook composes OM + carried context + a transcript excerpt + files and
commits → the summary is written into the session. In parallel, `turn_end` drives the workers, which
write the pending store asynchronously.

The pending store is one JSON file per session under `agent/pi-blackhole/`
(`<sessionId>-pending.json`), written atomically (tmp + rename) with a rolling
`<sessionId>-pending.stale.json` backup, and recovered from that backup when the main file is
unreadable.

## Configuration

`agent/pi-blackhole/pi-blackhole-config.json` (2-space JSON) overrides `DEFAULT_CONFIG` in
`config.ts`. Every key below is read by code; unknown keys in the file are ignored.

| Key                                                                 | Default       | Effect                                                                   |
| ------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `showWorkerMessages`                                                | `true`        | Publish worker notices as custom entries                                 |
| `compaction`                                                        | `"auto"`      | `off` disables the proactive trigger; `manual` disables the auto trigger |
| `compactionEngine`                                                  | `"blackhole"` | `"pi-default"` defers to the host's own summarizer                       |
| `compactAfterTokens` / `compactAfterRatio` / `compactReserveTokens` | unset         | Auto-compact threshold, in that precedence order                         |
| `memory`                                                            | `true`        | `false` disables all background workers                                  |
| `observeAfterTokens`                                                | `25000`       | Unobserved tokens that wake the observer                                 |
| `reflectAfterTokens`                                                | `80000`       | Unreflected tokens that wake the reflector                               |
| `observationsPoolMaxTokens`                                         | `40000`       | Render bound for observations and the dropper's pressure base            |
| `observationsPoolTargetTokens`                                      | `20000`       | Trim target when the dropper fires                                       |
| `reflectionsPoolMaxTokens`                                          | `8000`        | Render bound for reflections (they otherwise accumulate without bound)   |
| `observerChunkMaxTokens`                                            | `60000`       | Max tokens per observed chunk                                            |
| `dropperPressureThreshold`                                          | `0.7`         | Fraction of the observation pool that triggers the dropper               |
| `recallResponseMaxChars`                                            | `4000`        | Response cap for the `recall` tool                                       |
| `model` / `observerModel` / `reflectorModel`                        | unset         | Worker models; each falls back to the session model                      |

The observer's memory preamble is additionally capped at 30 % of `observerChunkMaxTokens`, so a
large pool cannot inflate every worker call.

## Commands

- `/blackhole-prune` — removes pending files whose session is gone (main, backup, and temp files).
- `/blackhole-memory` — prints the observation/reflection counts for the current session.
- `/blackhole-model` — interactive editor for every key in `pi-blackhole-config.json`: the three model
  slots (searchable picker over the installed models), enum settings as pickers, and numbers as prompts
  (empty input unsets the key, restoring its default).

The editor merges into the existing file, so hand-written keys (including `_comment` notes) survive. A
model pick rewrites only its own slot's `provider`/`id` and drops the `_comment` that described the model
it replaced. `thinking` is carried along untouched but is not offered: no blackhole code reads it.

A model entry must name both a `provider` and an `id` to be usable; one missing either leaves the worker
it configures off, as does an unset slot — `config.observerModel || config.model` has to resolve a model
for the worker to run. The provider is never guessed, so the config file is the only place it comes from.

Config is read from disk per worker turn and per compaction check, so an edit applies without `/reload`.

## Interfaces

Frozen surfaces other code or tests depend on — change them only with the consumers:

- **`agent/extensions/shared/blackhole-api.ts`** — `BlackholeSnapshotApi`
  (`compileVccSummary`, `buildOmCompactionSummary`) plus `setBlackholeSnapshotApi` /
  `getBlackholeSnapshotApi`. Consumed by `subagents/src/run.ts` for the delegation snapshot. It is
  `globalThis`-backed **because** pi's extension loader builds one jiti instance per extension with
  `moduleCache: false`: a module-level registry is a private copy per extension and never crosses
  the boundary in production. If no provider is registered, the consumer yields an empty snapshot —
  never an error.
- **The summary contract** — sections are emitted in this order: `### Active Context & Insights`,
  `### Recent Conversation`, `### Carried Context`, `### Files Touched`, `### Recent Commits`. Memory
  leads but is bounded to 60 % of the budget, so the structural sections always survive; the whole
  string is then bounded by the caller's budget (default `SUMMARY_MAX_CHARS` 8000 for compaction,
  24000 passed by `subagents` for the delegation snapshot). The snapshot consumers
  (`.script/test/subagent/snapshot.test.mjs`) pin the section headers and the budget.
- **The `recall` tool** — name, parameter names (`query`, `expand`, `page`, `scope`, `mode`,
  `source`), the `No matches …` prefix, the `... (truncated)` suffix, and the 4096-character
  effective cap are pinned by `.script/test/subagent/recall.test.mjs`. Drill-downs (`#N:text`,
  `#N:file`, `#N:<path>`) are windowed by `:<offset>:<limit>` / `:full` and always end with a
  `[chars X-Y of N]` footer — pinned by `.script/test/blackhole/recall-search.test.mjs`.
- **Worker notices** — `blackhole:*` payloads go through `pi.appendEntry` (rendered by
  `pi.registerEntryRenderer`) and must **never** use `pi.sendMessage`, which enters model context.

## Deliberate limits

| Upstream feature                                                                   | What this port does instead                                         | Why                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Session-entry ledger with tombstones and folding                                   | One JSON file per session, atomic write + rolling backup + recovery | Keeps the store safe without the session-manager folding surface                               |
| Per-worker model fallback chains and persisted cooldowns                           | Per-worker in-memory cooldown (5 min) + a 120 s stream timeout      | Failure isolation is the part that matters; persistence is not                                 |
| V2 immutable compaction segments                                                   | Single summary composed within a caller budget                      | Removes the ratchet without a segment chain                                                    |
| Six extractive sections (goal, outstanding context, preferences, brief transcript) | Bounded transcript excerpt + de-duplicated carried bullets          | Structured extraction needs upstream's heuristics; narrative is what compaction was destroying |
| BM25 / per-term regex intent in `recall`                                           | Literal or regex search over message text and tool-call payloads    | Correctness first; ranking is an optimisation                                                  |
| Full-file content indexing                                                         | Tool-call argument payloads only (write/edit arguments)             | The file contents are in the tool calls; an index would be a second store                      |

These are trade-offs of the ≤4-file rule in `AGENTS.md`, not oversights —
`.todo/blackhole/05-upstream-comparison.md` has the full comparison.

## Invariants

- The summary never embeds the previous summary verbatim, and it is always composed within its
  budget, with memory bounded to a share so no section can starve the others.
- A missing OM cursor means "unknown position", never "start of branch" (that replay duplicated
  observations).
- The pending store is written atomically; an unreadable main file is never overwritten without
  having been preserved.
- Worker notices never enter model context.
- The snapshot provider is optional for consumers: absent provider → empty snapshot, no throw.
- `blackhole:*` custom entries and legacy `blackhole:*` custom messages both render as worker cards.

## Verification

```powershell
npx tsc --noEmit
npm test                                  # all *.test.mjs, includes the extension suites
node .script/test/blackhole/summary.test.mjs        # summary bounds + semantics
node .script/test/blackhole/om-bounds.test.mjs      # pool bounds + cursor anchors
node .script/test/blackhole/pending-state.test.mjs  # atomic write, backup, recovery
node .script/test/blackhole/worker-notice.test.mjs  # notices stay out of LLM context
node .script/test/blackhole/worker-guard.test.mjs   # cooldown + timeout
node .script/test/blackhole/recall-search.test.mjs  # regex + file payload search
node .script/test/blackhole/settings.test.mjs       # /blackhole-model config writes
node .script/test/subagent/snapshot.test.mjs        # cross-extension snapshot seam
node .script/test/subagent/recall.test.mjs          # recall contract pins
```

Note: `agent/pi-blackhole/pi-blackhole-config.json` is 2-space while the repo Prettier config uses
`tabWidth: 4`; `prettier --check` on that file fails for pre-existing reasons and it is intentionally
left unformatted.
