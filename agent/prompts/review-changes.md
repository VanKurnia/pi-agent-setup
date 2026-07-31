---
description: Review all changes via ocr_review, then inspect flagged hunks with git_diff for correctness and edge cases.
---

1. **Automated review** — Run `ocr_review` on the current workspace to get AI-powered findings (bugs, security, reliability).
2. **Manual follow-up** — Use `git_diff` on specific files flagged by OCR or for deeper hunk-level inspection of concerns.
3. **Classify findings** — High (bugs/security) → fix, Medium → report with context, Low → discard.

Review every flagged hunk systematically:

1. **Correctness** — Does the logic handle normal paths, empty states, and error cases?
2. **Edge cases** — Any off-by-one, null/undefined, race conditions, or type mismatches?
3. **Side effects** — Could this break callers, leak resources, or violate invariants?
4. **Consistency** — Does it match surrounding code style, conventions, and patterns?

If OCR found no issues and manual inspection confirms, state explicitly.
