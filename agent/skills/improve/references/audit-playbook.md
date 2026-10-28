# Audit Playbook

What to look for, per category. Give each subagent its section plus [Finding format](#finding-format). Scale depth to repo size — a 2K-line CLI gets a lighter pass than a 500K-line monorepo.

A finding needs evidence. "Probably has N+1 queries somewhere" is not one; `orders/api.ts:142 issues a query per order item inside a loop` is.

Two rules apply in every category:

- **Never copy a secret value** into a finding or plan — those files get committed. Name the `file:line` and credential type, and make rotation part of the fix (a committed secret is burned even after deletion).
- **By-design is not a finding.** Standard conventions are intentional: honoring `https_proxy`, reading `~/.netrc`, a local dev tool shelling out to the configured package manager. A tradeoff recorded in an ADR is settled too. Flag them only when the implementation adds risk beyond the convention. A **stale ADR is itself a finding**: code drifted from the decision doc means one of the two is wrong, and the team should hear it.

---

## 1. Correctness / Bugs

The highest-trust category: real bugs found by reading. What gets missed most — swallowed errors on critical paths, unawaited promises and unremoved listeners, `!` or `as` where the value can be null, off-by-one and empty-collection boundaries, `default:` branches that silently no-op on a new enum member, check-then-act without a transaction, retried webhooks that are not idempotent, and handles or connections with no `finally`. Clusters of `any`/`@ts-ignore` mark the places the compiler was overruled.

## 2. Security

Keep findings at the level of defensive maintenance: identify the pattern, state the production impact, describe the remediation in terms of code, config and tests. No runnable exploit strings or step-by-step misuse.

What gets missed most — credentials in committed `.env` or logged into event stores; queries, shell commands, HTML sinks or filesystem paths built from request data; endpoints and server actions without a server-side identity check, ownership check (IDOR), or CSRF protection; request bodies persisted without schema validation or with broad object assignment; missing response-hardening headers where a sensitive browser surface exists; PII in logs or internal errors returned to clients. Run the ecosystem audit in read-only mode and report only critical/high advisories that reach runtime or distribution code.

## 3. Performance

Architectural wins, not micro-optimizations. What gets missed most — a query or fetch per item inside a loop, a `find`/`filter` inside a hot loop where a keyed `Map` belongs, the same expensive computation or fetch repeated per request with no memoization at an obvious boundary, `select *` and unpaginated lists, a heavyweight dependency for a trivial use, synchronous work that belongs in a queue, and missing indexes implied by query patterns (flag for verification against the schema — never claim without it).

## 4. Test Coverage

The question is not a percentage but *which untested code is dangerous*: money, auth, data mutation, the feature the repo exists for. High-churn modules with no tests are "characterization tests first" candidates. Judge existing quality — assertions that assert nothing, heavy mocking that tests the mocks, snapshots nobody reads, real timers and real network in unit tests. Missing integration coverage on API boundaries, or slow E2E where a unit test would do, both count. If there is no one-command way to know the codebase works, that is finding #1.

## 5. Tech Debt & Architecture

What gets missed most — the same logic re-implemented in three places with the copies already drifted; layering violations and cycles; modules a magnitude larger than the median that everything touches; functions with double-digit parameters or deep conditional nesting; three ways of doing data fetching, error handling or styling in one repo (pick the one the team converged on most recently, plan toward it); premature abstractions with a single implementation, and missing ones where every change touches N files in lockstep; deps in the manifest no longer imported.

## 6. Dependencies & Migrations

Only the lag that costs something: EOL runtimes, security-fix cutoffs, ecosystem incompatibility, deprecated APIs with announced removal, abandoned packages on a critical path, two libraries solving one problem, lockfile/manifest drift across a monorepo. Estimate blast radius (files touched) for each candidate — it drives both effort and whether to recommend it at all.

## 7. DX & Tooling

Missing or broken typecheck, lint, formatter, pre-commit hooks, editorconfig. Feedback loops measured in minutes with no watch mode and no CI cache. Setup steps in the README that are wrong or incomplete, undocumented env vars, no `.env.example`. Missing `AGENTS.md`/`CLAUDE.md` is high-leverage when agents will execute the plans — recommend one with its outline. Unstructured logs with no request IDs make debugging require code changes.

## 8. Docs

Lowest default priority. Flag only where absence has a concrete cost: a published API with no reference docs, decisions nobody can reconstruct in actively contested areas, and stale docs that are actively wrong (setup steps, examples that no longer compile) — worse than missing.

## 9. Direction — features & where to take this next

Not what is broken but what the codebase wants to become. **Grounding rule:** every suggestion cites evidence from this repo; anything that would fit any project ("add dark mode", "add AI") is noise. Sources, strongest first:

- **Stated but undelivered** — a PRD or `PRODUCT.md` naming users or a direction the code has not caught up to; README promises with no code; flags and config options that are no-ops. Never propose what a decision doc already rejected — note the contradiction instead.
- **Unfinished intent** — TODO/FIXME clusters around one theme, half-built modules, feature flags never rolled out, abandoned work visible in git history.
- **Surface asymmetries** — export without import, create without bulk-create, CRUD minus one, webhooks out but not in, and a public API internal code obviously hand-rolled around.
- **The adjacent possible** — capabilities the architecture makes disproportionately cheap: a plugin system one interface away, an endpoint one route file from the existing service layer, an integration the data model already supports.
- **Friction worth productizing** — the manual steps users evidently perform around the project, visible in docs, examples and issues.

Direction findings use the standard format with two changes: **Impact** is product/user value (who wants this, why now), and **Confidence** says how well grounded the evidence is, not how sure you are it is the right call. Strategy belongs to the maintainer; the advisor supplies grounded options and honest tradeoffs. Plans for selected direction findings are design/spike plans — investigate, prototype, define the API, list open questions.

---

## Finding format

Every finding, from every category and every subagent, comes back in this shape:

```markdown
### [CATEGORY-NN] Short imperative title

- **Evidence**: `path/file.ts:123` — one sentence on what is there. (2–5 strongest locations; note "and ~N similar sites" when widespread.)
- **Impact**: What goes wrong, or what is being paid. Concrete: "every order-list render issues 1+N queries", not "suboptimal".
- **Effort**: S (hours) / M (a day-ish) / L (multi-day) — for the fix, including tests.
- **Risk**: What the fix could break; LOW/MED/HIGH plus one line why.
- **Confidence**: HIGH (read the code, certain) / MED (strong signal, needs verification) / LOW (smell, needs investigation — gets an "investigate" plan, not a "fix" plan).
- **Fix sketch**: 1–3 sentences. Not the plan — just enough to judge effort honestly.
```

## Prioritization rubric

Order by **leverage = impact ÷ effort, discounted by confidence and fix risk**. Tiebreakers:

1. Anything that unblocks other findings (a verification baseline, characterization tests) floats up.
2. A HIGH-confidence security finding outranks an equal-leverage non-security one.
3. Prefer findings with a clean verification story — executors succeed at those.
4. "Not worth doing" is a valid verdict; record it with one line so the user knows it was considered.
