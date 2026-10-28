# Handoff Plan Template

Every plan is written for an executor that has **zero context**: no advisor session, no audit, no other plan. Assume a competent model that follows explicit instructions and is weak at filling gaps, recovering from ambiguity, and knowing when to stop.

Three properties carry that: **self-contained context** (paths, excerpts, conventions, commands inlined), **verification gates** (every step ends in a command and its expected result, so the executor never judges success), and **hard boundaries** (explicit out-of-scope list, plus STOP conditions instead of improvisation).

File naming: `.plans/NNN-short-slug.md`, numbered in recommended execution order.

---

## Template

````markdown
# Plan NNN: <Imperative title — what will be true after this plan>

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in "STOP conditions" occurs, stop and report — do
> not improvise. When done, update the status row for this plan in
> `.plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat <planned-at SHA>..HEAD -- <in-scope paths>`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 | P2 | P3
- **Effort**: S | M | L
- **Risk**: LOW | MED | HIGH
- **Depends on**: .plans/NNN-*.md (or "none")
- **Category**: bug | security | perf | tests | tech-debt | migration | dx | docs | direction
- **Planned at**: commit `<short SHA>`, <YYYY-MM-DD>
- **Issue**: <GitHub issue URL — only when published via `--issues`; omit otherwise>

## Why this matters

2–5 sentences: the problem, its concrete cost, what improves when this lands.
Intent is what lets a correct judgment call happen when a detail is off.

## Current state

The facts the executor needs, inlined — never "as discussed" or "see audit":

- The relevant files, each with one line on its role:
  - `src/orders/api.ts` — order-list endpoint; contains the N+1 (lines 130–160)
- Short excerpts of the code as it exists today, with `file:line` markers,
  enough to confirm the executor is looking at the right thing.
- The repo conventions that apply, with one exemplar file: "Error handling
  follows the Result pattern — see `src/lib/result.ts` and its use in
  `src/users/api.ts:40-60`. Match it."
- The vocabulary and constraints from the intent/design docs found in recon,
  quoted — the executor has not read those docs: the `CONTEXT.md` terms to use
  in names and comments, the `DESIGN.md` tokens and components to reuse, the
  ADR whose decision this work must stay consistent with.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `pnpm install`           | exit 0              |
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Tests     | `pnpm test -- <filter>`  | all pass            |
| Lint      | `pnpm lint`              | exit 0              |

(Exact commands from this repo — verified during recon, not guessed.)

## Suggested executor toolkit

(Optional — only when relevant skills or tools plausibly exist in the
executor's environment. Otherwise delete the section.)

- Skills to invoke if available, and for what: "use
  `vercel-react-best-practices` when writing the memoization in step 3".
- Reference docs worth reading first, by path or URL.

## Scope

**In scope** (the only files you should modify):
- `src/orders/api.ts`
- `src/orders/api.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/orders/legacy-api.ts` — deprecated path, scheduled for deletion;
  changing it wastes effort and risks the v1 clients still pinned to it.
- Any change to the public response shape — clients depend on it.

## Steps

### Step 1: <imperative title>

What to do, precisely. Reference exact files and symbols. Include the target
code shape when it is load-bearing — the pattern to produce, not every line.

**Verify**: `<command>` → <expected output>

### Step 2: ...

(Each step small enough to verify alone. Order them so the codebase is never
broken between steps: add the new path, switch callers, then remove the old.)

## Test plan

- New tests: which file, which cases (happy path, the specific regression this
  plan fixes, named edge cases).
- The existing test to model them on: "model after `src/users/api.test.ts`".
- Verification: `<test command>` → all pass, including N new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests for <X> exist and pass
- [ ] `ffgrep({ pattern: "<old pattern>", path: "src/" })` returns 0 matches
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `.plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts —
  the codebase has drifted since this plan was written.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- You discover the assumption "<key assumption>" is false.

## Maintenance notes

For whoever owns this code after the change lands:

- What future changes interact with this (e.g. "if pagination is added to this
  endpoint, the batching in step 2 must be revisited").
- What a reviewer should scrutinize in the PR.
- Follow-ups explicitly deferred out of this plan, and why.
````

---

## Index file: `.plans/README.md`

Written once by the advisor after all plans, updated by executors:

````markdown
# Implementation Plans

Generated by the improve skill on <date>. Execute in the order below unless
dependencies say otherwise. Each executor: read the plan fully before starting,
honor its STOP conditions, and update your row when done.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | ...   | P1       | S      | —          | TODO   |
| 002  | ...   | P1       | M      | 001        | TODO   |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale)

## Dependency notes

- 002 requires 001 because <reason>.

## Findings considered and rejected

- <finding>: not worth doing because <one line>. (So nobody re-audits it.)
````

## Quality bar

Check each plan before finishing:

- **Executable blind**: a model that has never seen this repo could run it from the plan file plus the repo. Anything requiring advisor-session knowledge is inlined.
- **Verifiable**: every verification is a command with an expected result, never "make sure it works"; every step names exact files and symbols.
- **Specific**: STOP conditions describe this plan's actual risks, not boilerplate. Reviewer reading only "Why this matters" + "Done criteria" understands what they approve.
- **Clean**: no secret values (locations and types only); `Planned at` filled in and its in-scope paths match the Scope section; the executor is told to leave no `TODO`, `FIXME` or plan references in code.
- **Simple**: no speculative flexibility, extra configuration or premature abstraction; existing workspace utilities and mechanisms are reused rather than duplicated; internal invariants are enforced by tighter types instead of redundant runtime checks; removing intentional code or a deliberate abstraction requires an explicit approval note (what, why, impact, simpler replacement).
- **Grounded**: every claim about bugs, behavior or module contracts was verified this session; no guesses survive.
