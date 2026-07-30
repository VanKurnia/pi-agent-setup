---
name: open-code-review
description: >
  Performs AI-powered code review on Git changes using Open Code Review
  (`ocr`). Use when the user asks to review current changes, staged or
  unstaged changes, a pull request, a branch comparison, a commit, or to
  review and fix high-confidence issues. Produces line-level review
  comments. Follows the official Open Code Review agent integration
  guidelines from alibaba/open-code-review/skills.
license: Apache-2.0
compatibility: >
  Requires the `ocr` CLI installed (via `npm install -g
  @alibaba-group/open-code-review` or GitHub release binary). OCR must have
  its own LLM provider configured before first use. The extension handles
  auto-install and LLM health checks on first use.
metadata:
  author: alibaba (ported to pi native tools)
  homepage: https://github.com/alibaba/open-code-review
  version: "1.0.0"
---

# Open Code Review for Pi

A skill for invoking [open-code-review](https://github.com/alibaba/open-code-review)
(`ocr`) via pi's native tools (`ocr_review`, `ocr_scan`, `ocr_health`).

## Workflow

### Step 1: Gather Business Context

Analyze the review target (commits, branch, or changes) and infer concise
business or requirement context. Pass this context via `background` parameter
to improve review quality.

### Step 2: Run Code Review

Choose the right tool based on what the user asked for:

| User intent | Tool to call |
|---|---|
| Review current workspace changes (staged+unstaged+untracked) | `ocr_review` (no args) |
| Review a branch against main | `ocr_review` with `from`/`to` |
| Review a single commit | `ocr_review` with `commit` |
| Preview files without LLM calls | `ocr_review` with `preview=true` |
| Review and fix safe issues | `ocr_review` first, then apply fixes |
| Audit whole files without a diff | `ocr_scan` with `path` |
| Add business or requirement context | `ocr_review`/`ocr_scan` with `background` |
| Check OCR status and LLM connectivity | `ocr_health` |

**Key rules:**
- **Always** pass business context via `background` when available
- Use `preview=true` to let the user see which files would be reviewed
  before consuming LLM tokens
- If `ocr_health` fails, guide the user to configure OCR's LLM provider

### Step 3: Classify Findings

For each comment from OCR output, classify by priority and report:

- **High**: Obvious bugs, security issues, clear mistakes, or well-founded
  suggestions with precise fix proposals. Always report.
- **Medium**: Reasonable concerns but context-dependent, style/performance
  suggestions, or fixes that require manual implementation. Report with
  context.
- **Low**: Likely false positives, lacking sufficient context, nitpicks, or
  meaningless suggestions. Discard silently unless the user asks for all
  comments.

### Step 4: Fix Only When Requested

Only modify files when the user explicitly requested fixing (e.g.,
"review and fix", "fix the high priority issues").

When fixing:
- Focus on High and Medium priority items
- Apply fixes directly to the code when safe and well-defined
- For complex fixes requiring manual intervention, clearly describe what
  needs to be done
- Always verify fixes with the user before committing

## Output Format

After filtering comments by priority, present results using this template:

```markdown
## Code Review Results

**Files reviewed**: N
**Issues found**: X high priority / Y medium priority

### High Priority

- **`path/to/file.java:42`** — Brief description
  > Recommendation: How to fix

### Medium Priority

- **`path/to/file.ts:88`** — Brief description
  > Recommendation: How to fix (if applicable)
```

If the review found no issues after filtering, simply state:
"Review complete — no issues found in N files."

## Custom Review Rules

If the user wants project-specific rules, OCR resolves them in this order:

1. `--rule <path>` flag via `ocr_review`/`ocr_scan` (not yet exposed as a
   parameter; run via bash if needed)
2. `<repo>/.opencodereview/rule.json`
3. `~/.opencodereview/rule.json`
4. Built-in system defaults (lowest)
