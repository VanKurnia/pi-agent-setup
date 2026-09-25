---
name: open-code-review
description: >
  Performs AI-powered code review on Git changes using Open Code Review
  (`ocr`). Use when the user asks to review code, review a pull request,
  review staged/unstaged changes, review a commit, or compare branches for
  code quality issues. Produces line-level review comments and can apply
  fixes when requested. With appropriate review rules, can detect bugs,
  security vulnerabilities, performance problems, and code quality concerns.
  Follows the official Open Code Review agent integration guidelines from
  alibaba/open-code-review/skills.
disable-model-invocation: true
license: Apache-2.0
compatibility: >
  Requires the `ocr` CLI installed (via `npm install -g
  @alibaba-group/open-code-review` or GitHub release binary). Requires a
  configured supported LLM provider before first run (protocols: Anthropic,
  OpenAI Chat Completions, OpenAI Responses, AWS Bedrock). The pi extension
  wraps the CLI as native tools (`ocr_review`, `ocr_scan`, `ocr_health`) and
  checks LLM health via `ocr llm test` on first use.
metadata:
  author: alibaba (ported to pi native tools)
  homepage: https://github.com/alibaba/open-code-review
  version: "1.0.0"
---

# Open Code Review for Pi

A skill for invoking [open-code-review](https://github.com/alibaba/open-code-review)
(`ocr`) via pi's native tools (`ocr_review`, `ocr_scan`, `ocr_health`).
The extension spawns the `ocr` binary directly (shell:false), always passes
`--audience agent`, and uses `--format json` for machine-readable output.

Upstream also ships `open-code-review-delegate` (host agent drives the review,
OCR only does file selection + rule resolution, no OCR-side LLM needed). That
mode is not wrapped as a native tool — run `ocr delegate preview/rule` via bash
if you need it.

## Workflow

### Step 1: Gather Business Context

Analyze the review target (commits, branch, or changes) to extract concise
business or requirement context. `ocr_review` takes `background` (→ `--background`/`-b`) or `background_file`
(→ `--background-file`/`-B`, takes precedence); `ocr_scan` takes `background`
only (its CLI has no `-B` flag).

### Step 2: Run Code Review

**Do not pre-check whether `ocr` is installed** — skip probes like `command -v ocr`
or `ocr --version`. Assume the CLI is available and call the native tool directly.
Only if the tool reports `command not found` should you install it per
Troubleshooting.

Choose the right tool based on what the user asked for:

| User intent | Tool to call |
|---|---|
| Review current workspace changes (staged+unstaged+untracked) | `ocr_review` (no args) |
| Review a branch against main | `ocr_review` with `from`/`to` |
| Review a single commit | `ocr_review` with `commit` |
| Resume an interrupted range/commit review | `ocr_review` with `from`/`to` or `commit` plus `resume` |
| Preview files without LLM calls | `ocr_review` with `preview=true` |
| Review and fix safe issues | `ocr_review` first, then apply fixes |
| Audit whole files without a diff | `ocr_scan` with `path` |
| Scan the entire repository | `ocr_scan` (no args) |
| Long review/scan without blocking | `ocr_review`/`ocr_scan` with `runInBackground: true` → job ID; poll `ocr_job_status` |
| Poll a finished/running job | `ocr_job_status` (`id` optional = list; `tailLines` capped at 100) |
| Stop a job | `ocr_job_cancel` with `id` (required) |
| Add business or requirement context | `ocr_review` with `background` or `background_file`; `ocr_scan` with `background` |
| Check OCR status and LLM connectivity | `ocr_health` |

**Key rules:**

- **Always** pass business context via `background` when available.
- Use `preview=true` to let the user see which files would be reviewed
  before consuming LLM tokens.
- If `ocr_health` fails or a review reports an LLM connection error, guide the
  user to configure OCR's LLM provider (see Troubleshooting). Never invent or
  hardcode API keys.
- On non-zero exit, do not retry blindly — consult Troubleshooting first.
- For long runs prefer `runInBackground: true`, then poll — never ask for full logs; the status tail is the default view. Max 3 concurrent jobs.
- A live `ocr` widget shows running jobs above the editor (same style as the subagents widget); it clears as jobs finish. Headless runs have no widget — poll instead.

Native-tool to CLI flag mapping (most common):

- `background` → `--background` (`ocr_review` + `ocr_scan`), `background_file` → `--background-file` (`ocr_review` only)
- `commit` → `--commit` / `-c`, `from`/`to` → `--from` / `--to`
- `resume` → `--resume`, `repo` → `--repo`
- `exclude` → `--exclude '<patterns>'` (comma-separated gitignore-style, merged
  with `rule.json` excludes)
- `model` → `--model` (per-run override; `ocr llm providers` lists built-ins)
- `concurrency` → `--concurrency` (default 8 file workers; lower on rate limits)
- `timeoutMinutes` → `--timeout` (effective timeout per group = timeout × rounds;
  default timeout 15 with effort `medium` (2 rounds) = 30 min)
- `maxTools` → `--max-tools`, `maxGitProcesses` → `--max-git-procs`
- `preview` → `--preview` / `-p`
- `ocr_scan`: `path` → `--path`, `batch` → `--batch none|by-language|by-directory`,
  `no_plan` → `--no-plan`, `no_dedup` → `--no-dedup`, `no_summary` → `--no-summary`,
  `resume` → `--resume`, `maxGitProcesses` → `--max-git-procs`, `provider` → `--provider`,
  `rule` → `--rule`, `tools` → `--tools`, `maxTokens` → `--max-tokens`,
  `maxTokensBudget` → `--max-tokens-budget`, `output` → `--output`

Not exposed as native parameters by design — the wrapper forces `--audience agent`
+ `--format json`; run via bash if needed: `--format text|sarif`, `--color` (`--rule`,
`--provider`, `--max-tokens`, `--max-tokens-budget`, `--no-filter` review-only and `--output`
are native params after Steps 2–3).

**Prevent output truncation:** for large reviews, inspect the full tool result.
Never pipe CLI output through `tail`/`head` — it drops earlier comments. Via bash,
prefer `ocr review --output /tmp/ocr_out.txt` and read the file in full.

### Step 3: Report

OCR output includes structured `severity` (critical / high / medium / low) and
`category` (bug / security / performance / maintainability / test / style /
documentation / other) on each comment. Present results grouped by severity,
discarding `low` severity items that are likely false positives or nitpicks:

- **Critical/High**: bugs, security issues, data-loss risks, clear mistakes —
  always report.
- **Medium**: reasonable but context-dependent concerns, performance /
  maintainability suggestions — report with context.
- **Low**: likely false positives, nits, style-only — discard silently unless
  the user asks for all comments.

### Step 4: Fix Only When Requested

Before applying fixes, check whether the user requested automatic fixes:

- If the user explicitly requested "review and fix" or similar, proceed.
- If the user only requested "review", ask for permission before changing code.

When fixing:

- Focus on critical, high, and medium severity items.
- Apply fixes directly to the code when safe and well-defined.
- For complex fixes requiring manual intervention, clearly describe what
  needs to be done.
- Always verify fixes with the user before committing.

## Output Format

Each comment in OCR's output contains:

- `path`: file path
- `content`: review comment text
- `start_line` / `end_line`: line range (both 0 means positioning failed)
- `category`: bug, security, performance, maintainability, test, style,
  documentation, other
- `severity`: critical, high, medium, low
- `suggestion_code`: optional fix suggestion
- `existing_code`: optional original snippet
- `thinking`: optional LLM reasoning

Present results grouped by severity using this template:

```markdown
## Code Review Results

**Files reviewed**: N
**Issues found**: X critical, Y high, Z medium

### Critical

- **`path/to/file.java:42`** [bug] — Brief description
  > Recommendation: How to fix

### High

- **`path/to/file.java:26`** [bug] — Brief description
  > Recommendation: How to fix

### Medium

- **`path/to/file.ts:88`** [performance] — Brief description
  > Recommendation: How to fix (if applicable)
```

If no critical, high, or medium severity issues remain after filtering, state:
"Review complete — no critical, high, or medium issues found in N files."

**Handling mispositioned comments:** when `start_line` and `end_line` are both
`0`, the comment failed to locate its exact position. Read the comment content,
examine the target file, identify the relevant section from context, then fix
the correct location.

## Custom Review Rules

If the user wants project-specific rules, OCR resolves them in this priority order:

1. `--rule <path>` flag (highest; not exposed as a native-tool parameter —
   run via bash if needed)
2. `<repo>/.opencodereview/rule.json`
3. `~/.opencodereview/rule.json`
4. Built-in system defaults (lowest)

By default, the first matching user rule replaces the built-in system rule. Set
`merge_system_rule: true` on a rule entry when both should apply.

Rule file format:

```json
{
  "rules": [
    {
      "path": "**/*.java",
      "rule": "All new methods must validate required parameters for null",
      "merge_system_rule": true
    },
    {
      "path": "**/*mapper*.xml",
      "rule": "Check SQL for injection risks and missing closing tags"
    }
  ]
}
```

To preview which rule applies to a file before reviewing (via bash):

```bash
ocr rules check src/main/java/com/example/Foo.java
```

## Gotchas

- **LLM must be configured first** — review/scan fail loudly if no LLM is
  reachable. See Troubleshooting.
- **Working directory matters** — tools operate on the Git repo at the current
  directory. Use `repo` to run from elsewhere.
- **Untracked files are reviewed in workspace mode** — bare `ocr_review`
  includes staged, unstaged, *and* untracked changes. Stage selectively for
  narrower scope.
- **Large diffs may hit token limits** — prompt budget `MAX_TOKENS` (`200000` in
  the review template; `58888` for scan); output capped by `MAX_COMPLETION_TOKENS`
  (`16384`). A file whose diff alone exceeds ~80% of `MAX_TOKENS` is skipped
  before the LLM call.
- **Plan phase adds latency but improves quality** — a group runs an extra
  risk-analysis phase when its largest changed file reaches
  `PLAN_MODE_LINE_THRESHOLD` (default `50`) or it holds 2+ files whose combined
  changed lines reach `PLAN_MODE_GROUP_LINE_THRESHOLD` (default `100`).
- **Comment language follows config** — `language` controls it, defaults to
  `English`, accepts any language name.
- **Resume an interrupted review** — range/commit reviews print
  `retry with: --resume <id>` on failure (or find it via `ocr session list`).
  Pass it as `resume`. Workspace resume is not supported.

## Validation

After the review completes, verify success by checking:

1. The tool/CLI exited with code 0.
2. Comments were generated (or a "No comments generated" message appears).
3. Warnings (if any) are displayed in stderr.

If errors occurred, check stderr for which files failed and why.

## Troubleshooting

**`ocr: command not found`**

Install the CLI:

```bash
npm install -g @alibaba-group/open-code-review
```

**LLM connection error**

Prompt the user to configure an LLM provider. Interactive setup (recommended):

```bash
ocr config provider
ocr config model
```

Manual alternative:

```bash
ocr config set llm.url https://api.anthropic.com/v1/messages
ocr config set llm.auth_token <api-key>
ocr config set llm.model claude-opus-4-6
ocr config set llm.use_anthropic true
```

Verify with `ocr llm test` (or the `ocr_health` native tool). Stop here and ask
the user for credentials — never invent or hardcode API keys.

## References

- Full docs: https://github.com/alibaba/open-code-review
- NPM package: https://www.npmjs.com/package/@alibaba-group/open-code-review
- Issue tracker: https://github.com/alibaba/open-code-review/issues
