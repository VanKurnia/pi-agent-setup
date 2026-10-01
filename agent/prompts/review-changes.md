---
description: Review all changes via ocr_review, then inspect flagged hunks with git_diff for correctness and edge cases.
argument-hint: "[path|workpackage|branch-range]"
---

Scope: ${@:-whole workspace}.

## Scope

| Argument                           | Runs                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| (none)                             | `ocr_review` — workspace diff (staged + unstaged + untracked)                                                                                   |
| dir or file path                   | `ocr_scan` with `path` — `ocr review` is diff-based and has no path flag; alternatively run `ocr_review` and keep only findings under that path |
| `NNN` or `.plans/NNN-*.md`         | read the plan file, then review the files it lists                                                                                              |
| `a..b`, branch name, or commit sha | `ocr_review` with `from`/`to`, or `commit` for a single commit                                                                                  |

- Multiple arguments: review each scope, merge findings into one report.
- Nonexistent path or ref: report it, skip it. Do not guess alternatives.

1. **Automated review** — Run `ocr_review` on the current workspace to get AI-powered findings (bugs, security, reliability).
2. **Manual follow-up** — Use `git_diff` on specific files flagged by OCR or for deeper hunk-level inspection of concerns.
3. **Classify findings** — High (bugs/security) → fix, Medium → report with context, Low → discard.

Review every flagged hunk systematically:

1. **Correctness** — Does the logic handle normal paths, empty states, and error cases?
2. **Edge cases** — Any off-by-one, null/undefined, race conditions, or type mismatches?
3. **Side effects** — Could this break callers, leak resources, or violate invariants?
4. **Consistency** — Does it match surrounding code style, conventions, and patterns?

If OCR found no issues and manual inspection confirms, state explicitly.
