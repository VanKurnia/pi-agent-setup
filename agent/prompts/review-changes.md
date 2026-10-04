---
description: Review code changes using ocr_review or ocr_scan, then inspect flagged hunks with git diff for correctness and edge cases.
argument-hint: "[path|branch-range|commit]"
---

Target Scope: ${@:-whole workspace}.

## Execution Workflow

1. **Select Review Tool by Scope**:
   - **Workspace diff (no arguments or "whole workspace")**: Call `ocr_review({})` to review all current uncommitted changes (staged + unstaged + untracked).
   - **Specific commit (`<sha>`)**: Call `ocr_review({ commit: "<sha>" })`.
   - **Branch or commit range (`<from>..<to>`)**: Call `ocr_review({ from: "<from>", to: "<to>" })`.
   - **Specific file or directory path**:
     - `ocr_review` is diff-based across the repo. To review changes with emphasis on a path, run `ocr_review({ background: "Focus review on changes under <path>" })` and filter findings to that path; OR
     - To audit whole files under that directory regardless of diff, run `ocr_scan({ path: "<path>" })`.
   - **Plan file (`NNN` or `.plans/NNN-*.md`)**: Read the plan file first, then review the files referenced within it.

2. **Terminal Inspection**:
   - If findings or flagged files require detailed hunk inspection, run `git diff` via your shell tool (`powershell` on Windows or `bash` on Unix). Do not call `git diff` as a tool name.

3. **Triage Findings**:
   - **High** (bugs, security flaws, clear breakage) → report and fix if requested.
   - **Medium** (valid concerns, edge cases, questionable patterns) → report with file and line numbers.
   - **Low** (stylistic nits, false positives) → discard silently.

4. **Systematic Review Checklist**:
   - **Correctness** — Normal paths, boundary conditions, empty/nil states, and error handling.
   - **Edge cases** — Off-by-one, null/undefined, race conditions, type mismatches.
   - **Side effects** — Breaking callers, resource leaks, or violating invariants.
   - **Consistency** — Adherence to surrounding conventions and architecture.

If OCR reports no findings and manual inspection confirms, state explicitly that changes look clean.
