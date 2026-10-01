/**
 * Open Code Review — TypeBox parameter schemas for the three tools.
 */

import { Type } from "typebox";

const optionalString = (description: string) => Type.Optional(Type.String({ description }));
const optionalPosInt = (description: string) =>
    Type.Optional(Type.Integer({ description, minimum: 1 }));
const optionalBool = (description: string) => Type.Optional(Type.Boolean({ description }));

const reviewParams = Type.Object({
    commit: optionalString("Review one commit against its parent."),
    from: optionalString("Base ref for a branch/range comparison. Must be paired with 'to'."),
    to: optionalString("Target ref for a branch/range comparison. Must be paired with 'from'."),
    resume: optionalString("Resume a previous OCR review session by ID."),
    background: optionalString(
        "Business or requirement context that the implementation should satisfy.",
    ),
    background_file: optionalString("Path to a Markdown file used as review background."),
    repo: optionalString(
        "Root directory of the git repository (default: current working directory).",
    ),
    exclude: optionalString("Comma-separated gitignore-style exclusion patterns."),
    model: optionalString("Override the LLM model for this review (e.g., claude-opus-4-6)."),
    concurrency: optionalPosInt("Maximum concurrent file reviews."),
    timeoutMinutes: optionalPosInt("Per-file OCR timeout in minutes."),
    maxTools: optionalPosInt("Maximum tool-call rounds per file (OCR enforces a minimum of 50)."),
    maxGitProcesses: optionalPosInt("Maximum concurrent Git subprocesses."),
    effort: optionalString("Review effort preset: low | medium | high (default medium)."),
    provider: optionalString("Override the configured LLM provider for this run."),
    rule: optionalString("Path to JSON file with system review rules."),
    tools: optionalString("Path to JSON tools config file."),
    maxTokens: optionalPosInt("Per-group prompt token ceiling (unset = template default)."),
    maxTokensBudget: optionalPosInt("Cap total token usage for this review (unset = unlimited)."),
    noFilter: optionalBool("Keep all review comments without LLM post-filtering."),
    output: optionalString("Write results to a UTF-8 file instead of stdout."),
    preview: optionalBool("List files that would be reviewed without calling an LLM."),
});

const scanParams = Type.Object({
    path: optionalString("Comma-separated repo-relative dirs/files to scan (default: whole repo)."),
    exclude: optionalString("Comma-separated gitignore-style patterns to exclude."),
    model: optionalString("Override the LLM model for this scan."),
    background: optionalString("Business or requirement context for the scan."),
    repo: optionalString(
        "Root directory of the git repository (default: current working directory).",
    ),
    no_plan: optionalBool("Skip the per-file PLAN_TASK pre-pass (faster, less focused)."),
    no_dedup: optionalBool("Skip per-batch DEDUP_TASK (keeps raw comments)."),
    no_summary: optionalBool("Skip the post-run PROJECT_SUMMARY_TASK."),
    batch: optionalString('Override BATCH_STRATEGY: "none" | "by-language" | "by-directory".'),
    concurrency: optionalPosInt("Max concurrent file scans."),
    timeoutMinutes: optionalPosInt("Per-file timeout in minutes."),
    maxTools: optionalPosInt("Max tool call rounds per file."),
    resume: optionalString("Resume a previous scan session by ID."),
    maxGitProcesses: optionalPosInt("Maximum concurrent Git subprocesses."),
    provider: optionalString("Override the configured LLM provider for this scan."),
    rule: optionalString("Path to JSON file with system review rules."),
    tools: optionalString("Path to JSON tools config file."),
    maxTokens: optionalPosInt("Per-file prompt token ceiling (unset = template default)."),
    maxTokensBudget: optionalPosInt("Cap total token usage for this scan (unset = unlimited)."),
    output: optionalString("Write results to a UTF-8 file instead of stdout."),
    preview: optionalBool("Preview which files would be scanned without calling an LLM."),
});

const healthParams = Type.Object({});

export { reviewParams, scanParams, healthParams };
