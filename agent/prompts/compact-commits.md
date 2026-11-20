---
description: squash unpushed commits into fewer, compact conventional commits
argument-hint: "[count|from..to|note]"
---
Compact the user's latest unpushed commits into fewer, more compact commits.

Additional user note (if any): $@

## Scope

1. Find the pruning boundary: `git log --oneline @{u}..` (upstream unpushed).
   - No upstream: use the first commit not on `origin/main`, `origin/master`, or `main`.
   - Explicit `$1` as a count or `<from>..<to>` narrows the range; a plain note does not.
2. If the range is empty or has a single commit, inform the user and stop.
3. Never rewrite commits at or before the boundary. Never push, never touch the working tree beyond what the rewrite needs.

## Draft

Read the range (`git log -p <base>..HEAD`) and group it into the fewest commits that still carry one meaning each.

- Title: Conventional Commits, a few words, core change only.
- Body: only what the diff does not say.
- Merge fixups into the commit they fix; drop reverted-only changes.
- Splitting is allowed only when a commit mixes unrelated meanings.

## Confirm

Present the base SHA, the current commit list, and the proposed list (title + body per commit). Use `ask_user_question` with:

- "Yes, rewrite with this plan."
- "No, I want to suggest an edit."
- "Cancel."

On edit feedback, revise the plan and return here. On cancel, stop.

## Execute

1. `git reset --soft <base>` (mixed only if a commit must split files).
2. Re-commit each group in the original order with `git commit -m "<message>"`.
3. Verify: `git log --oneline <base>..HEAD` and `git status`; the tree must match the pre-rewrite tree (`git diff <old-head>` is empty).

Report the new list and the tree check. If the check fails, report it and stop; do not push or fix silently.
