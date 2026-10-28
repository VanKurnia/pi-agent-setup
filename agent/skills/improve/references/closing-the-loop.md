# Closing the loop — review-plan, execute, reconcile, issues

The advisor's job does not end at the plan. Read this file for `review-plan`, `execute`, `reconcile` and `--issues`.

The founding rule survives while the skill is active: **the advisor never edits source code.** In `execute` a `worker` subagent edits; the advisor dispatches, reviews and renders a verdict, like a tech lead who reviews rather than authors.

---

## `review-plan <file>`

Dispatch a `scout` (never review the plan yourself first) with the plan file's absolute path, its full text inlined, the two passes below, and "findings only — no fixes, no edits, no file dumps". Vet the report against the file, then edit `.plans/NNN-*.md` in place. No subagents available → review directly and say so in the report.

**Pass 1 — rigor and executability.** Is every excerpt, path and convention inlined, with no reference to chat history? Does every step end in a machine-checkable command and expected result? Do the drift-check SHA and in-scope paths match the Scope section? Are the STOP conditions specific to this plan's risks rather than boilerplate?

**Pass 2 — simplification and anti-bloat.** Flag speculative wrappers, adapters and pass-through layers that add indirection without removing real complexity. Cross-check planned additions against utilities that already exist in the workspace and flag what should reuse them. Flag unneeded config options, generic type machinery and extension points the immediate task does not require (YAGNI). Flag defensive runtime branching in trusted internal code and recommend tightening the type model instead. Any removal of intentional functionality needs an explicit rationale: what, why, impact, simpler replacement, user confirmation. Require an instruction forbidding `TODO`/`FIXME`/plan references left in code.

---

## `execute <plan>` — dispatch and review

### Preconditions

The plan file exists and its dependencies show DONE in `.plans/README.md`; if not, stop and name the missing dependency. Run the plan's drift check yourself — a drifted plan gets reconciled first, never handed to an executor.

### Dispatch

One `worker` subagent at a time with `{ agent: 'worker', task: '<full plan text>' }`, in dependency order. The call is synchronous — it blocks until the reply arrives, no async dispatch — so the next plan starts only after this one's verdict; every revision round is a new dispatch with the full plan text inlined. `still working` means wait, then retry.

The task contains the full plan text (or the relevant slice), the executor preamble, and the report format:

> You are the executor for the implementation plan below. Follow it step by
> step. Run every verification command and confirm the expected result before
> moving on. Touch only the files listed as in scope. If any STOP condition
> occurs, stop immediately and report. Do not improvise around obstacles.
> One override: SKIP the plan's instruction to update `.plans/README.md` —
> your reviewer maintains the index. Before reporting, audit every claim in
> your report against an actual tool result from this session — report only
> what you can point to evidence for; if a verification failed or was
> skipped, say so plainly. When finished, reply with exactly the report
> format below.

```
STATUS: COMPLETE | STOPPED
STEPS: per step — done/skipped + verification command result
STOPPED BECAUSE: (only if STOPPED) which STOP condition, what was observed
FILES CHANGED: list
NOTES: anything the reviewer should know (deviations, surprises, judgment calls)
```

### Review

Review against the spec, never fixing anything yourself:

1. Re-run every done criterion in the working tree. Do not trust the report.
2. `git diff --stat` against the in-scope list. Anything outside scope fails review, full stop.
3. Read the full diff against "Why this matters" and the conventions the plan named.
4. Read what the new tests assert. Executors game criteria — a test that asserts nothing still passes.

### Verdict

**Documented deviations are judged on merit.** "Do not improvise" exists to stop silent drift; an executor that hits a real obstacle, adapts minimally and explains it in NOTES did the right thing. Approve it if the adaptation serves the intent and stays in scope. *Undocumented* deviation is a review failure.

| Verdict | When | Action |
|---|---|---|
| **APPROVE** | Criteria pass, scope clean, quality holds | Mark DONE in the index. Show the user a diff summary and anything from NOTES — **the user decides whether and how to apply it.** |
| **REVISE** | Fixable gaps | New `worker` dispatch with the report plus specific feedback ("criterion 3 fails: X; `api.ts:90` swallows the error — use the Result pattern per the plan"). Max 2 rounds, then BLOCK. |
| **BLOCK** | STOP hit, scope violated beyond repair, or rounds exhausted | Mark BLOCKED with the reason, refine or rewrite the plan with what was learned, and tell the user what changed. |

Edits land in your own working tree — there is no sandbox. Running verification is reviewing, not implementing: your hands still never edit source outside `.plans/`.

---

## `reconcile` — keep `.plans/` alive

Read the index and every plan, then per status:

- **DONE** — spot-check that the cheap done criteria still hold on HEAD; mark verified. Never delete plan files — they are the record.
- **BLOCKED** — read the reason, investigate the obstacle. Rewrite around it (new number if the approach changed fundamentally, in-place refresh otherwise) or mark REJECTED with one line.
- **IN PROGRESS** and stale — flag it; an executor probably died mid-run.
- **TODO** — run the drift check. Drifted: re-verify the finding still exists (it may have been fixed in passing), then refresh "Current state" and `Planned at`. Finding gone: mark REJECTED ("fixed independently").

Finish with a short report: verified done, refreshed, rejected, and what is executable now.

---

## `--issues` — publish plans as GitHub issues

The flag is the user's authorization; never create issues without it.

1. Preflight `gh auth status` and a GitHub remote. Either failing → write the plan files as normal and say why issues were skipped.
2. `gh repo view --json visibility`. If public, warn that issues are publicly visible and get explicit confirmation before publishing any plan that describes a vulnerability, a credential location or another sensitive finding.
3. Show the titles about to become issues; confirm once if interactive.
4. Per plan: `gh issue create --title "<plan title>" --body-file <plan file>`. Label `improve` plus the category, applying labels only if they exist or can be created without erroring.
5. Record each URL in the plan's Status block and in the index.

The plan file stays the source of truth; the issue is distribution. Self-containment is what makes the issue body usable as-is by whoever picks it up.
