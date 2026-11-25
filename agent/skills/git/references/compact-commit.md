# Compact Commit

Squash the latest unpushed commits into fewer, still meaningful ones.

## Scope

1. Find the boundary: `git log --oneline @{u}..`. No upstream → the first commit not on `origin/main`, `origin/master`, or `main`.
2. An explicit count or `<from>..<to>` narrows the range; a plain note does not.
3. Empty range, or a single commit → tell the user and stop.
4. Never rewrite at or before the boundary.

## Draft

Read `git log -p <base>..HEAD` and group it into the fewest commits that still carry one meaning each. Merge fixups into the commit they fix, drop changes that only revert an earlier one, and split only where a commit mixes unrelated meanings.

Present the base SHA, the current commit list, and the proposed list with title and body per commit. Pass the approval gate.

## Execute

1. `git reset --soft <base>` — mixed only when a commit has to split files.
2. Re-commit each group in the original order.
3. Verify with `git log --oneline <base>..HEAD` and `git status`; `git diff <old-head>` must be empty.

Report the new list and the tree check. A failing check ends the run.
