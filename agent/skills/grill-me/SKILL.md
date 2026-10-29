---
name: grill-me
description: Interview the user relentlessly about a plan or design, resolving each branch of the decision tree. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview the user until every decision branch is resolved. Walk the tree one branch at a time, settling a decision before the ones that depend on it.

**One question per turn.** Batching hides dependencies, and an answer to a batch can contradict one already given.

**Explore before asking.** What the code can answer, look up: `fffind`/`ffgrep` to locate, `read` what they point at, `git log`/`git diff` for churn. Send one `scout` when the answer needs several files compared. Ask only what the code cannot answer — intent, preference, tradeoffs.

**Always take a position.** Each question carries your recommended answer and the reason, so the user is choosing between options, not designing for you.

Ask through `ask_user_question`, which keeps its own help current on options, `details` and `multiSelect`; don't restate those fields here.

## Stop when

1. No branch is open, and no remaining question depends on an unanswered one.
2. A `worker` subagent could implement it with no ambiguity left.
3. The user says stop.

## Design summary

Deliver a markdown file, or a fenced block when it is short:

- **Decisions** — chosen option, rationale, rejected alternatives.
- **Open questions** — deferred on purpose, each with the condition that reopens it.
- **Architecture** — components, data flow, boundaries, 3–5 sentences.

## Look up the rest

- Context hygiene, delegation, verification → [orchestrator](../orchestrator/SKILL.md)
- `ask_user_question` fields and rendering → the tool's own help
- Read-only recon subagent → `agent/extensions/herdr-subagents/agents/scout.md`
