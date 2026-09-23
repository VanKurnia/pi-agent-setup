---
description: simplify a completed workpackage
argument-hint: "[workpackage...]"
---

Review the completed workpackage(s) and simplify its implementation without changing its intended behavior.

Target scope: ${@:-all current changes in this session}

## Scope

- If workpackage(s) are given above, limit strictly to code added or affected by those workpackage(s) plus the nearby code needed to simplify them coherently. Ignore all other changes.
- If no scope is given, focus on code added or affected by the current workpackage and the nearby code needed to simplify it coherently.
- Do not perform unrelated cleanup.
- Read the affected files in full and understand the relevant invariants, call sites, tests, and public API before editing.
- Optimize for a direct, coherent, maintainable design—not the smallest diff.

## What to remove or simplify

- Remove abstractions that have no clear responsibility or do not reduce real complexity.
- Inline trivial helpers, wrappers, adapters, and pass-through layers when they obscure rather than clarify behavior.
- Remove duplicated logic and put shared behavior at the appropriate existing layer.
- Enforce DRY against the existing workspace — check current workspace rules, structure, and already existing mechanisms/utilities before introducing new ones; reuse or extend them instead of duplicating, and dedup any new logic against them.
- Remove speculative flexibility, configuration, extension points, and generic machinery that have no current requirement.
- Remove speculative defensive programming inside trusted code. Validate at real trust boundaries; rely on types and established invariants internally.
- Do not keep fallback behavior for states that should be impossible. Prefer fixing the invariant or type model.
- Simplify excessive state, boolean flags, branching, indirection, and special cases. Rework the underlying representation when that is clearer.
- Tighten TypeScript types so invalid states are unrepresentable. Avoid `any`, unnecessary assertions, broad types, and optional fields for impossible states.
- Prefer direct, readable code over cleverness, premature abstraction, and framework-like infrastructure.

## Comments hygiene

- Leave every comment team-clean: short, factual, general, and explaining only constraints, intent, or non-obvious decisions. Describe the rule, not specific instances — no unnecessary examples. Delete comments that merely restate the code.
- Never reference personal workflow artifacts in code comments — no `sesuai todo`, `per todo section 4`, `sesuai plans 30`, `plan #X`, or tracking IDs. Describe the actual rule/intent generically (e.g. `enforce single source of truth`) instead of pointing to a todo/plan section.
- Never add task-tracking comments to code: no `TODO`, `FIXME`, `HACK`, `XXX`, `NOTE`, or todo-list sections used to track personal follow-ups. Keep the personal todo list outside the codebase; do not leak it into committed code where it would bother other team members.
- Remove any such tracking comments introduced by the workpackage: either resolve the item now as part of the simplification, or drop the comment from code and report it as unfinished work in the final summary instead.
- Do not leave commented-out code, debug markers, work-in-progress notes, or references to personal workflow, session notes, or internal tracking IDs.

## Approval gate for significant removals

Before making any significant or potentially intentional removal, stop and ask the user for approval. First explain:

1. what you propose to remove or change;
2. why it appears unnecessary or overly defensive;
3. what behavior, compatibility, extensibility, validation, or failure handling could be affected;
4. the simpler replacement, if any; and
5. your recommendation.

Wait for explicit approval before applying that change. Do not bundle approval for multiple independent decisions; present them separately when the tradeoffs differ.

Treat a decision as significant when it removes or materially changes any of the following:

- user-visible behavior or supported workflows;
- public APIs, persisted formats, protocol behavior, or backward compatibility;
- validation, authorization, security checks, recovery, retries, fallbacks, or error handling;
- an abstraction or extension point that appears deliberate or has multiple consumers;
- functionality covered by tests or documentation;
- code whose purpose or invariant is uncertain.

Routine, behavior-preserving cleanup does not require approval, such as inlining a single-use trivial helper, removing an unreachable branch proven impossible by the type model, or deleting newly added duplication. If uncertain whether a removal is significant, ask.

## Constraints

- Preserve intended behavior unless the user explicitly approves a change.
- Do not remove code merely because it is unused until you have checked whether it is a public API, extension point, generated entry point, or intentionally retained compatibility surface.
- Do not replace clear code with a new abstraction solely to reduce line count.
- Do not weaken tests to permit simplification. Update tests only when an approved behavior change or a cleaner equivalent structure requires it.
- Follow the repository's validation and testing instructions after edits.

## Completion

After editing, review the final diff for avoidable complexity, duplication, indirection, defensive branches, leftover comments/task-tracking notes, and accidental behavior changes. Report:

- what was simplified;
- which invariants the implementation now relies on;
- any significant removals you did not make because approval was not granted; and
- the validation performed and its results.

Passing tests and type checks is necessary but not sufficient. Leave the affected code easier to understand and change.
