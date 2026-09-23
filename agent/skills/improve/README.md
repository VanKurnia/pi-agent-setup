# improve

An agent skill that audits any codebase and writes implementation plans for other agents to execute.

The idea: use your most capable model for the part where intelligence compounds — understanding the codebase, judging what's worth doing, writing the spec — and hand execution to cheaper models. The skill never implements anything itself. The plan is the product.

```
you          →  /skill:improve            (expensive model, advises)
plans/       →  001-fix-n-plus-one.md       (self-contained specs)
other agent  →  implements, tests, ships    (cheap model, executes)
```

## Install

Copy this skill's directory into any agent's skill path:

- **pi**: `~/.pi/agent/skills/improve/` (global) or `.pi/skills/improve/` (project)
- **Claude Code / Codex**: their respective skills directories (see pi's `docs/skills.md` → "Using Skills from Other Harnesses")

The skill invokes via `/skill:improve ...` in pi. Plans it writes are plain markdown, so any agent (or human) can pick them up.

## Usage

```
/skill:improve                        full audit → prioritized findings → plans
/skill:improve quick                  cheap pass: hotspots, top findings only
/skill:improve deep                   exhaustive: every package, every category
/skill:improve security               focused audit (also: perf, tests, bugs, ...)
/skill:improve branch                 audit only what the current branch changes
/skill:improve next                   feature suggestions — where to take the project
/skill:improve plan <description>     skip the audit, spec one thing
/skill:improve review-plan <file>     critique and tighten an existing plan
/skill:improve execute <plan>         dispatch a cheaper executor, review its work
/skill:improve reconcile              refresh the backlog: verify, unblock, retire
/skill:improve ... --issues           also publish plans as GitHub issues
```

(pi expands `/skill:improve <args>` into the skill body with your args appended; there is no bare `/improve` command unless you add a prompt-template alias for it.)

## How to use

A typical first run, start to finish:

1. Open your agent in the repo and run `/skill:improve` (or `/skill:improve quick` to keep it cheap).
2. It maps the repo, audits it, and comes back with a findings table. Reply with the ones you want planned — "plan 1, 3 and 5".
3. Plans land in `.plans/` (see note below) — one file each, plus an index with the recommended order. Read them; they're meant to be reviewed.
4. Hand a plan to any agent ("implement .plans/001-*.md"), or let the skill run it: `/skill:improve execute 001`. It dispatches a cheaper model to implement the plan, then reviews the diff against the plan and reports back with a verdict. Whether and how to merge the changes is your call.
5. Next session, run `/skill:improve reconcile` to clean up the backlog: verify what landed, refresh what drifted, unblock what got stuck.

> **Path note:** this README's upstream examples use `plans/`; this installed copy writes to `.plans/` (SKILL.md Phase 4). Same layout, dot-prefixed so the directory stays out of the way.

## Example

A run against [shadcn/ui](https://github.com/shadcn-ui/ui) came back with findings like:

```
| # | Finding                                        | Category  | Effort | Confidence |
|---|------------------------------------------------|-----------|--------|------------|
| 1 | shadow-config duplicated in search.ts/view.ts, | tech-debt | M      | HIGH       |
|   | copies already drifted (TODO at search.ts:31)  |           |        |            |
| 2 | O(n²) icon migration (migrate-icons.ts:168)    | perf      | S      | HIGH       |
```

…and rejected a few, with reasons recorded so they don't come back next run:

```
- [SEC-01] https_proxy env var "SSRF": by-design — standard proxy convention,
  every CLI honors it. Not a finding.
```

Picking #1 produced [this plan](./examples/001-extract-shadow-config-resolution.md) — current code excerpted, exact steps, the repo's own test/lint commands as verification gates, and STOP conditions for when reality doesn't match.

## How it works

**Recon.** Maps the repo: stack, conventions, and the exact build/test/lint commands — these become verification gates in every plan. It also ingests intent and design docs when present — ADRs (`docs/adr/`), PRDs, `CONTEXT.md`, `DESIGN.md`, `PRODUCT.md` — so decided tradeoffs aren't re-flagged as findings, direction suggestions stay grounded in stated product intent, and plans speak the repo's own vocabulary. Composes with any repo that already maintains these docs.

**Audit.** Fans out parallel subagents across nine categories: correctness, security, performance, test coverage, tech debt, dependencies & migrations, DX, docs, and direction (feature suggestions — every one must cite evidence from the repo itself, no generic idea-slop). Every finding carries `file:line` evidence, impact, effort, and confidence.

**Vet.** Subagents over-report, so the advisor re-reads every cited location itself before showing you anything — false positives get dropped, wrong attributions get corrected, rejections get recorded.

**Prioritize.** Findings land in a table ordered by leverage (impact ÷ effort, weighted by confidence). You pick what becomes plans.

**Plan.** One file per selected finding, written into `.plans/` with an index, priority order, and dependency graph.

## What makes the plans executable

Plans are written for the weakest plausible executor — a model that has never seen the advisor session and may be much smaller. Three properties carry that:

- **Self-contained.** All context is inlined: exact file paths, current-state code excerpts, repo conventions with an exemplar file, verified commands. No "as discussed above."
- **Verification gates.** Every step ends with a command and its expected output. Done criteria are machine-checkable. The executor never has to judge whether it succeeded.
- **Hard boundaries.** Explicit out-of-scope lists, and STOP conditions — "if X, stop and report" — instead of letting a small model improvise when reality doesn't match the plan.

Each plan also stamps the git commit it was written against, so executors run a mechanical drift check before touching anything.

## Closing the loop

Plans aren't fire-and-forget:

- **`execute <plan>`** dispatches executor subagents (as many as the plan demands), hands them the plan, then reviews the result like a tech lead — re-runs every done criterion, checks scope compliance, reads the diff against intent. Verdict: approve (applying changes stays your call), send back for revision (max 2 rounds), or block and refine the plan.
- **`reconcile`** processes what happened since: verifies DONE plans still hold, investigates BLOCKED ones and rewrites around the obstacle, refreshes drifted plans, retires findings that got fixed independently.
- **`--issues`** publishes plans as GitHub issues — same self-contained body, so any agent or human can pick them up where work already lives.

## Hard rules

- Never modifies source code itself. The only writes go to `.plans/`; executors perform code edits in the shared working tree, and applying changes is always yours.
- Never runs commands that mutate your working tree — read, search, and read-only analysis only.
- Never reproduces secret values. Locations and credential types only, rotation always recommended.
- Asked to implement? It declines and points at the plan (or offers `execute`).

## License

MIT © shadcn
