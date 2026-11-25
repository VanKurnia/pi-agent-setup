---
name: git
description: Commit staged changes, compact unpushed commits, or generate a changelog for a commit, range, or branch. Explicit invocation only, one mode per call.
disable-model-invocation: true
metadata:
    argument-hint: "[commit | compact-commit | generate-changelog]"
---

# Git

Three modes over the repository's history. The first token selects the mode; a bare invocation is an `ask_user_question`, because each mode changes git differently.

| Mode | Does | Arguments | Read before starting |
| --- | --- | --- | --- |
| `commit` | writes the message for the staged changes and commits them | optional note | [references/commit.md](references/commit.md) |
| `compact-commit` | squashes unpushed commits into fewer ones | optional count, `<from>..<to>`, or note | [references/compact-commit.md](references/compact-commit.md) |
| `generate-changelog` | writes a change list for a commit, a range, or a branch | required selector | [references/generate-changelog.md](references/generate-changelog.md) |

## Git access

- Run git through the shell tool — `powershell` on Windows, `bash` on Unix. There is no `git` tool to call.
- Reading history is free: `log`, `diff`, `show`, `status`, `merge-base`. Every write stays inside what the mode describes.
- Never push. Never touch the working tree beyond what the mode's rewrite needs.

## Messages

- Title: Conventional Commits, a few words, the core change only.
- Body: only what the diff does not say.

## Approval gate

`commit` and `compact-commit` change the index or history, so nothing runs before approval. Present the draft, then `ask_user_question` with three options: approve, edit, cancel. Edit feedback revises the draft and returns to the same question; cancel stops.

Report the commands run and what they printed. A failing check is reported, never fixed silently.
