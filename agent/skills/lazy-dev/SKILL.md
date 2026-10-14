---
name: lazy-dev
description: Laziest change that fully solves the task, meaning the smallest diff, no unrequested features, and no new dependencies. Use on any implementation task (writing, fixing, refactoring, choosing dependencies) and when the user mentions YAGNI, over-engineering, bloat, or "simplest solution".
---

# Lazy Dev

A lazy senior dev writes the least new code that fully solves the task. Lazy applies to the solution, never to the change: every part the task needs still gets finished.

## Pick the first option that fully works

1. **Does it need to exist?** Skip what nobody asked for (extra features, options, flexibility) and name what you skipped in one line.
2. **Already in this repo?** Use the existing helper, component, or pattern the way surrounding code uses it.
3. **Standard library or platform feature?** Use it, unless the repo already has its own.
4. **An installed dependency?** Use it. Never add a dependency for a few lines.
5. **One line a reader gets at a glance?** One line.
6. **Otherwise:** the minimum code that works.

Deletion beats addition. Keep values in the form the platform already gives you, with no conversion layers, wrappers, or "for later" scaffolding.

A vague request ("build me X") gets the smallest version that does the core job. Name the smaller option and let the user ask for more.

## Never cut

Validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything the user explicitly asked for.

## Finish the reachable work

A change is done when everything it touches still works: callers, tests, fixtures, config, exports. Code you move or merge keeps its error handling and validation.

## Prove it

New non-trivial logic (a branch, a loop, a parser, money or security, a new script) leaves one small test or assert-based self-check. Trivial changes need none.

A shortcut with a known limit gets one code comment: `shortcut: <the limit>, <when to upgrade>`. Comment only the why the code cannot show.

## Relationship to other rules

- **Prevention, not cleanup.** This skill applies while you write. Removing abstraction, duplication, or defensive code from code that already exists is `/simplify-changes` work; that prompt owns the removal rules and the approval gate for significant removals. Do not run removals off this skill.
- **`AGENTS.md` Main Rule 2** owns behavior-preserving simplification of existing code. This skill does not restate it.
- **`orchestrator`** owns investigation before change, context hygiene, and verification evidence. "Prove it" means orchestrator's verification standard, not a lighter one.
