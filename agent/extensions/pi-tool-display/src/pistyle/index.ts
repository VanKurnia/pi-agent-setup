/**
 * Merged 2026-09-30 from per-module sources (see FORK.md). This file is now the source of truth - edit it directly.
 * Merged to cut boot cost: jiti pays ~19ms per module regardless of size.
 */
import {
    BoxTheme,
    ESC,
    dimLine,
    safeTruncateToWidth,
    boxedToolWidthKey,
    clearCompactBoxedFooter,
    formatBoxedFooter,
    getTextOutput,
    renderCompactBoxedFooter,
    renderCompactBoxedToolCall,
    resolveRelativePath,
    shortenPath,
    themeCacheKey,
    formatElapsedMetric,
    renderBoxedToolResult,
    renderBoxedToolCall,
    RUNNING_TITLE_GLYPH,
    boxBlankLine,
    boxFrameColor,
    boxLabeledBorder,
    boxWidth,
    AdaptiveDiffComponent,
    buildSplitRows,
    countDiffStats,
    stripAnsi,
    formatBoxedRunningStatus,
    formatBoxedWords,
    formatToolOutputLine,
    replaceTabs,
    clampRenderLine,
    formatToolTitlePrefix,
    getElapsedMs,
    extractEditedPath,
    firstText,
    MetricResultLike,
    formatToolName,
    formatToolParamLines,
    selectRenderLines,
} from "./shared/index.js";
import { Component } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";

// from: pistyle\features\tools\boxed\command-shape.ts

// Simple bash command shape detection, shared by the bash tool renderer and
// the git/gh semantic classifiers.
//
// A command is "simple" when pi-style can reason about it purely from its
// token list: single line, no shell metacharacters (pipes, redirects,
// substitutions), and no `&&`/`;`/`&` outside a leading `cd X &&` chain.
// Anything ambiguous returns null so the boxed command/response shell stays
// the fallback (ADR 0005 — no approximate rendering).
/** Tokens of a classifiable command after env/prefix/cd-chain stripping. */
interface SimpleBashCommandShape {
    /** Tokens after leading env assignments, prefix commands, and `cd X &&` chains. */
    readonly tokens: string[];
    /** Last directory from a leading `cd <dir> &&` / `cd <dir>;` chain. */
    readonly cdDir?: string;
}
const BASH_PREFIX_COMMANDS = new Set([
    "sudo",
    "env",
    "time",
    "nice",
    "nohup",
    "command",
    "stdbuf",
    "ionice",
    "watch",
]);
// Pipes (`|`), `;`, and `&` are excluded here: the classifier validates them
// explicitly (allowing `cd X && cmd` chains and a trailing `| head/tail`).
const BASH_SHELL_META_CHARS = new Set(["<", ">", "(", ")", "`"]);
/** Tokenize a single command line, stripping quotes. Returns null on an
 *  unterminated quote. `hasMeta` is true if any shell metacharacter appears
 *  *outside* quotes (so `grep 'a|b' f` stays classifiable). */
function tokenizeCommandLine(line: string): { tokens: string[]; hasMeta: boolean } | null {
    const tokens: string[] = [];
    let current = "";
    let inToken = false;
    let quote: string | null = null;
    let hasMeta = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i] ?? "";
        if (quote) {
            if (char === "\\" && quote === '"') {
                current += line[++i] ?? "";
                continue;
            }
            if (char === quote) {
                quote = null;
                continue;
            }
            current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            inToken = true;
            continue;
        }
        if (char === " " || char === "\t") {
            if (inToken) {
                tokens.push(current);
                current = "";
                inToken = false;
            }
            continue;
        }
        if (BASH_SHELL_META_CHARS.has(char) || (char === "$" && (line[i + 1] ?? "") === "(")) {
            hasMeta = true;
            continue;
        }
        current += char;
        inToken = true;
    }
    if (quote) return null;
    if (inToken) tokens.push(current);
    return { tokens, hasMeta };
}
/** `head [-n N]` / `tail [-n N]` truncation pipe tail (allowed at the end). */
function isHeadOrTailTail(tokens: readonly string[]): boolean {
    if (tokens.length === 0 || (tokens[0] !== "head" && tokens[0] !== "tail")) return false;
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i] ?? "";
        if (token === "-n") continue;
        if (/^\d+$/.test(token)) continue;
        if (/^-\d+$/.test(token)) continue;
        return false;
    }
    return true;
}
/**
 * Tokenize a single-line bash command and verify it is simple enough to
 * classify: no shell metacharacters (`<`, `>`, `(`, `)`, backtick, `$(`), no
 * `&&`/`;`/`&` outside a leading `cd X &&` chain, and — unless
 * `allowTrailingTruncationPipe` — no pipes at all. Returns null for anything
 * ambiguous so callers fall back to the boxed shell. Newlines and unterminated
 * quotes are rejected.
 */
function parseSimpleBashCommand(
    command: string,
    options: { allowTrailingTruncationPipe?: boolean } = {},
): SimpleBashCommandShape | null {
    const commandText = String(command ?? "").trim();
    if (!commandText || commandText.includes("\n")) return null;
    const tokenized = tokenizeCommandLine(commandText);
    if (!tokenized || tokenized.hasMeta || tokenized.tokens.length === 0) return null;
    let tokens = tokenized.tokens;
    if (options.allowTrailingTruncationPipe) {
        // Allow a single trailing truncation pipe: `cmd | head [-n] N` / `| tail …`.
        const pipes = tokens.flatMap((token, i) => (token === "|" ? [i] : []));
        if (pipes.length > 0) {
            if (pipes.length > 1) return null;
            const last = pipes[0] ?? -1;
            if (!isHeadOrTailTail(tokens.slice(last + 1))) return null;
            tokens = tokens.slice(0, last);
        }
    } else if (tokens.includes("|")) {
        // git/gh classification keeps the pipe rule strict (ADR 0005): any pipe
        // falls back to the raw boxed shell.
        return null;
    }
    let index = 0;
    // Skip leading environment assignments (FOO=bar ...) and prefix commands.
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
    while (index < tokens.length && BASH_PREFIX_COMMANDS.has(tokens[index] ?? "")) index++;
    // `cd <dir> &&` / `cd <dir>;` chains: the last directory becomes the default
    // path when the command itself carries none.
    let cdDir: string | undefined;
    while (
        tokens[index] === "cd" &&
        index + 2 < tokens.length &&
        tokens[index + 1] !== undefined &&
        (tokens[index + 2] === "&&" || tokens[index + 2] === ";")
    ) {
        cdDir = tokens[index + 1];
        index += 3;
    }
    const rest = tokens.slice(index);
    if (rest.length === 0 || rest.some((token) => token === "&&" || token === ";" || token === "&"))
        return null;
    return { tokens: rest, ...(cdDir !== undefined ? { cdDir } : {}) };
}

// from: pistyle\features\tools\boxed\output-tree.ts

// Boxless output-tree primitives shared by the ls/find/grep/bash renderers.
//
// ls/find/grep and bash `ls/find/grep/rg` results render their parsed output as
// a **boxless tree panel** — a summary header line followed by `├─/└─` rows —
// instead of a boxed command/response shell. This module owns:
//
// - output parsers that turn native tool text (entries, paths, `file:line:`
//   match lines) into structured records, dropping trailing truncation notices;
// - `renderOutputTree`, which lays out a flat list of entries under a header
//   (used by lone ls/find and bash ls/find);
// - `renderGrepTree`, which lays out grep matches grouped by file (used by grep
//   and bash grep/rg).
//
// Design notes:
// - Pure + theme-consuming: no filesystem, no global state, no caching (callers
//   cache at the component boundary).
// - Every row is width-safe via safeTruncateToWidth; the header is never
//   truncated by this layer (callers pass a concise, pre-sized header).
// - Tree indent matches the quiet-tool batch panel (`  ├─`) so the panels read
//   as one visual family.
/** Indent for top-level tree rows; matches the quiet-tool batch panel. */
const TREE_INDENT = "  ";
/** Extra indent for rows nested under a grouping node. */
const TREE_CHILD_INDENT = "  ";
/** Default number of entries/matches shown before collapsing to "… N more". */
const OUTPUT_TREE_HEAD_LIMIT = 6;
// ── Nerd Font file-type icons ───────────────────────────────────────────────
// Only used when the session glyph mode is nerd (see withIcons). Unicode/ASCII
// modes render plain entries.
const FILE_ICON_FOLDER = "\u{F415}"; //  (nf-md-folder)
const FILE_ICON_DEFAULT = "\u{E612}"; //  (nf-seti-default)
/** Search (magnifying-glass) icon for find/grep headers (nf-fa-search). */
const SEARCH_ICON = "\u{F002}";
const FILE_ICONS: Readonly<Record<string, string>> = {
    ts: "\u{E628}", //  (nf-seti-typescript)
    tsx: "\u{E7BA}", //  (nf-seti-react)
    js: "\u{E62C}", //  (nf-seti-javascript)
    jsx: "\u{E7BA}", //  (nf-seti-react)
    mjs: "\u{E62C}",
    cjs: "\u{E62C}",
    json: "\u{E62B}", //  (nf-seti-json)
    md: "\u{E609}", //  (nf-seti-markdown)
    mdx: "\u{E609}",
    css: "\u{E749}", //  (nf-seti-css)
    scss: "\u{E749}",
    sass: "\u{E749}",
    less: "\u{E749}",
    html: "\u{E60E}", //  (nf-seti-html)
    htm: "\u{E60E}",
    py: "\u{E606}", //  (nf-seti-python)
    go: "\u{E627}", //  (nf-seti-go)
    rs: "\u{E7A8}", //  (nf-seti-rust)
    sh: "\u{E795}", //  (nf-seti-shell)
    bash: "\u{E795}",
    zsh: "\u{E795}",
    fish: "\u{E795}",
    yml: "\u{E615}", //  (nf-seti-yaml)
    yaml: "\u{E615}",
    toml: "\u{E615}",
    java: "\u{E738}", //  (nf-seti-java)
    c: "\u{E61E}", //  (nf-seti-c)
    h: "\u{E61E}",
    cpp: "\u{E61E}",
    hpp: "\u{E61E}",
    cs: "\u{E61E}",
    svg: "\u{E62A}", //  (nf-seti-svg)
    png: "\u{E61D}", //  (nf-seti-image)
    jpg: "\u{E61D}",
    jpeg: "\u{E61D}",
    gif: "\u{E61D}",
    webp: "\u{E61D}",
    pdf: "\u{E67A}", //  (nf-seti-pdf)
    dockerfile: "\u{E7B0}", //  (nf-seti-docker)
    lock: "\u{E7B0}",
    gitignore: "\u{E702}", //  (nf-seti-git)
    gitattributes: "\u{E702}",
    vue: "\u{ED43}", //  (nf-vue)
    svelte: "\u{E697}",
};
/** Nerd Font file-type icon for a path, or "" when not applicable. */
function fileIcon(path: string): string {
    if (path.endsWith("/")) return FILE_ICON_FOLDER;
    const name = path.split("/").pop() ?? path;
    const lower = name.toLowerCase();
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
    return FILE_ICONS[ext] ?? FILE_ICONS[lower] ?? FILE_ICON_DEFAULT;
}
/** Lines produced by these native tools to signal truncation (already in the
 *  output text, not separate metadata). Dropped before parsing. */
const NOTICE_LINE_PATTERN = /^\[[^\]]*\]$/;
/** A parsed grep match line. Context lines are not surfaced in the tree. */
interface GrepMatch {
    readonly file: string;
    readonly line: number;
    readonly content: string;
}
/** Drop trailing tool notices (`[Showing last …]`, `[Truncated: …]`) and blanks. */
function stripNotices(text: string): string[] {
    return text
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0 && !NOTICE_LINE_PATTERN.test(line.trim()));
}
/**
 * Parse native `ls` output into display entries. Directories keep their `/`
 * suffix; the `(empty directory)` placeholder and truncation notices are
 * removed. Output is already sorted alphabetically by the tool.
 */
function parseLsOutput(rawText: string): string[] {
    return stripNotices(rawText)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== "(empty directory)");
}
/**
 * Parse `ls -l`/`ls -la` long-format output into display entries: the entry
 * name is the text after the time column; directory names get a trailing `/`.
 * The `total N` summary and `.`/`..` entries are dropped. Standard POSIX
 * columns: perms links owner group size month day time name. macOS `@`/`+`
 * permission suffixes are tolerated.
 */
function parseLsLongOutput(rawText: string): string[] {
    const entries: string[] = [];
    for (const line of stripNotices(rawText)) {
        if (!/^[bcdlsp-][rwxtsST-]{9}/.test(line)) continue;
        const parts = line.split(/\s+/);
        const name = parts.slice(8).join(" ").trim();
        if (!name || name === "." || name === "..") continue;
        const isDir = (parts[0] ?? "").startsWith("d");
        entries.push(isDir ? `${name}/` : name);
    }
    return entries;
}
/**
 * Parse native `find` output into display paths (one per line). Notices are
 * removed. The native tool returns paths relative to the search directory.
 */
function parseFindOutput(rawText: string): string[] {
    return stripNotices(rawText)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
// Match line:  path/to/file.ts:42:  matched content   (Pi grep adds a space;
// ripgrep/grep emit no space). Context lines (path-line- …) are dropped.
const GREP_MATCH_PATTERN = /^(.*):(\d+):[ \t]?(.*)$/;
// Single-file ripgrep/grep output: `42:  content` (no filename).
const GREP_BARE_PATTERN = /^(\d+):[ \t]?(.*)$/;
/**
 * Parse native `grep` output into match records. Only real match lines
 * (`file:line: content`) are kept; context lines (`file-line- …`) are dropped
 * so the tree stays focused on hits. Trailing notices are removed.
 */
function parseGrepOutput(rawText: string): GrepMatch[] {
    const matches: GrepMatch[] = [];
    for (const line of stripNotices(rawText)) {
        const match = GREP_MATCH_PATTERN.exec(line);
        if (!match) continue;
        const [, file, lineNo, content] = match;
        if (!file || lineNo === undefined || content === undefined) continue;
        const parsed = Number(lineNo);
        if (!Number.isFinite(parsed) || parsed < 1) continue;
        matches.push({ file, line: parsed, content });
    }
    return matches;
}
/**
 * Parse single-file grep/ripgrep output — `line: content` without a filename —
 * attributing every match to the given file. Used by bash `grep pattern file`.
 */
function parseGrepBareOutput(rawText: string, file: string): GrepMatch[] {
    const matches: GrepMatch[] = [];
    for (const line of stripNotices(rawText)) {
        const match = GREP_BARE_PATTERN.exec(line);
        if (!match) continue;
        const parsed = Number(match[1]);
        if (!Number.isFinite(parsed) || parsed < 1) continue;
        matches.push({ file, line: parsed, content: match[2] ?? "" });
    }
    return matches;
}
/** Group grep matches by file, preserving first-seen order. */
function groupMatchesByFile(
    matches: readonly GrepMatch[],
): { file: string; matches: GrepMatch[] }[] {
    const order: string[] = [];
    const buckets = new Map<string, GrepMatch[]>();
    for (const match of matches) {
        let bucket = buckets.get(match.file);
        if (!bucket) {
            bucket = [];
            buckets.set(match.file, bucket);
            order.push(match.file);
        }
        bucket.push(match);
    }
    return order.map((file) => ({ file, matches: buckets.get(file) ?? [] }));
}
interface OutputTreeOptions {
    /** Maximum entries shown before the "… N more" row. */
    headLimit?: number;
    /** Singular noun used in the collapse row (default "file"); pluralized automatically. */
    moreUnit?: string;
    /** Optional ANSI-themed color for entry text (defaults to "toolOutput"). */
    entryColor?: string;
    /** Indent prefix applied to every row (defaults to TREE_INDENT). */
    indent?: string;
    /** Nerd Font mode: prefix each entry with its file-type icon. */
    withIcons?: boolean;
}
/**
 * Render a flat output tree: `<header>` then `├─/└─` rows for the first entries
 * and a trailing `└─ … N more <unit>` row when truncated. Used by lone ls/find
 * (and bash ls/find).
 */
function renderOutputTree(
    theme: BoxTheme,
    header: string,
    entries: readonly string[],
    width: number,
    options: OutputTreeOptions = {},
): string[] {
    const headLimit = options.headLimit ?? OUTPUT_TREE_HEAD_LIMIT;
    const moreUnit = options.moreUnit ?? "file";
    const entryColor = options.entryColor ?? "toolOutput";
    const indent = options.indent ?? TREE_INDENT;
    const safeWidth = Math.max(1, width);
    const label = (entry: string) =>
        options.withIcons && entry ? `${fileIcon(entry)} ${entry}` : entry;
    const out: string[] = [safeTruncateToWidth(header, safeWidth, "…")];
    if (entries.length === 0) return out;
    const visible = entries.slice(0, headLimit);
    const more = entries.length - visible.length;
    const lastIndex = visible.length - 1;
    for (let i = 0; i < visible.length; i++) {
        const branch = i < lastIndex || more > 0 ? "├─" : "└─";
        const line = `${indent}${dimLine(branch)} ${theme.fg(entryColor, label(visible[i] ?? ""))}`;
        out.push(safeTruncateToWidth(line, safeWidth, "…"));
    }
    if (more > 0) {
        const line = `${indent}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm(moreUnit, more)}`)}`;
        out.push(safeTruncateToWidth(line, safeWidth, "…"));
    }
    return out;
}
interface GrepTreeOptions {
    /** Maximum matches shown (across all files) before the "… N more" row. */
    headLimit?: number;
    /** Indent prefix applied to top-level rows. */
    indent?: string;
    /** Nerd Font mode: prefix file nodes with their file-type icon. */
    withIcons?: boolean;
}
function formatMatchRow(theme: BoxTheme, match: GrepMatch): string {
    // Match rows render in the output text color (not primary) so they read like
    // the matched code; only the file nodes carry the primary color.
    const label = theme.fg("toolOutput", `*${match.line}`);
    const sep = dimLine("│");
    return `${label}${sep} ${theme.fg("toolOutput", match.content)}`;
}
/**
 * Render a grep matches tree: `<header>` then matches grouped by file. With a
 * single file the matches are direct children; with several files each file is
 * a `├─ file` node and its matches hang off an indented trunk beneath. A
 * trailing `└─ … N more matches` row appears when the match budget is exceeded.
 */
function renderGrepTree(
    theme: BoxTheme,
    header: string,
    matches: readonly GrepMatch[],
    width: number,
    options: GrepTreeOptions = {},
): string[] {
    const headLimit = options.headLimit ?? OUTPUT_TREE_HEAD_LIMIT;
    const indent = options.indent ?? TREE_INDENT;
    const safeWidth = Math.max(1, width);
    const out: string[] = [safeTruncateToWidth(header, safeWidth, "…")];
    if (matches.length === 0) return out;
    const groups = groupMatchesByFile(matches);
    const singleFile = groups.length === 1;
    // First decide which matches fit the budget so branch glyphs (├─ vs └─) and
    // the trailing "… N more" row stay consistent.
    const budget = matches.slice(0, headLimit);
    const remaining = matches.length - budget.length;
    const truncated = remaining > 0;
    const totalVisible = budget.length;
    const push = (line: string) => out.push(safeTruncateToWidth(line, safeWidth, "…"));
    if (singleFile) {
        budget.forEach((match, index) => {
            const isLast = index === totalVisible - 1 && !truncated;
            push(`${indent}${dimLine(isLast ? "└─" : "├─")} ${formatMatchRow(theme, match)}`);
        });
    } else {
        // Walk the budget, tracking position within each file group so the file
        // node and its match subtree render as one connected unit.
        let shown = 0;
        for (let gi = 0; gi < groups.length && shown < totalVisible; gi++) {
            const group = groups[gi];
            if (!group) continue;
            const isLastGroup = gi === groups.length - 1;
            const trunk = isLastGroup ? " " : dimLine("│");
            const visibleHere: GrepMatch[] = [];
            for (const match of group.matches) {
                if (shown >= totalVisible) break;
                visibleHere.push(match);
                shown++;
            }
            if (visibleHere.length === 0) continue;
            const groupIsLastRendered = shown >= totalVisible && !truncated;
            const fileLabel = options.withIcons
                ? `${fileIcon(group.file)} ${group.file}`
                : group.file;
            // File nodes use the primary (accent) color, matching read/ls/find paths.
            push(
                `${indent}${dimLine(groupIsLastRendered ? "└─" : "├─")} ${theme.fg("accent", fileLabel)}`,
            );
            visibleHere.forEach((match, index) => {
                const isLastInGroup = index === visibleHere.length - 1;
                const isLastOverall = groupIsLastRendered && isLastInGroup;
                push(
                    `${indent}${trunk}${TREE_CHILD_INDENT}${dimLine(isLastOverall ? "└─" : "├─")} ${formatMatchRow(theme, match)}`,
                );
            });
        }
    }
    if (truncated) {
        push(
            `${indent}${dimLine("└─")} ${theme.fg("dim", `… ${remaining} more ${pluralForm("match", remaining)}`)}`,
        );
    }
    return out;
}
/** Return the pluralized form of a noun for the given count. */
function pluralForm(noun: string, count: number): string {
    if (count === 1) return noun;
    return /(s|x|z|ch|sh)$/i.test(noun) ? `${noun}es` : `${noun}s`;
}
/** Pluralize a count noun: "1 file" / "3 files", "1 match" / "3 matches". */
export function pluralize(count: number, noun: string): string {
    return `${count} ${pluralForm(noun, count)}`;
}

// from: pistyle\features\tools\boxed\session-config.ts

// Per-session render configuration for boxed tool presentation.
//
// Set once per session by the compatibility coordinator; read inside renderers.
// Kept out of the render path (no filesystem/config reads during render).
interface ToolsRenderConfig {
    maxCollapsedLines: number;
    maxExpandedLines: number;
    dimOutput: boolean;
    showElapsed: boolean;
    /** Open-tree glyph for the done batch header (nerd `\u{F111}` / unicode `●`). */
    batchOpenGlyph: string;
    /** Nerd Font mode is active: file-type icons render in output trees. */
    nerdFonts: boolean;
    /** Collapse a completed turn's tool blocks into one summary line (ADR 0007). */
    collapseAfterTurn: boolean;
    /** Also collapse mutating tools (edit/write/…) into the summary; off keeps them visible. */
    collapseMutatingTools: boolean;
}
let sessionToolsConfig: ToolsRenderConfig = {
    maxCollapsedLines: 10,
    maxExpandedLines: 50,
    dimOutput: false,
    showElapsed: true,
    batchOpenGlyph: "●",
    nerdFonts: false,
    collapseAfterTurn: true,
    collapseMutatingTools: false,
};
export function setToolsRenderConfig(config: Partial<ToolsRenderConfig>): void {
    sessionToolsConfig = { ...sessionToolsConfig, ...config };
}
export function getToolsRenderConfig(): ToolsRenderConfig {
    return sessionToolsConfig;
}
function getToolsRenderCacheSignature(): string {
    return [
        sessionToolsConfig.maxCollapsedLines,
        sessionToolsConfig.maxExpandedLines,
        sessionToolsConfig.dimOutput ? 1 : 0,
        sessionToolsConfig.showElapsed ? 1 : 0,
        sessionToolsConfig.batchOpenGlyph,
        sessionToolsConfig.nerdFonts ? 1 : 0,
        sessionToolsConfig.collapseAfterTurn ? 1 : 0,
        sessionToolsConfig.collapseMutatingTools ? 1 : 0,
    ].join("|");
}
// Wall-clock elapsed tracking through the renderer context state (no tool
// re-registration, so result.details has no execution timing).
//
// Elapsed is computed live from the recorded start on every read, so a running
// tool keeps growing its displayed time. The value only freezes once the
// execution end is recorded (terminal result), which keeps the completed footer
// stable across later re-renders (expand toggles, terminal resizes).
const STARTED_AT_KEY = "__piStyleStartedAt";
const ENDED_AT_KEY = "__piStyleEndedAt";
const RESULT_SEEN_KEY = "__piStyleResultSeen";
const TICKER_KEY = "__piStyleElapsedTicker";
function recordExecutionStarted(
    state: Record<string, unknown> | undefined,
    executionStarted: boolean,
): void {
    if (!executionStarted || !state || typeof state !== "object") return;
    if (typeof state[STARTED_AT_KEY] !== "number") state[STARTED_AT_KEY] = performance.now();
}
/** Freeze the elapsed at the first terminal render (idempotent). */
function recordExecutionEnded(state: Record<string, unknown> | undefined): void {
    if (!state || typeof state !== "object") return;
    if (typeof state[ENDED_AT_KEY] !== "number") state[ENDED_AT_KEY] = performance.now();
}
function getStateElapsedMs(state: Record<string, unknown> | undefined): number | undefined {
    if (!state || typeof state !== "object") return undefined;
    const started = state[STARTED_AT_KEY];
    if (typeof started !== "number") return undefined;
    const ended = state[ENDED_AT_KEY];
    if (typeof ended === "number") return Math.max(0, ended - started);
    return Math.max(0, performance.now() - started);
}
/** Whether a result renderer already produced a continuation for this call. */
export function isResultSeen(state: Record<string, unknown> | undefined): boolean {
    return Boolean(state && typeof state === "object" && state[RESULT_SEEN_KEY] === true);
}
/** Record that a result renderer ran for this call (streaming or final). */
function markResultSeen(state: Record<string, unknown> | undefined): void {
    if (!state || typeof state !== "object") return;
    state[RESULT_SEEN_KEY] = true;
}
type TickerHandle = ReturnType<typeof setInterval>;
type ElapsedTickerEntry = {
    invalidate: () => void;
};
/** States currently subscribed to the shared elapsed-render ticker. */
const tickerEntries = new Map<Record<string, unknown>, ElapsedTickerEntry>();
let sharedTickerHandle: TickerHandle | undefined;
function ensureSharedTicker(): void {
    if (sharedTickerHandle !== undefined || tickerEntries.size === 0) return;
    sharedTickerHandle = setInterval(() => {
        for (const { invalidate } of tickerEntries.values()) invalidate();
    }, 100) as unknown as TickerHandle;
}
function stopSharedTickerIfIdle(): void {
    if (sharedTickerHandle === undefined || tickerEntries.size > 0) return;
    clearInterval(sharedTickerHandle);
    sharedTickerHandle = undefined;
}
/**
 * While a tool is running, re-render ten times per second so live elapsed labels
 * tick in milliseconds without any output events. Idempotent per state.
 */
function startElapsedTicker(
    state: Record<string, unknown> | undefined,
    invalidate: () => void,
): void {
    if (!state || typeof state !== "object") return;
    state[TICKER_KEY] = true;
    tickerEntries.set(state, { invalidate });
    ensureSharedTicker();
}
/** Stop a running tool's elapsed ticker (terminal result, error, session end). */
function stopElapsedTicker(state: Record<string, unknown> | undefined): void {
    if (!state || typeof state !== "object") return;
    delete state[TICKER_KEY];
    tickerEntries.delete(state);
    stopSharedTickerIfIdle();
}

// from: pistyle\features\tools\boxed\shared.ts

// Shared context/view types + common helpers for the boxed tool renderers.
/** Renderer context delivered by Pi's ToolExecutionComponent (getRenderContext). */
export interface BoxedToolContext {
    readonly args: Record<string, unknown>;
    readonly toolCallId: string;
    readonly invalidate: () => void;
    readonly state: Record<string, unknown>;
    readonly cwd: string;
    readonly executionStarted: boolean;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
    readonly lastComponent?: unknown;
    readonly durationMs?: number;
}
/** Result view delivered to result renderers: { content, details }. */
export interface BoxedToolResult {
    readonly content?: readonly unknown[];
    readonly details?: unknown;
}
type BoxedCallRenderer = (
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
) => Component;
type BoxedResultRenderer = (
    result: BoxedToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
) => Component;
interface BoxedToolDefinition {
    readonly call: BoxedCallRenderer;
    readonly result: BoxedResultRenderer;
}
function pendingFlag(context: BoxedToolContext): boolean {
    return Boolean(context.isPartial);
}
/** Normalized display path: shortens HOME and resolves relative to the session cwd. */
export function displayPath(rawPath: string, context: BoxedToolContext): string {
    const path = String(rawPath ?? "");
    if (!path) return "(unknown)";
    return shortenPath(resolveRelativePath(path, context.cwd));
}
function pathRangeDetail(
    rawPath: string,
    offset: unknown,
    limit: unknown,
    context: BoxedToolContext,
): string {
    const path = displayPath(rawPath, context);
    let range = "";
    if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? Number(start) + Number(limit) - 1 : "";
        range = `:${start}${end ? `-${end}` : ""}`;
    }
    return path ? `${path}${range}` : "(unknown)";
}
/** Compact boxed call header for summary-style tools (read/write/ls/find/grep). */
function compactCall(
    theme: BoxTheme,
    toolName: string,
    detailLine: string,
    options: { detailKey: string; context: BoxedToolContext },
): Component {
    return renderCompactBoxedToolCall(theme, toolName, detailLine, {
        widthKey: boxedToolWidthKey(toolName, options.detailKey),
        state: options.context.state,
        isError: Boolean(options.context.isError),
        isPartial: Boolean(options.context.isPartial),
        isPending: pendingFlag(options.context),
        running: Boolean(options.context.executionStarted),
    });
}
/** Record wall-clock start when execution begins (first render with executionStarted). */
export function noteExecutionStart(context: BoxedToolContext): void {
    recordExecutionStarted(context.state, context.executionStarted);
}
/**
 * Keep running/ended execution state in sync from a call renderer pass. While
 * the tool runs, a 1s re-render ticker keeps live elapsed labels current; once
 * the call renders in its terminal form the elapsed freezes.
 */
export function noteBoxedCallState(context: BoxedToolContext): void {
    if (!context.executionStarted) return;
    if (context.isPartial) startElapsedTicker(context.state, context.invalidate);
    else {
        recordExecutionEnded(context.state);
        stopElapsedTicker(context.state);
    }
}
/**
 * Record a result renderer pass and keep the ticker/ended state in sync.
 * Returns whether this is the first result pass for the call, so renderers can
 * render nothing while the pending/running call card stands alone.
 */
export function noteBoxedResultPhase(context: BoxedToolContext, isPartial: boolean): boolean {
    const firstResultPass = !isResultSeen(context.state);
    markResultSeen(context.state);
    if (isPartial) startElapsedTicker(context.state, context.invalidate);
    else {
        recordExecutionEnded(context.state);
        stopElapsedTicker(context.state);
    }
    return firstResultPass;
}
export function stateElapsedMs(context: BoxedToolContext): number | undefined {
    return context.durationMs ?? getStateElapsedMs(context.state);
}
/** State slot a diff result renderer publishes its stats into so the call
 *  renderer can append them to the box header (`path · +3 -0`) on the same
 *  paint. One slot suffices: renderer state is per tool call, and a call never
 *  renders two diffs. */
const DIFF_HEADER_STATS_KEY = "__piStyleDiffHeaderStats";
/** Publish diff stats for the call header (called by settled result renderers). */
function noteDiffHeaderStats(
    context: BoxedToolContext,
    stats: { additions: number; removals: number },
): void {
    context.state[DIFF_HEADER_STATS_KEY] = { additions: stats.additions, removals: stats.removals };
}
/** Drop published diff stats (error / no-diff results keep the header clean). */
function clearDiffHeaderStats(context: BoxedToolContext): void {
    delete context.state[DIFF_HEADER_STATS_KEY];
}
/** Colored `+N -M` diff stats pair: diff colors when nonzero, dim zeros. */
function formatDiffStatsPair(theme: BoxTheme, additions: number, removals: number): string {
    const plus = additions > 0 ? theme.fg("toolDiffAdded", `+${additions}`) : theme.fg("dim", "+0");
    const minus =
        removals > 0 ? theme.fg("toolDiffRemoved", `-${removals}`) : theme.fg("dim", "-0");
    return `${plus} ${minus}`;
}
/** ` · +3 -0` header suffix with diff colors, or "" while no stats are
 *  published (pending call / error result). */
function diffHeaderStatsSuffix(theme: BoxTheme, context: BoxedToolContext): string {
    const stats = context.state[DIFF_HEADER_STATS_KEY] as
        { additions?: unknown; removals?: unknown } | undefined;
    if (!stats || typeof stats !== "object") return "";
    const additions = Number(stats.additions);
    const removals = Number(stats.removals);
    if (!Number.isFinite(additions) || !Number.isFinite(removals)) return "";
    return ` · ${formatDiffStatsPair(theme, additions, removals)}`;
}
function compactFooterWithState(
    theme: BoxTheme,
    result: BoxedToolResult,
    context: BoxedToolContext,
    options: { isError?: boolean; isPartial?: boolean } = {},
): Component {
    const elapsedMs = stateElapsedMs(context);
    return renderCompactBoxedFooter(theme, result, {
        state: context.state,
        isError: Boolean(options.isError ?? context.isError),
        isPartial: Boolean(options.isPartial ?? context.isPartial),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
}
function resultFooterLines(
    theme: BoxTheme,
    result: BoxedToolResult,
    context: BoxedToolContext,
    extraParts: string[] = [],
): string[] {
    return [formatBoxedFooter(theme, result, extraParts, stateElapsedMs(context))];
}
type StateComponentCacheEntry = {
    key: string;
    component: Component;
};
/** Cache-key string parts at or below this length join verbatim; longer ones
 *  collapse to `length:hash` so the joined key length stays bounded regardless
 *  of raw output size. */
const CACHE_KEY_LONG_PART_THRESHOLD = 64;
/** 32-bit FNV-1a hash of a string as 8 lowercase hex digits. Local mirror of the
 *  compatibility probe's fingerprint hashing (the pi/ layer stays unreachable
 *  from features): deterministic, collision-safe for cache identity. */
function fnv1aHex(text: string): string {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
/** Fold one join part: strings longer than CACHE_KEY_LONG_PART_THRESHOLD
 *  collapse to `length:hash`; numbers/booleans pass through unchanged. */
function boundedCacheKeyPart(part: string | number | boolean): string | number | boolean {
    if (typeof part !== "string" || part.length <= CACHE_KEY_LONG_PART_THRESHOLD) return part;
    return `${part.length}:${fnv1aHex(part)}`;
}
function getRenderCacheKey(
    prefix: string,
    theme: BoxTheme,
    ...parts: Array<string | number | boolean>
): string {
    const pieces: Array<string | number | boolean> = [
        prefix,
        themeCacheKey(theme),
        getToolsRenderCacheSignature(),
    ];
    for (const part of parts) pieces.push(boundedCacheKeyPart(part));
    return pieces.join("|");
}
function memoizedStateComponent(
    state: Record<string, unknown> | undefined,
    slot: string,
    key: string,
    build: () => Component,
): Component {
    if (!state || typeof state !== "object") return build();
    const cached = state[slot] as StateComponentCacheEntry | undefined;
    if (cached && cached.key === key) return cached.component;
    const component = build();
    state[slot] = { key, component } satisfies StateComponentCacheEntry;
    return component;
}
function clearFooterState(context: BoxedToolContext): void {
    clearCompactBoxedFooter(context.state);
}
export { boxedToolWidthKey, getTextOutput, resolveRelativePath, shortenPath };

// from: pistyle\features\tools\boxed\gh.ts

// GitHub (`gh`) semantic view renderer (Phase 8D).
//
// Bash `gh pr`/`issue`/`run` results render as a boxless compact card in the
// call panel, mirroring the git semantic path (see git.ts). `gh run view
// --job=<id>` renders the job log in a boxed result (the same
// `renderBoxedToolResult` shape git diff uses), while `gh run watch`, `gh api`,
// and any command with pipes/redirects/`&&` stay raw (ADR 0005). bash.ts owns
// the registry and dispatch; this module is registry-free pure functions.
//
// Every parser is fail-closed: on any ambiguity it returns null and the boxed
// command/response shell renders the raw output unchanged. `--json` output is
// detected by the first non-whitespace character (`{`/`[`); otherwise the
// table/rich text format is parsed.
// ── Classification ──────────────────────────────────────────────────────────
type GhSemanticClass =
    | { readonly kind: "pr-list" }
    | { readonly kind: "pr-view" }
    | { readonly kind: "pr-checks" }
    | { readonly kind: "pr-create" }
    | { readonly kind: "issue-list" }
    | { readonly kind: "issue-view" }
    | { readonly kind: "run-list" }
    | { readonly kind: "run-view" }
    | { readonly kind: "run-job"; readonly jobId: string };
/** Global `gh` flags that consume a separate value token (`-R owner/repo`). */
const GH_REPO_VALUE_FLAGS = new Set(["-R", "--repo"]);
/** Strip `-R <value>` / `--repo <value>` (and attached `--repo=value`) pairs so
 *  the command/subcommand words can be located anywhere in the arg list. */
function stripRepoFlags(args: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length;) {
        const token = args[i] ?? "";
        if (GH_REPO_VALUE_FLAGS.has(token)) {
            i += 2; // flag + its value
            continue;
        }
        if (token.startsWith("--repo=")) {
            i += 1;
            continue;
        }
        out.push(token);
        i += 1;
    }
    return out;
}
/** Locate the `--job` value (`--job <id>` or `--job=<id>`) on a `run view`. */
function findJobId(args: readonly string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        const token = args[i] ?? "";
        if (token === "--job") return args[i + 1];
        const attached = /^--job=(.+)$/.exec(token);
        if (attached) return attached[1];
    }
    return undefined;
}
/**
 * Classify a bash command for `gh` semantic rendering, or null to keep the
 * boxed shell. Only `gh pr {list,view,checks,create}`, `gh issue {list,view}`,
 * and `gh run {list,view}` are eligible; `gh run view --job=<id>` becomes a
 * `run-job` (boxed log). `gh run watch`, `gh api`, and any other subcommand or
 * pipe/redirect fall back raw (ADR 0005).
 */
function classifyGhCommand(command: string): GhSemanticClass | null {
    const shape = parseSimpleBashCommand(command);
    if (!shape) return null;
    const rest = shape.tokens;
    if ((rest[0] ?? "").split("/").pop() !== "gh") return null;
    const args = rest.slice(1);
    if (args.length === 0) return null;
    const tokens = stripRepoFlags(args);
    const commandWord = tokens[0];
    const subcommand = tokens[1];
    if (commandWord === "pr") {
        if (subcommand === "list") return { kind: "pr-list" };
        if (subcommand === "view") return { kind: "pr-view" };
        if (subcommand === "checks") return { kind: "pr-checks" };
        if (subcommand === "create") return { kind: "pr-create" };
        return null;
    }
    if (commandWord === "issue") {
        if (subcommand === "list") return { kind: "issue-list" };
        if (subcommand === "view") return { kind: "issue-view" };
        return null;
    }
    if (commandWord === "run") {
        if (subcommand === "list") return { kind: "run-list" };
        if (subcommand === "view") {
            const jobId = findJobId(args);
            if (jobId !== undefined) return { kind: "run-job", jobId };
            return { kind: "run-view" };
        }
        // `gh run watch` and all other run subcommands stay raw (ADR 0005).
        return null;
    }
    return null; // `gh api`, extensions, and other subcommands
}
// ── Parsed shapes ───────────────────────────────────────────────────────────
const GH_STATES = new Set(["OPEN", "CLOSED", "MERGED"]);
const GH_CHECK_STATES = new Set([
    "pass",
    "fail",
    "pending",
    "skipping",
    "neutral",
    "cancelled",
    "timed_out",
    "startup_failure",
    "stale",
    "action_required",
]);
interface GhListItem {
    readonly number: number;
    readonly title: string;
    readonly branch?: string;
    readonly state: string;
}
interface GhListParsed {
    readonly kind: "pr-list" | "issue-list";
    readonly rows: readonly GhListItem[];
}
interface GhViewParsed {
    readonly kind: "pr-view" | "issue-view";
    readonly title: string;
    readonly state: string;
    readonly author?: string;
    readonly number?: number;
    readonly url?: string;
    readonly additions?: number;
    readonly deletions?: number;
    readonly changedFiles?: number;
    readonly baseRefName?: string;
    readonly headRefName?: string;
    readonly reviewers?: string;
    readonly reviewDecision?: string;
    readonly mergeable?: string;
    readonly labels?: string;
    readonly body?: string;
}
interface GhCheckRow {
    readonly name: string;
    readonly state: string;
    readonly duration?: string;
    readonly url?: string;
}
interface GhChecksParsed {
    readonly kind: "pr-checks";
    readonly rows: readonly GhCheckRow[];
}
interface GhCreateParsed {
    readonly kind: "pr-create";
    readonly url: string;
    readonly number?: number;
}
interface GhRunListRow {
    readonly status: string;
    readonly conclusion?: string;
    readonly title: string;
    readonly workflow: string;
    readonly branch: string;
    readonly event: string;
    readonly id: string;
    readonly elapsed?: string;
}
interface GhRunListParsed {
    readonly kind: "run-list";
    readonly rows: readonly GhRunListRow[];
}
interface GhRunJob {
    readonly state: string;
    readonly name: string;
    readonly count?: number;
    readonly duration?: string;
    readonly id?: string;
}
interface GhRunAnnotation {
    readonly text: string;
}
interface GhRunViewParsed {
    readonly kind: "run-view";
    readonly state?: string;
    readonly branch?: string;
    readonly workflow?: string;
    readonly id?: string;
    readonly trigger?: string;
    readonly jobs: readonly GhRunJob[];
    readonly annotations: readonly GhRunAnnotation[];
}
interface GhRunJobParsed {
    readonly kind: "run-job";
    readonly jobId: string;
    readonly lines: readonly string[];
}
type GhParsedSemantic =
    | GhListParsed
    | GhViewParsed
    | GhChecksParsed
    | GhCreateParsed
    | GhRunListParsed
    | GhRunViewParsed
    | GhRunJobParsed;
// ── JSON detection ──────────────────────────────────────────────────────────
type JsonProbe = { readonly json: unknown } | { readonly notJson: true } | null;
/** Probe whether the text is `gh --json` output (starts with `{`/`[`). Returns
 *  `{json}` on a successful parse, `{notJson}` for table/rich text, or `null`
 *  when the text looks like JSON but fails to parse (hostile). */
function probeJson(text: string): JsonProbe {
    const trimmed = text.trimStart();
    const first = trimmed[0];
    if (first !== "{" && first !== "[") return { notJson: true };
    try {
        return { json: JSON.parse(trimmed) };
    } catch {
        return null;
    }
}
function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/** `author` may be a bare login string or `{ login }` (the `gh --json` shape). */
function authorOf(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value && typeof value === "object")
        return asString((value as Record<string, unknown>).login);
    return undefined;
}
/** Join an array of `{ login }` / `{ name }` objects into a comma list. */
function nameList(value: unknown, field: "login" | "name" = "login"): string | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const names = value
        .map((item) =>
            item && typeof item === "object"
                ? asString((item as Record<string, unknown>)[field])
                : undefined,
        )
        .filter((name): name is string => typeof name === "string");
    return names.length > 0 ? names.join(", ") : undefined;
}
// ── list parsers (pr list / issue list) ─────────────────────────────────────
// Tab-separated default output. `gh pr list` columns are
// NUMBER<TAB>TITLE<TAB>BRANCH<TAB>STATE<TAB>UPDATED (5); `gh issue list` is
// NUMBER<TAB>TITLE<TAB>STATE<TAB>UPDATED (4) and may carry labels before STATE.
// The state token (OPEN/CLOSED/MERGED) is located by content so both shapes
// parse without a fixed column count.
function parseListTable(text: string, kind: "pr-list" | "issue-list"): GhListParsed | null {
    const rows: GhListItem[] = [];
    for (const rawLine of text.replace(/\r/g, "").split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        const fields = line.split("\t");
        if (fields.length < 4) return null;
        const numberField = fields[0] ?? "";
        if (!/^\d+$/.test(numberField)) return null;
        const title = fields[1] ?? "";
        let stateIndex = -1;
        for (let i = 2; i < fields.length - 1; i++) {
            if (GH_STATES.has((fields[i] ?? "").toUpperCase())) {
                stateIndex = i;
                break;
            }
        }
        if (stateIndex < 0) return null;
        const state = (fields[stateIndex] ?? "").toUpperCase();
        const branch = kind === "pr-list" ? (fields[2] ?? "") : "";
        rows.push({
            number: Number(numberField),
            title,
            ...(branch ? { branch } : {}),
            state,
        });
    }
    return { kind, rows };
}
function parseListJson(json: unknown, kind: "pr-list" | "issue-list"): GhListParsed | null {
    if (!Array.isArray(json)) return null;
    const rows: GhListItem[] = [];
    for (const item of json) {
        if (!item || typeof item !== "object") return null;
        const obj = item as Record<string, unknown>;
        const number = asNumber(obj.number);
        if (number === undefined) return null;
        const title = asString(obj.title);
        if (title === undefined) return null;
        const stateRaw = asString(obj.state);
        if (stateRaw === undefined || !GH_STATES.has(stateRaw.toUpperCase())) return null;
        const branch = asString(obj.headRefName);
        rows.push({ number, title, state: stateRaw.toUpperCase(), ...(branch ? { branch } : {}) });
    }
    return { kind, rows };
}
function parseGhList(text: string, kind: "pr-list" | "issue-list"): GhListParsed | null {
    const probe = probeJson(text);
    if (probe === null) return null;
    if ("notJson" in probe) return parseListTable(text, kind);
    return parseListJson(probe.json, kind);
}
// ── view parsers (pr view / issue view) ─────────────────────────────────────
// Rich output is a block of `key:\tvalue` pairs, a `--` separator, then the
// markdown body. `--json` is a single object (base/head/mergeable/changedFiles
// only appear in JSON; the rich block carries title/state/author/labels/
// reviewers/number/url/additions/deletions).
const VIEW_FIELD_LINE = /^([a-zA-Z][a-zA-Z0-9-]*?):\t(.*)$/;
function parseViewRich(text: string, kind: "pr-view" | "issue-view"): GhViewParsed | null {
    const lines = text.replace(/\r/g, "").split("\n");
    const fields: Record<string, string> = {};
    let bodyStart = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line === "--") {
            bodyStart = i + 1;
            break;
        }
        const match = VIEW_FIELD_LINE.exec(line);
        if (!match) {
            if (line.trim() === "") continue; // tolerate a stray blank line
            return null; // unrecognized line → fail closed
        }
        const key = match[1] ?? "";
        const value = match[2] ?? "";
        if (fields[key] === undefined) fields[key] = value;
    }
    const title = fields.title;
    const stateRaw = fields.state;
    if (!title || !stateRaw) return null;
    const state = stateRaw.toUpperCase();
    const body =
        bodyStart >= 0 ? lines.slice(bodyStart).join("\n").replace(/\s+$/u, "") : undefined;
    const number = /^\d+$/.test(fields.number ?? "") ? Number(fields.number) : undefined;
    const additions = /^\d+$/.test(fields.additions ?? "") ? Number(fields.additions) : undefined;
    const deletions = /^\d+$/.test(fields.deletions ?? "") ? Number(fields.deletions) : undefined;
    return {
        kind,
        title,
        state,
        ...(fields.author ? { author: fields.author } : {}),
        ...(number !== undefined ? { number } : {}),
        ...(fields.url ? { url: fields.url } : {}),
        ...(additions !== undefined ? { additions } : {}),
        ...(deletions !== undefined ? { deletions } : {}),
        ...(fields.labels ? { labels: fields.labels } : {}),
        ...(fields.reviewers ? { reviewers: fields.reviewers } : {}),
        ...(body?.trim() ? { body } : {}),
    };
}
function parseViewJson(json: unknown, kind: "pr-view" | "issue-view"): GhViewParsed | null {
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const o = json as Record<string, unknown>;
    const title = asString(o.title);
    const stateRaw = asString(o.state);
    if (!title || !stateRaw || !GH_STATES.has(stateRaw.toUpperCase())) return null;
    const state = stateRaw.toUpperCase();
    const author = authorOf(o.author);
    const number = asNumber(o.number);
    const url = asString(o.url);
    const additions = asNumber(o.additions);
    const deletions = asNumber(o.deletions);
    const changedFiles = asNumber(o.changedFiles);
    const baseRefName = asString(o.baseRefName);
    const headRefName = asString(o.headRefName);
    const mergeable = asString(o.mergeable);
    const reviewDecision = asString(o.reviewDecision);
    const reviewers = nameList(o.reviewRequests) ?? nameList(o.reviews);
    const body = asString(o.body);
    return {
        kind,
        title,
        state,
        ...(author ? { author } : {}),
        ...(number !== undefined ? { number } : {}),
        ...(url ? { url } : {}),
        ...(additions !== undefined ? { additions } : {}),
        ...(deletions !== undefined ? { deletions } : {}),
        ...(changedFiles !== undefined ? { changedFiles } : {}),
        ...(baseRefName ? { baseRefName } : {}),
        ...(headRefName ? { headRefName } : {}),
        ...(mergeable ? { mergeable } : {}),
        ...(reviewDecision ? { reviewDecision } : {}),
        ...(reviewers ? { reviewers } : {}),
        ...(body?.trim() ? { body } : {}),
    };
}
function parseGhView(text: string, kind: "pr-view" | "issue-view"): GhViewParsed | null {
    const probe = probeJson(text);
    if (probe === null) return null;
    if ("notJson" in probe) return parseViewRich(text, kind);
    return parseViewJson(probe.json, kind);
}
// ── pr checks parser ────────────────────────────────────────────────────────
// `NAME<TAB>STATE<TAB>DURATION<TAB>URL` (states: pass/fail/pending/skipping).
function parseChecksTable(text: string): GhChecksParsed | null {
    const rows: GhCheckRow[] = [];
    for (const rawLine of text.replace(/\r/g, "").split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        const fields = line.split("\t");
        if (fields.length < 2) return null;
        const name = fields[0] ?? "";
        const state = (fields[1] ?? "").toLowerCase();
        if (!GH_CHECK_STATES.has(state)) return null;
        const duration = fields[2] !== undefined && fields[2] !== "" ? fields[2] : undefined;
        const url = fields[3];
        rows.push({
            name,
            state,
            ...(duration ? { duration } : {}),
            ...(url ? { url } : {}),
        });
    }
    return { kind: "pr-checks", rows };
}
// ── pr create parser ────────────────────────────────────────────────────────
// Success prints `https://github.com/<owner>/<repo>/pull/<N>`.
const PR_CREATE_URL = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))/;
function parseGhCreate(text: string): GhCreateParsed | null {
    const trimmed = text.replace(/\r/g, "").trim();
    const match = PR_CREATE_URL.exec(trimmed);
    if (!match) return null;
    const url = match[1] ?? "";
    const number = match[2] !== undefined ? Number(match[2]) : undefined;
    return { kind: "pr-create", url, ...(number !== undefined ? { number } : {}) };
}
// ── run list parser ─────────────────────────────────────────────────────────
// STATUS<TAB>CONCLUSION<TAB>TITLE<TAB>WORKFLOW<TAB>BRANCH<TAB>EVENT<TAB>ID<TAB>
// ELAPSED<TAB>AGE. JSON carries databaseId/headBranch/name/workflowName/event.
function parseRunListTable(text: string): GhRunListParsed | null {
    const rows: GhRunListRow[] = [];
    for (const rawLine of text.replace(/\r/g, "").split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        const fields = line.split("\t");
        // Need at least STATUS..CONCLUSION..TITLE..WORKFLOW..BRANCH..EVENT..ID.
        if (fields.length < 7) return null;
        const id = fields[6] ?? "";
        if (!/^\d+$/.test(id)) return null;
        const status = fields[0] ?? "";
        const conclusionField = fields[1] ?? "";
        const conclusion = conclusionField !== "" ? conclusionField : undefined;
        const title = fields[2] ?? "";
        const workflow = fields[3] ?? "";
        const branch = fields[4] ?? "";
        const event = fields[5] ?? "";
        const elapsed = fields[7] !== undefined && fields[7] !== "" ? fields[7] : undefined;
        rows.push({
            status,
            ...(conclusion ? { conclusion } : {}),
            title,
            workflow,
            branch,
            event,
            id,
            ...(elapsed ? { elapsed } : {}),
        });
    }
    return { kind: "run-list", rows };
}
function parseRunListJson(json: unknown): GhRunListParsed | null {
    if (!Array.isArray(json)) return null;
    const rows: GhRunListRow[] = [];
    for (const item of json) {
        if (!item || typeof item !== "object") return null;
        const o = item as Record<string, unknown>;
        const status = asString(o.status);
        const id = asNumber(o.databaseId ?? o.id);
        if (status === undefined || id === undefined) return null;
        const workflow = asString(o.workflowName) ?? asString(o.name) ?? "";
        const title = asString(o.displayTitle) ?? workflow;
        rows.push({
            status,
            ...(asString(o.conclusion) ? { conclusion: asString(o.conclusion) as string } : {}),
            title,
            workflow,
            branch: asString(o.headBranch) ?? "",
            event: asString(o.event) ?? "",
            id: String(id),
            ...(asString(o.elapsed) ? { elapsed: o.elapsed as string } : {}),
        });
    }
    return { kind: "run-list", rows };
}
function parseGhRunList(text: string): GhRunListParsed | null {
    const probe = probeJson(text);
    if (probe === null) return null;
    if ("notJson" in probe) return parseRunListTable(text);
    return parseRunListJson(probe.json);
}
// ── run view parser ─────────────────────────────────────────────────────────
// Rich output: a status line `✓|✗|◌ <branch> <workflow> · <id>`, an optional
// `Triggered via …` line, a `JOBS` block of `✓|✗|◌ <name> (N) in <dur> (ID id)`
// rows, an optional `ANNOTATIONS` block of `! …` rows, then trailing hint
// lines (`For more information…`, `View this run on GitHub:…`) which are skipped.
const RUN_VIEW_STATUS_LINE = /^([✓✗◌*])\s+(\S+)\s+(.+?)\s+·\s+(\d+)\s*$/u;
const RUN_VIEW_JOB_LINE = /^([✓✗◌*])\s+(.+?)\s+\((\d+)\)\s+in\s+(\S+)\s+\(ID\s+(\d+)\)\s*$/u;
function isRunViewHint(line: string): boolean {
    return (
        line.startsWith("For more information about the job, try:") ||
        line.startsWith("View this run on GitHub:")
    );
}
function parseGhRunView(text: string): GhRunViewParsed | null {
    const lines = text.replace(/\r/g, "").split("\n");
    let idx = 0;
    while (idx < lines.length && (lines[idx] ?? "").trim() === "") idx++;
    if (idx >= lines.length) return null;
    const statusMatch = RUN_VIEW_STATUS_LINE.exec(lines[idx] ?? "");
    if (!statusMatch) return null;
    const state = statusMatch[1] ?? "";
    const branch = statusMatch[2] ?? "";
    const workflow = statusMatch[3] ?? "";
    const id = statusMatch[4] ?? "";
    idx++;
    // Optional `Triggered via …` line.
    let trigger: string | undefined;
    while (idx < lines.length && (lines[idx] ?? "").trim() === "") idx++;
    if (idx < lines.length && /^Triggered via .+/.test(lines[idx] ?? "")) {
        trigger = lines[idx];
        idx++;
    }
    const jobs: GhRunJob[] = [];
    const annotations: GhRunAnnotation[] = [];
    const skipBlanks = () => {
        while (idx < lines.length && (lines[idx] ?? "").trim() === "") idx++;
    };
    skipBlanks();
    if ((lines[idx] ?? "") === "JOBS") {
        idx++;
        while (idx < lines.length) {
            const line = lines[idx] ?? "";
            if (line === "") {
                idx++;
                break;
            }
            if (line === "ANNOTATIONS" || isRunViewHint(line)) break;
            const jobMatch = RUN_VIEW_JOB_LINE.exec(line);
            if (!jobMatch) return null;
            jobs.push({
                state: jobMatch[1] ?? "",
                name: jobMatch[2] ?? "",
                count: Number(jobMatch[3] ?? 0),
                duration: jobMatch[4] ?? "",
                id: jobMatch[5] ?? "",
            });
            idx++;
        }
    }
    skipBlanks();
    if ((lines[idx] ?? "") === "ANNOTATIONS") {
        idx++;
        while (idx < lines.length) {
            const line = lines[idx] ?? "";
            if (line === "") {
                idx++;
                break;
            }
            if (isRunViewHint(line)) break;
            const annotationMatch = /^!\s+(.+)$/.exec(line);
            if (annotationMatch) {
                annotations.push({ text: annotationMatch[1] ?? "" });
                idx++;
                continue;
            }
            // Location-reference row following a `! …` message (`check (22):
            // .github#2`) — a dim source pointer, not a new annotation.
            const sourceMatch = /^[A-Za-z0-9_ ./()-]+\(\d+\): \S+#\d+$/.exec(line);
            if (sourceMatch) {
                annotations.push({ text: line });
                idx++;
                continue;
            }
            return null;
        }
    }
    // Only hint/blank lines may follow; anything else fails closed.
    for (let i = idx; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim() === "") continue;
        if (isRunViewHint(line)) continue;
        return null;
    }
    return {
        kind: "run-view",
        ...(state ? { state } : {}),
        ...(branch ? { branch } : {}),
        ...(workflow ? { workflow } : {}),
        ...(id ? { id } : {}),
        ...(trigger ? { trigger } : {}),
        jobs,
        annotations,
    };
}
// ── run job parser ──────────────────────────────────────────────────────────
// The job log is raw text; any output is a valid log body (the boxed result
// owns width-truncation and a render budget). It never fails closed.
function parseGhRunJob(text: string, jobId: string): GhRunJobParsed {
    const body = String(text ?? "").replace(/\r/g, "");
    const lines = body.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return { kind: "run-job", jobId, lines };
}
// ── Dispatch helpers (used by bash.ts) ──────────────────────────────────────
function parseGhOutput(cls: GhSemanticClass, output: string): GhParsedSemantic | null {
    const text = String(output ?? "");
    switch (cls.kind) {
        case "pr-list":
            return parseGhList(text, "pr-list");
        case "issue-list":
            return parseGhList(text, "issue-list");
        case "pr-view":
            return parseGhView(text, "pr-view");
        case "issue-view":
            return parseGhView(text, "issue-view");
        case "pr-checks":
            return parseChecksTable(text);
        case "pr-create":
            return parseGhCreate(text);
        case "run-list":
            return parseGhRunList(text);
        case "run-view":
            return parseGhRunView(text);
        case "run-job":
            return parseGhRunJob(text, cls.jobId);
    }
}
// ── Rendering ───────────────────────────────────────────────────────────────
/** Nerd Font GitHub mark glyph used on gh card headers in Nerd Font mode. */
const GH_ICON = "\u{F408}";
const GH_CARD_HEAD_LIMIT = 6;
const GH_BODY_PREVIEW_LINES = 8;
function ghCardHeader(theme: BoxTheme, cls: GhSemanticClass, parsed?: GhParsedSemantic): string {
    const icon = getToolsRenderConfig().nerdFonts ? `${GH_ICON} ` : "";
    let prefix: string;
    switch (cls.kind) {
        case "pr-list":
            prefix = `${icon}PRs`;
            break;
        case "pr-view":
            prefix = `${icon}PR`;
            break;
        case "pr-checks":
            prefix = `${icon}PR checks`;
            break;
        case "pr-create":
            prefix = `${icon}PR created`;
            break;
        case "issue-list":
            prefix = `${icon}Issues`;
            break;
        case "issue-view":
            prefix = `${icon}Issue`;
            break;
        case "run-list":
            prefix = `${icon}Runs`;
            break;
        case "run-view":
            prefix = `${icon}Run`;
            break;
        case "run-job":
            prefix = `${icon}Run job`;
            break;
    }
    if (parsed) {
        if (parsed.kind === "pr-view" || parsed.kind === "issue-view") {
            if (parsed.number !== undefined) prefix += ` #${parsed.number}`;
            prefix += ` · ${parsed.title}`;
        } else if (parsed.kind === "pr-create") {
            if (parsed.number !== undefined) prefix += ` #${parsed.number}`;
        } else if (parsed.kind === "run-view") {
            if (parsed.workflow) prefix += ` · ${parsed.workflow}`;
            if (parsed.id) prefix += ` · ${parsed.id}`;
        } else if (parsed.kind === "run-job") {
            prefix += ` · ${parsed.jobId}`;
        }
    }
    return typeof theme?.bold === "function" ? theme.bold(prefix) : prefix;
}
/** State color for an OPEN/CLOSED/MERGED value. */
function ghStateColor(state: string): string {
    if (state === "OPEN") return "accent";
    if (state === "MERGED") return "toolDiffAdded";
    return "dim"; // CLOSED
}
/** Colored run glyph from a status/conclusion pair (✓ success, ✗ failure,
 *  󱦟 in-progress/queued, dim `-` for skipped/cancelled/neutral). */
function runGlyph(theme: BoxTheme, status: string, conclusion?: string): string {
    if (status === "completed") {
        if (conclusion === "success") return theme.fg("toolDiffAdded", "✓");
        if (conclusion === "failure") return theme.fg("error", "✗");
        return theme.fg("dim", "-"); // cancelled / skipped / neutral
    }
    return theme.fg("warning", RUNNING_TITLE_GLYPH); // in_progress / queued / waiting
}
/** Colored run glyph from a raw ✓/✗/◌ token (run-view jobs). */
function runStateGlyph(theme: BoxTheme, glyph: string): string {
    if (glyph === "✓") return theme.fg("toolDiffAdded", "✓");
    if (glyph === "✗") return theme.fg("error", "✗");
    return theme.fg("warning", RUNNING_TITLE_GLYPH);
}
/** Check-state color (pass/fail/pending/skipping/…). */
function checkStateColor(state: string): string {
    if (state === "pass") return "toolDiffAdded";
    if (state === "fail") return "error";
    if (state === "pending") return "warning";
    return "dim"; // skipping / neutral / cancelled / …
}
function renderMoreRow(theme: BoxTheme, unit: string, more: number, width: number): string {
    return safeTruncateToWidth(
        `${TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm(unit, more)}`)}`,
        width,
        "…",
    );
}
function renderListCard(
    theme: BoxTheme,
    parsed: GhListParsed,
    out: string[],
    width: number,
): string[] {
    const rows = parsed.rows;
    const noun = parsed.kind === "pr-list" ? "PR" : "issue";
    if (rows.length === 0) {
        out.push(theme.fg("muted", `  no open ${pluralForm(noun, 2)}`));
        return out;
    }
    out.push(`  ${theme.fg("accent", `${rows.length} ${pluralForm(noun, rows.length)}`)}`);
    const visible = rows.slice(0, GH_CARD_HEAD_LIMIT);
    const more = rows.length - visible.length;
    const lastIndex = visible.length - 1;
    for (let i = 0; i < visible.length; i++) {
        const row = visible[i];
        if (!row) continue;
        const branchGlyph = i < lastIndex || more > 0 ? "├─" : "└─";
        const color = ghStateColor(row.state);
        const num = theme.fg(color, `#${row.number}`);
        const title = theme.fg("toolOutput", row.title);
        const stateSuffix =
            row.state !== "OPEN" ? theme.fg("dim", ` (${row.state.toLowerCase()})`) : "";
        const branchPart = row.branch ? theme.fg("dim", `  ${row.branch}`) : "";
        const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${num}  ${title}${stateSuffix}${branchPart}`;
        out.push(safeTruncateToWidth(line, width, "…"));
    }
    if (more > 0) out.push(renderMoreRow(theme, noun, more, width));
    return out;
}
function renderBodyPreview(theme: BoxTheme, body: string, out: string[], width: number): string[] {
    const bodyLines = body.replace(/\s+$/u, "").split("\n");
    const visible = bodyLines.slice(0, GH_BODY_PREVIEW_LINES);
    for (const line of visible) {
        out.push(safeTruncateToWidth(`  ${theme.fg("muted", line)}`, width, "…"));
    }
    const more = bodyLines.length - visible.length;
    if (more > 0) {
        out.push(
            safeTruncateToWidth(
                `  ${theme.fg("dim", `… ${more} more lines · Ctrl+O`)}`,
                width,
                "…",
            ),
        );
    }
    return out;
}
function renderViewCard(
    theme: BoxTheme,
    parsed: GhViewParsed,
    out: string[],
    width: number,
): string[] {
    const stateParts = [theme.fg(ghStateColor(parsed.state), parsed.state)];
    if (parsed.baseRefName && parsed.headRefName) {
        stateParts.push(
            theme.fg("dim", "·"),
            theme.fg("text", `${parsed.baseRefName} → ${parsed.headRefName}`),
        );
    }
    out.push(safeTruncateToWidth(`  ${stateParts.join(theme.fg("dim", " "))}`, width, "…"));
    const summaryParts: string[] = [];
    const diffParts: string[] = [];
    if (parsed.additions !== undefined && parsed.additions > 0) {
        diffParts.push(theme.fg("toolDiffAdded", `+${parsed.additions}`));
    }
    if (parsed.deletions !== undefined && parsed.deletions > 0) {
        diffParts.push(theme.fg("toolDiffRemoved", `-${parsed.deletions}`));
    }
    if (diffParts.length > 0) summaryParts.push(diffParts.join(" "));
    if (parsed.changedFiles !== undefined) {
        summaryParts.push(
            theme.fg("accent", `${parsed.changedFiles} ${pluralForm("file", parsed.changedFiles)}`),
        );
    }
    if (summaryParts.length > 0) {
        out.push(safeTruncateToWidth(`  ${summaryParts.join(theme.fg("dim", " · "))}`, width, "…"));
    }
    if (parsed.author) {
        out.push(
            safeTruncateToWidth(
                `  ${theme.fg("dim", "author")} ${theme.fg("text", parsed.author)}`,
                width,
                "…",
            ),
        );
    }
    if (parsed.reviewers) {
        out.push(
            safeTruncateToWidth(
                `  ${theme.fg("dim", "reviewers")} ${theme.fg("toolOutput", parsed.reviewers)}`,
                width,
                "…",
            ),
        );
    } else if (parsed.reviewDecision) {
        out.push(
            safeTruncateToWidth(
                `  ${theme.fg("dim", "review")} ${theme.fg("text", parsed.reviewDecision)}`,
                width,
                "…",
            ),
        );
    }
    if (parsed.mergeable) {
        out.push(
            safeTruncateToWidth(
                `  ${theme.fg("dim", "mergeable")} ${theme.fg("text", parsed.mergeable)}`,
                width,
                "…",
            ),
        );
    }
    if (parsed.body?.trim()) renderBodyPreview(theme, parsed.body, out, width);
    return out;
}
function renderChecksCard(
    theme: BoxTheme,
    parsed: GhChecksParsed,
    out: string[],
    width: number,
): string[] {
    const rows = parsed.rows;
    if (rows.length === 0) {
        out.push(theme.fg("muted", "  no checks reported"));
        return out;
    }
    const visible = rows.slice(0, GH_CARD_HEAD_LIMIT);
    const more = rows.length - visible.length;
    const lastIndex = visible.length - 1;
    for (let i = 0; i < visible.length; i++) {
        const row = visible[i];
        if (!row) continue;
        const branchGlyph = i < lastIndex || more > 0 ? "├─" : "└─";
        const name = theme.fg("toolOutput", row.name);
        const state = theme.fg(checkStateColor(row.state), row.state);
        const duration =
            row.duration && row.duration !== "0" ? theme.fg("dim", `  ${row.duration}`) : "";
        const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${name}  ${state}${duration}`;
        out.push(safeTruncateToWidth(line, width, "…"));
    }
    if (more > 0) out.push(renderMoreRow(theme, "check", more, width));
    return out;
}
function renderCreateCard(
    theme: BoxTheme,
    parsed: GhCreateParsed,
    out: string[],
    width: number,
): string[] {
    out.push(safeTruncateToWidth(`  ${theme.fg("text", parsed.url)}`, width, "…"));
    return out;
}
function renderRunListCard(
    theme: BoxTheme,
    parsed: GhRunListParsed,
    out: string[],
    width: number,
): string[] {
    const rows = parsed.rows;
    if (rows.length === 0) {
        out.push(theme.fg("muted", "  no recent runs"));
        return out;
    }
    const visible = rows.slice(0, GH_CARD_HEAD_LIMIT);
    const more = rows.length - visible.length;
    const lastIndex = visible.length - 1;
    for (let i = 0; i < visible.length; i++) {
        const row = visible[i];
        if (!row) continue;
        const branchGlyph = i < lastIndex || more > 0 ? "├─" : "└─";
        const glyph = runGlyph(theme, row.status, row.conclusion);
        const workflow = theme.fg("text", row.workflow || row.title);
        const branch = theme.fg("dim", `  ${row.branch}`);
        const id = theme.fg("dim", `  ${row.id}`);
        const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${glyph} ${workflow}${branch}${id}`;
        out.push(safeTruncateToWidth(line, width, "…"));
    }
    if (more > 0) out.push(renderMoreRow(theme, "run", more, width));
    return out;
}
function renderRunViewCard(
    theme: BoxTheme,
    parsed: GhRunViewParsed,
    out: string[],
    width: number,
): string[] {
    if (parsed.trigger) {
        out.push(safeTruncateToWidth(`  ${theme.fg("dim", parsed.trigger)}`, width, "…"));
    }
    const visibleJobs = parsed.jobs.slice(0, GH_CARD_HEAD_LIMIT);
    const moreJobs = parsed.jobs.length - visibleJobs.length;
    const lastJobIndex = visibleJobs.length - 1;
    for (let i = 0; i < visibleJobs.length; i++) {
        const job = visibleJobs[i];
        if (!job) continue;
        const branchGlyph =
            i < lastJobIndex || moreJobs > 0 || parsed.annotations.length > 0 ? "├─" : "└─";
        const glyph = runStateGlyph(theme, job.state);
        const name = theme.fg(
            "toolOutput",
            `${job.name}${job.count !== undefined ? ` (${job.count})` : ""}`,
        );
        const detail = theme.fg(
            "dim",
            `${job.duration ? ` ${job.duration}` : ""}${job.id ? ` · ${job.id}` : ""}`,
        );
        const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${glyph} ${name}${detail}`;
        out.push(safeTruncateToWidth(line, width, "…"));
    }
    if (moreJobs > 0) out.push(renderMoreRow(theme, "job", moreJobs, width));
    for (let i = 0; i < parsed.annotations.length; i++) {
        const annotation = parsed.annotations[i];
        if (!annotation) continue;
        const branchGlyph = i < parsed.annotations.length - 1 ? "├─" : "└─";
        const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${theme.fg("warning", "!")} ${theme.fg("dim", annotation.text)}`;
        out.push(safeTruncateToWidth(line, width, "…"));
    }
    return out;
}
/**
 * Render the gh semantic card for one call: the header always renders (so a
 * pending call shows a single summary line); once the result parses, counts,
 * rows, and a body preview follow. `run-job` renders its header here while the
 * log body lives in the boxed result. Every line is width-safe.
 */
function renderGhCardLines(
    theme: BoxTheme,
    state: { readonly cls: GhSemanticClass; readonly parsed?: GhParsedSemantic },
    width: number,
): string[] {
    const safeWidth = Math.max(1, width);
    const out: string[] = [
        safeTruncateToWidth(ghCardHeader(theme, state.cls, state.parsed), safeWidth, "…"),
    ];
    const parsed = state.parsed;
    if (!parsed) return out;
    if (parsed.kind === "pr-list" || parsed.kind === "issue-list")
        renderListCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "pr-view" || parsed.kind === "issue-view")
        renderViewCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "pr-checks") renderChecksCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "pr-create") renderCreateCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "run-list") renderRunListCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "run-view") renderRunViewCard(theme, parsed, out, safeWidth);
    // run-job: header only — the log body renders in the boxed result.
    return out.map((line) => safeTruncateToWidth(line, safeWidth, "…"));
}
// ── Boxed run-job log result (Phase 8D) ────────────────────────────────────
// `gh run view --job=<id>` log output renders in a `renderBoxedToolResult`
// frame with a `Log · <job-id>` divider and an elapsed footer, mirroring the
// git diff boxed result. The call panel renders the boxless `Run job · <id>`
// header; the log body lives in the box. A render budget bounds very long logs
// (collapsed/expanded), and `renderBoxedToolResult` width-truncates each line.
const GH_RUN_JOB_BUDGET_COLLAPSED = 40;
const GH_RUN_JOB_BUDGET_EXPANDED = 200;
/** Build a complete boxed-log result component for a parsed `gh run view --job`. */
function renderGhRunJobResult(
    theme: BoxTheme,
    parsed: GhRunJobParsed,
    options: { expanded: boolean; isPartial: boolean },
    context: BoxedToolContext,
): Component {
    const expanded = Boolean(options.expanded);
    const elapsedMs = getStateElapsedMs(context.state);
    const footerParts: string[] = [];
    if (elapsedMs !== undefined) footerParts.push(formatElapsedMetric(theme, elapsedMs));
    const footer = footerParts.join(theme.fg("dim", " · "));
    const hasLog = parsed.lines.some((line) => line.trim() !== "");
    const budget = expanded ? GH_RUN_JOB_BUDGET_EXPANDED : GH_RUN_JOB_BUDGET_COLLAPSED;
    return renderBoxedToolResult(
        theme,
        () =>
            hasLog
                ? parsed.lines.map((line) => theme.fg("toolOutput", line))
                : [theme.fg("muted", "No log output")],
        {
            dividerLabel: `Log · ${parsed.jobId}`,
            footerLines: footer ? [footer] : [],
            renderLineBudget: budget,
            isError: context.isError,
            isPartial: options.isPartial,
        },
    );
}

// from: pistyle\features\tools\boxed\git.ts

// Git semantic view renderer (Phase 8A).
//
// Bash `git status` / `git diff --stat` / short `git log` results render as a
// boxless compact card in the call panel, mirroring the ls/find/grep tree path
// (see bash.ts, which owns the per-call registry and raw-shell fallback).
//
// Every parser is fail-closed (ADR 0005): on any ambiguity it returns null and
// the boxed command/response shell renders the raw output unchanged. Only
// values git's output actually carries are shown — `git diff --stat` bars are
// scaled, so per-file rows show the exact `| N` change count instead of a
// guessed +/− split, and the exact +/− totals come from the summary line.
// ── Classification ──────────────────────────────────────────────────────────
/** State-change git commands that render a boxless summary card (Phase 8C):
 *  `commit`/`push`/`pull`/`fetch` (8C-1) plus `switch`/`checkout`/`add`/
 *  `restore`/`reset`/`merge`/`rebase` (8C-2). Each surfaces a different shape;
 *  the parsers are fail-closed and the renderer switches on `command`. */
type GitActionCommand =
    | "commit"
    | "push"
    | "pull"
    | "fetch"
    | "switch"
    | "checkout"
    | "add"
    | "restore"
    | "reset"
    | "merge"
    | "rebase";
type GitSemanticClass =
    | { readonly kind: "status"; readonly short: boolean }
    | { readonly kind: "diff-stat" }
    | { readonly kind: "log" }
    | { readonly kind: "show-stat" }
    | { readonly kind: "diff"; readonly show: boolean }
    | { readonly kind: "action"; readonly command: GitActionCommand };
const GIT_SHORT_STATUS_FLAGS = new Set(["-s", "--short", "--porcelain"]);
const GIT_DIFF_FORMAT_REJECT = new Set([
    "-p",
    "--patch",
    "--numstat",
    "--shortstat",
    "--dirstat",
    "--summary",
    "--name-only",
    "--name-status",
    "--raw",
    "--word-diff",
]);
/** Flags that switch `git diff` patch output to a non-line-based or summary
 *  shape we cannot feed to the adaptive diff component (ADR 0005: fail-closed). */
const GIT_DIFF_PATCH_REJECT = new Set([
    "--numstat",
    "--shortstat",
    "--dirstat",
    "--summary",
    "--name-only",
    "--name-status",
    "--raw",
    "--word-diff",
    "--binary",
    "--no-patch",
    "-s",
    "--patch-with-stat",
    "--patch-with-raw",
]);
/** `git show` (plain patch output) additionally rejects `--stat` (commit + stat
 *  is a different shape) and commit-format flags that change the header. */
const GIT_SHOW_REJECT = new Set([
    ...GIT_DIFF_PATCH_REJECT,
    "--stat",
    "--oneline",
    "--format",
    "--pretty",
]);
/** `git show --stat` (commit header + stat block) rejects any other
 *  format-changing flag that would alter that shape: `-p`/`--patch` append a
 *  patch, the rest are alternate stat/format/name shapes (ADR 0005). */
const GIT_SHOW_STAT_REJECT = new Set([...GIT_DIFF_PATCH_REJECT, "-p", "--patch", "--oneline"]);
const GIT_LOG_FORMAT_REJECT = new Set([
    "-p",
    "--patch",
    "--stat",
    "--numstat",
    "--shortstat",
    "--dirstat",
    "--summary",
    "--name-only",
    "--name-status",
    "--raw",
    "--graph",
    "--format",
    "--pretty",
    "--word-diff",
    "--color",
    "--show-signature",
]);
/** `git commit` flags that change the output shape: `-v` appends the diff,
 *  `-p`/`--patch` open an editor with a patch, `-i`/`--interactive` are
 *  interactive, `--porcelain`/`--dry-run` swap to a different report
 *  (ADR 0005: fail-closed). */
const GIT_COMMIT_REJECT = new Set([
    "-v",
    "--verbose",
    "-p",
    "--patch",
    "-i",
    "--interactive",
    "--porcelain",
    "--dry-run",
]);
/** `git push` flags that change the output shape: `--porcelain` is machine
 *  format, `-v`/`--verbose` add `Pushing to`/`= [up to date]` lines, and
 *  `--dry-run` reports what would happen without doing it (ADR 0005). */
const GIT_PUSH_REJECT = new Set(["--porcelain", "-v", "--verbose", "--dry-run", "-n"]);
/** `git pull` flags that change the output shape: `-v`/`--verbose` add fetch
 *  chatter, `--rebase` produces a rebase-shaped report instead of a merge
 *  summary (ADR 0005). */
const GIT_PULL_REJECT = new Set(["-v", "--verbose", "--rebase"]);
/** `git fetch` flags that change the output shape: `-v`/`--verbose` add
 *  `= [up to date]` per-ref chatter and `--dry-run` reports without fetching
 *  (ADR 0005). */
const GIT_FETCH_REJECT = new Set(["-v", "--verbose", "--dry-run"]);
/** `git switch`/`checkout` flags that change the output shape: `-p`/`--patch`
 *  open an interactive hunk picker, `-i`/`--interactive` is the classic checkout
 *  TUI, and `--orphan` swaps the `Switched to …` line for a creation report
 *  (ADR 0005). `-m` (merge on switch) is not rejected here — its clean output
 *  still parses, and the merge-rows shape fails closed in the parser. */
const GIT_SWITCH_REJECT = new Set(["-p", "--patch", "-i", "--interactive", "--orphan"]);
/** `git add`/`restore` flags that change the output shape: `-p`/`--patch` and
 *  `-i`/`--interactive` open hunk/TUI pickers, and `-v`/`--verbose` list every
 *  staged path instead of staying silent (ADR 0005). */
const GIT_ADD_REJECT = new Set(["-p", "--patch", "-i", "--interactive", "-v", "--verbose"]);
/** `git reset` flags that change the output shape: `-p`/`--patch` opens an
 *  interactive hunk picker. The mode flags (`--soft`/`--mixed`/`--hard`) are
 *  the shapes the parser reads, so they stay classified (ADR 0005). */
const GIT_RESET_REJECT = new Set(["-p", "--patch"]);
/** `git merge` flags that change the output shape: `-v`/`--verbose` append the
 *  per-file diff. `--squash`/`--abort`/`--continue` produce different reports
 *  that fail closed in the parser (ADR 0005). */
const GIT_MERGE_REJECT = new Set(["-v", "--verbose"]);
/** `git rebase` flags that change the output shape entirely: `-i`/
 *  `--interactive` opens the commit-list editor and `-x`/`--exec` runs a shell
 *  command per commit, swapping the single success line for a different report
 *  (ADR 0005). */
const GIT_REBASE_REJECT = new Set(["-i", "--interactive", "-x", "--exec"]);
/**
 * Classify a bash command for git semantic rendering, or null to keep the
 * boxed shell. Only porcelain commands with simple output shapes are eligible
 * (`git status`, `git diff --stat`, `git log`); `git -C …`, aliases, plumbing
 * (`cat-file`, `rev-parse`, `for-each-ref`), format-changing flags, and any
 * pipe/redirect fall back raw (ADR 0005).
 */
function classifyGitCommand(command: string): GitSemanticClass | null {
    const shape = parseSimpleBashCommand(command);
    if (!shape) return null;
    const rest = shape.tokens;
    if ((rest[0] ?? "").split("/").pop() !== "git") return null;
    const args = rest.slice(1);
    if (args.length === 0) return null;
    const sub = args[0] ?? "";
    if (sub === "status") {
        // `-z`/`--porcelain=v2` switch the output format entirely; the v1 short
        // parser cannot read them.
        if (
            args.some((arg) => arg === "-z" || arg === "--null" || arg.startsWith("--porcelain=v2"))
        )
            return null;
        const short =
            args.some((arg) => GIT_SHORT_STATUS_FLAGS.has(arg) || /^-[sS][a-zA-Z]*$/.test(arg)) ||
            args.some((arg) => arg.startsWith("--porcelain=v1"));
        return { kind: "status", short };
    }
    if (sub === "diff") {
        const hasStat = args.some((arg) => arg === "--stat" || arg.startsWith("--stat="));
        if (hasStat) {
            if (
                args.some(
                    (arg) =>
                        GIT_DIFF_FORMAT_REJECT.has(arg) ||
                        arg.startsWith("--format=") ||
                        arg.startsWith("--pretty="),
                )
            ) {
                return null;
            }
            return { kind: "diff-stat" };
        }
        // Plain `git diff` (patch output) renders as a boxed adaptive diff. Reject
        // format-changing flags; `-p`/`--patch` is the default patch shape and stays.
        if (args.some((arg) => GIT_DIFF_PATCH_REJECT.has(arg) || arg.startsWith("--word-diff="))) {
            return null;
        }
        return { kind: "diff", show: false };
    }
    if (sub === "show") {
        const hasStat = args.some((arg) => arg === "--stat" || arg.startsWith("--stat="));
        if (hasStat) {
            // `git show --stat` = commit header + stat block → a diff-stat-shaped
            // card. Reject any other format-changing flag (a patch, numstat,
            // name-only, format override, …). `-p`/`--patch` append a patch; combined
            // short clusters containing `p` (e.g. `-sp`) do too.
            if (
                args.some(
                    (arg) =>
                        GIT_SHOW_STAT_REJECT.has(arg) ||
                        /^-[A-Za-z]*p[A-Za-z]*$/.test(arg) ||
                        arg.startsWith("--word-diff=") ||
                        arg.startsWith("--format=") ||
                        arg.startsWith("--pretty="),
                )
            ) {
                return null;
            }
            return { kind: "show-stat" };
        }
        // Plain `git show` (patch output) renders as a boxed adaptive diff. Reject
        // format-changing flags; `-p`/`--patch` is the default patch shape and stays.
        if (
            args.some(
                (arg) =>
                    GIT_SHOW_REJECT.has(arg) ||
                    arg.startsWith("--word-diff=") ||
                    arg.startsWith("--format=") ||
                    arg.startsWith("--pretty="),
            )
        ) {
            return null;
        }
        return { kind: "diff", show: true };
    }
    if (sub === "log") {
        if (
            args.some(
                (arg) =>
                    GIT_LOG_FORMAT_REJECT.has(arg) ||
                    arg.startsWith("--format=") ||
                    arg.startsWith("--pretty="),
            )
        ) {
            return null;
        }
        return { kind: "log" };
    }
    if (sub === "commit") {
        if (
            args.some((arg) => GIT_COMMIT_REJECT.has(arg) || /^-[A-Za-z]*[vpi][A-Za-z]*$/.test(arg))
        )
            return null;
        return { kind: "action", command: "commit" };
    }
    if (sub === "push") {
        if (args.some((arg) => GIT_PUSH_REJECT.has(arg) || /^-[A-Za-z]*[vn][A-Za-z]*$/.test(arg)))
            return null;
        return { kind: "action", command: "push" };
    }
    if (sub === "pull") {
        if (args.some((arg) => GIT_PULL_REJECT.has(arg) || /^-[A-Za-z]*v[A-Za-z]*$/.test(arg)))
            return null;
        return { kind: "action", command: "pull" };
    }
    if (sub === "fetch") {
        if (args.some((arg) => GIT_FETCH_REJECT.has(arg) || /^-[A-Za-z]*v[A-Za-z]*$/.test(arg)))
            return null;
        return { kind: "action", command: "fetch" };
    }
    if (sub === "switch" || sub === "checkout") {
        // Reject interactive patch/TUI and orphan; `-m` stays (clean output parses,
        // merge-rows shape fails closed). Short clusters containing `p`/`i` cover
        // `-p`/`-i` bundled with other flags.
        if (args.some((arg) => GIT_SWITCH_REJECT.has(arg) || /^-[A-Za-z]*[pi][A-Za-z]*$/.test(arg)))
            return null;
        return { kind: "action", command: sub };
    }
    if (sub === "add" || sub === "restore") {
        // Reject interactive patch/TUI and verbose; `-A`/`-u`/`-f`/`-S`/`-W` stay.
        if (args.some((arg) => GIT_ADD_REJECT.has(arg) || /^-[A-Za-z]*[piv][A-Za-z]*$/.test(arg)))
            return null;
        return { kind: "action", command: sub };
    }
    if (sub === "reset") {
        // Reject interactive patch; the mode flags (`--soft`/`--mixed`/`--hard`)
        // are the shapes the parser reads.
        if (args.some((arg) => GIT_RESET_REJECT.has(arg) || /^-[A-Za-z]*p[A-Za-z]*$/.test(arg)))
            return null;
        return { kind: "action", command: "reset" };
    }
    if (sub === "merge") {
        // Reject verbose; `--squash`/`--abort`/`--continue` fail closed in the parser.
        if (args.some((arg) => GIT_MERGE_REJECT.has(arg) || /^-[A-Za-z]*v[A-Za-z]*$/.test(arg)))
            return null;
        return { kind: "action", command: "merge" };
    }
    if (sub === "rebase") {
        // Reject interactive/exec; `--abort`/`--continue`/`--skip` fail closed.
        if (
            args.some(
                (arg) =>
                    GIT_REBASE_REJECT.has(arg) ||
                    arg.startsWith("--exec=") ||
                    /^-[A-Za-z]*[ix][A-Za-z]*$/.test(arg),
            )
        )
            return null;
        return { kind: "action", command: "rebase" };
    }
    return null;
}
// ── Parsed shapes ───────────────────────────────────────────────────────────
interface GitStatusFile {
    /** Index (staged) status char: `M`/`A`/`D`/`R`/`C`/`T`/`U`/`?`/`!` or space. */
    readonly x: string;
    /** Worktree (unstaged) status char, or space. */
    readonly y: string;
    /** Display path; renames carry `old -> new`. */
    readonly path: string;
}
interface GitStatusParsed {
    readonly kind: "status";
    readonly branch?: string;
    readonly ahead?: number;
    readonly behind?: number;
    readonly diverged?: boolean;
    readonly files: readonly GitStatusFile[];
}
interface GitDiffStatFile {
    readonly path: string;
    /** Exact changed-line count from the `| N` column (absent for binary files). */
    readonly changes?: number;
    readonly binary?: boolean;
}
/** Per-file stat summary shared by `git diff --stat` and `git show --stat`
 *  (the show-stat card adds a commit header on top of these rows). */
interface DiffStatSummary {
    readonly files: readonly GitDiffStatFile[];
    readonly filesChanged?: number;
    readonly insertions?: number;
    readonly deletions?: number;
}
interface GitDiffStatParsed extends DiffStatSummary {
    readonly kind: "diff-stat";
}
/** `git show --stat`: full-format commit header (hash + first message-line
 *  subject) followed by the same per-file stat block as `git diff --stat`. */
interface GitShowStatParsed extends DiffStatSummary {
    readonly kind: "show-stat";
    /** Full commit hash from the `commit <hash>` header (shortened for display). */
    readonly hash: string;
    readonly subject: string;
}
interface GitLogCommit {
    readonly hash: string;
    readonly refs?: string;
    readonly subject: string;
}
interface GitLogParsed {
    readonly kind: "log";
    readonly commits: readonly GitLogCommit[];
}
interface GitDiffFile {
    /** Display path (renames carry `old => new`). */
    readonly path: string;
    readonly status?: "added" | "deleted" | "renamed" | "modified";
    readonly binary?: boolean;
    readonly additions: number;
    readonly removals: number;
    /** Normalized edit-format diff body for `AdaptiveDiffComponent` (empty for binary). */
    readonly body: string;
}
interface GitDiffParsed {
    readonly kind: "diff";
    readonly show: boolean;
    /** `git show`: short commit hash from the commit header. */
    readonly hash?: string;
    /** `git show`: first message-line subject. */
    readonly subject?: string;
    readonly files: readonly GitDiffFile[];
}
/** `git commit` / `push` / `pull` / `fetch` / `switch` / `checkout` / `add` /
 *  `restore` / `reset` / `merge` / `rebase` state-change results. Each command
 *  surfaces a different subset of fields; the renderer switches on `command`.
 *  Stat summaries (commit / pull fast-forward / merge) reuse the diff-stat
 *  shape so the same `N files changed · +A -D` line and `├─/└─` rows render
 *  verbatim. */
interface GitActionParsed extends DiffStatSummary {
    readonly kind: "action";
    readonly command: GitActionCommand;
    /** `git commit` success: branch from `[<branch> <hash>]` (status line owns
     *  the `⎇ main` glyph, so this is not rendered). */
    readonly branch?: string;
    /** `git commit` success: short hash from `[<branch> <hash>]`; also
     *  `git reset --hard`: the `HEAD is now at <hash>` target. */
    readonly hash?: string;
    /** `git commit` success: commit subject line; also `git reset --hard`:
     *  the `HEAD is now at <hash> <subject>` subject. */
    readonly subject?: string;
    /** `git push` / `git fetch`: remote URL/path from the `To `/`From ` line. */
    readonly remote?: string;
    /** `git push` / `git fetch`: normalized ref-update rows (alignment spaces
     *  collapsed to single spaces). */
    readonly refs?: readonly string[];
    /** Informational status line: `nothing to commit`, `Everything up-to-date`,
     *  `Already up to date.`, `Fast-forward`, `no new refs`, `Merge made by the
     *  'ort' strategy.`, or `completed, no output` for silent success
     *  (`add`/`restore`/`reset --soft`/`checkout -- <file>`). */
    readonly status?: string;
    /** `git pull` / `git merge` fast-forward: the `Updating <a>..<b>` range. */
    readonly range?: string;
    /** `git switch -c` / `git checkout -b`: the branch was created, not just
     *  switched to (controls the confirmation row wording). */
    readonly created?: boolean;
    /** `git reset` (mixed): status-marker + path rows from the
     *  `Unstaged changes after reset:` block (marker in `x`, `y` is space). */
    readonly resetFiles?: readonly GitStatusFile[];
}
type GitParsedSemantic =
    | GitStatusParsed
    | GitDiffStatParsed
    | GitShowStatParsed
    | GitLogParsed
    | GitDiffParsed
    | GitActionParsed;
// ── git status parsers ──────────────────────────────────────────────────────
/** Long-form section verbs → `(index, worktree)` status chars. */
const LONG_STATUS_VERBS: Readonly<Record<string, readonly [string, string]>> = {
    "new file": ["A", " "],
    modified: ["M", " "],
    deleted: ["D", " "],
    renamed: ["R", " "],
    copied: ["C", " "],
    typechange: ["T", " "],
    "both modified": ["U", "U"],
    "both added": ["A", "A"],
    "both deleted": ["D", "D"],
    "added by us": ["A", "U"],
    "added by them": ["U", "A"],
    "deleted by us": ["D", "U"],
    "deleted by them": ["U", "D"],
    unmerged: ["U", "U"],
};
type LongSection = "staged" | "unstaged" | "untracked" | "ignored" | "unmerged" | null;
const LONG_SECTION_HEADERS: Readonly<Record<string, LongSection>> = {
    "Changes to be committed:": "staged",
    "Changes not staged for commit:": "unstaged",
    "Untracked files:": "untracked",
    "Ignored files:": "ignored",
    "Unmerged paths:": "unmerged",
};
const LONG_STATUS_ENTRY = /^([a-z ]+?):\s+(.+)$/;
const LONG_BRANCH = /^On branch (.+)$/;
const LONG_DETACHED = /^HEAD detached at ([0-9a-f]+)/;
const LONG_AHEAD = /^Your branch is ahead of '(.*)' by (\d+) commit/;
const LONG_BEHIND = /^Your branch is behind '(.*)' by (\d+) commit/;
const LONG_DIVERGED = /^Your branch and '(.*)' have diverged/;
const LONG_DIVERGED_COUNTS = /^and have (\d+) and (\d+) different commits each/;
function parseGitStatusLong(text: string): GitStatusParsed | null {
    const files: GitStatusFile[] = [];
    let branch: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    let diverged = false;
    let section: LongSection = null;
    let divergedNext = false;
    let sawContent = false;
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        const branchMatch = LONG_BRANCH.exec(line);
        if (branchMatch) {
            sawContent = true;
            branch = branchMatch[1];
            continue;
        }
        const detached = LONG_DETACHED.exec(line);
        if (detached) {
            sawContent = true;
            branch = detached[1];
            continue;
        }
        const aheadMatch = LONG_AHEAD.exec(line);
        if (aheadMatch) {
            sawContent = true;
            ahead = Number(aheadMatch[2]);
            continue;
        }
        const behindMatch = LONG_BEHIND.exec(line);
        if (behindMatch) {
            sawContent = true;
            behind = Number(behindMatch[2]);
            continue;
        }
        const divergedMatch = LONG_DIVERGED.exec(line);
        if (divergedMatch) {
            sawContent = true;
            diverged = true;
            divergedNext = true;
            continue;
        }
        if (divergedNext) {
            const counts = LONG_DIVERGED_COUNTS.exec(line);
            if (!counts) return null;
            sawContent = true;
            ahead = Number(counts[1]);
            behind = Number(counts[2]);
            divergedNext = false;
            continue;
        }
        const sectionHeader = LONG_SECTION_HEADERS[line];
        if (sectionHeader !== undefined) {
            sawContent = true;
            section = sectionHeader;
            continue;
        }
        // Hint lines (`  (use "git add …" …)`, `  (fix conflicts …)`) and
        // clean/empty-state markers.
        if (/^\s{2}\(/.test(line)) continue;
        if (
            line.startsWith("no changes added to commit") ||
            line === "nothing to commit, working tree clean" ||
            line === "You have unmerged paths." ||
            line === "No commits yet"
        ) {
            sawContent = true;
            continue;
        }
        if (line.startsWith("Your branch is up to date with ")) {
            sawContent = true;
            continue;
        }
        if (line.startsWith("\t")) {
            const body = line.slice(1).trimStart();
            if (!body) return null;
            // Untracked/ignored entries are bare paths.
            if (section === "untracked" || section === "ignored") {
                const mark = section === "untracked" ? "?" : "!";
                sawContent = true;
                files.push({ x: mark, y: mark, path: body });
                continue;
            }
            const verbMatch = LONG_STATUS_ENTRY.exec(body);
            if (!verbMatch) return null;
            const xy = LONG_STATUS_VERBS[verbMatch[1] ?? ""];
            if (!xy) return null; // unknown verb (localized git, unexpected section)
            const path = (verbMatch[2] ?? "").trim();
            if (!path) return null;
            sawContent = true;
            if (section === "staged") files.push({ x: xy[0], y: " ", path });
            else if (section === "unstaged") files.push({ x: " ", y: xy[0], path });
            else files.push({ x: xy[0], y: xy[1], path });
            continue;
        }
        return null; // unrecognized non-tab line → localized/hostile output
    }
    if (divergedNext) return null;
    if (!sawContent) return null;
    return {
        kind: "status",
        files,
        ...(branch !== undefined ? { branch } : {}),
        ...(ahead !== undefined ? { ahead } : {}),
        ...(behind !== undefined ? { behind } : {}),
        ...(diverged ? { diverged: true } : {}),
    };
}
const SHORT_STATUS_BRANCH = /^## (.+)$/;
const SHORT_STATUS_BRANCH_DETAIL = /^(.+?)(?:\.\.\.(.+?))?(?: \[([^\]]+)\])?$/;
const SHORT_STATUS_FILE = /^([ MADRCU?!])([ MADRCU?!]) (.*)$/;
function parseGitStatusShort(text: string): GitStatusParsed | null {
    if (text.includes("\u0000")) return null; // `-z` NUL-separated format
    const files: GitStatusFile[] = [];
    let branch: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    let diverged = false;
    let sawStatus = false;
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        const branchLine = SHORT_STATUS_BRANCH.exec(line);
        if (branchLine) {
            sawStatus = true;
            const detail = SHORT_STATUS_BRANCH_DETAIL.exec(branchLine[1] ?? "");
            if (detail) {
                branch = detail[1];
                const bracket = detail[3];
                if (bracket) {
                    const aheadM = /ahead (\d+)/.exec(bracket);
                    const behindM = /behind (\d+)/.exec(bracket);
                    if (aheadM) ahead = Number(aheadM[1]);
                    if (behindM) behind = Number(behindM[1]);
                    if (aheadM && behindM) diverged = true;
                    // `[gone]` and other bracket states carry no counts — ignored.
                }
            }
            continue;
        }
        const fileMatch = SHORT_STATUS_FILE.exec(line);
        if (!fileMatch) return null; // unrecognized line → hostile output
        sawStatus = true;
        files.push({ x: fileMatch[1] ?? "", y: fileMatch[2] ?? "", path: fileMatch[3] ?? "" });
    }
    if (!sawStatus && text.trim() !== "") return null;
    return {
        kind: "status",
        files,
        ...(branch !== undefined ? { branch } : {}),
        ...(ahead !== undefined ? { ahead } : {}),
        ...(behind !== undefined ? { behind } : {}),
        ...(diverged ? { diverged: true } : {}),
    };
}
function parseGitStatus(cls: GitSemanticClass, text: string): GitStatusParsed | null {
    if (cls.kind !== "status") return null;
    return cls.short ? parseGitStatusShort(text) : parseGitStatusLong(text);
}
// ── git diff --stat parser ──────────────────────────────────────────────────
const DIFF_STAT_SUMMARY =
    /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;
const DIFF_STAT_FILE = /^(.*)\s+\|\s+(\d+)\s*.*$/;
const DIFF_STAT_BINARY = /^(.*)\s+\|\s+Bin\s+.*$/;
function parseGitDiffStat(text: string): GitDiffStatParsed | null {
    const files: GitDiffStatFile[] = [];
    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;
    let sawLine = false;
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        sawLine = true;
        const summary = DIFF_STAT_SUMMARY.exec(line);
        if (summary) {
            filesChanged = Number(summary[1]);
            if (summary[2] !== undefined) insertions = Number(summary[2]);
            if (summary[3] !== undefined) deletions = Number(summary[3]);
            continue;
        }
        const binary = DIFF_STAT_BINARY.exec(line);
        if (binary) {
            const path = (binary[1] ?? "").trim();
            if (!path) return null;
            files.push({ path, binary: true });
            continue;
        }
        const file = DIFF_STAT_FILE.exec(line);
        if (file) {
            const path = (file[1] ?? "").trim();
            if (!path) return null;
            files.push({ path, changes: Number(file[2]) });
            continue;
        }
        return null; // unrecognized line (--numstat/-z output, stat=width oddities)
    }
    if (!sawLine) return { kind: "diff-stat", files }; // empty diff → no changes
    if (files.length === 0 && filesChanged === undefined) return null;
    return {
        kind: "diff-stat",
        files,
        ...(filesChanged !== undefined ? { filesChanged } : {}),
        ...(insertions !== undefined ? { insertions } : {}),
        ...(deletions !== undefined ? { deletions } : {}),
    };
}
// ── git log parser ──────────────────────────────────────────────────────────
const LOG_COMMIT_LINE = /^commit ([0-9a-f]{4,40})(?: \((.*)\))?$/;
const LOG_ONELINE = /^([0-9a-f]{4,40})(?: \(([^)]*)\))?\s*(.*)$/;
const LOG_HEADER_LINE = /^(?:Author|Date|Merge):/;
const LOG_MESSAGE_LINE = /^\s{4}(.*)$/;
function parseGitLog(text: string): GitLogParsed | null {
    const lines = text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return { kind: "log", commits: [] };
    // Oneline format (`git log --oneline`): every line is `hash [refs] subject`.
    if (lines.every((line) => LOG_ONELINE.test(line))) {
        const commits = lines.map((line) => {
            const match = LOG_ONELINE.exec(line);
            const refs = match?.[2];
            return {
                hash: match?.[1] ?? "",
                ...(refs ? { refs } : {}),
                subject: (match?.[3] ?? "").trim(),
            };
        });
        return { kind: "log", commits };
    }
    // Full format: `commit <hash> [refs]` blocks with Author/Date/Merge headers
    // and a 4-space-indented message.
    const commits: GitLogCommit[] = [];
    let current: { hash: string; refs?: string; subject: string } | null = null;
    for (const line of lines) {
        const start = LOG_COMMIT_LINE.exec(line);
        if (start) {
            current = {
                hash: start[1] ?? "",
                ...(start[2] ? { refs: start[2] } : {}),
                subject: "",
            };
            commits.push(current);
            continue;
        }
        if (!current) return null;
        if (LOG_HEADER_LINE.test(line)) continue;
        const message = LOG_MESSAGE_LINE.exec(line);
        if (message) {
            if (current.subject === "") current.subject = (message[1] ?? "").trim();
            continue;
        }
        return null; // unexpected line inside a commit block (patch/format output)
    }
    if (commits.length === 0) return null;
    return { kind: "log", commits };
}
// ── git show --stat parser ───────────────────────────────────────────────────
// `git show --stat` = a full-format commit header (the same shape `parseGitLog`
// reads: `commit <hash>`, Author/Date/Merge, 4-space-indented message) followed
// by the same stat block `parseGitDiffStat` reads. The header is consumed first
// (subject = first message line), then the remainder is handed to the diff-stat
// line parser; any hostile line fails closed → raw boxed shell (ADR 0005).
function parseGitShowStat(text: string): GitShowStatParsed | null {
    const lines = String(text ?? "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trimEnd());
    let i = 0;
    while (i < lines.length && (lines[i] ?? "") === "") i++; // skip leading blanks
    if (i >= lines.length) return null;
    const commitMatch = LOG_COMMIT_LINE.exec(lines[i] ?? "");
    if (!commitMatch) return null; // not a `git show` commit header
    const hash = commitMatch[1] ?? "";
    i++;
    let subject = "";
    // Consume the commit header: Author/Date/Merge lines, blank lines, and the
    // 4-space-indented message block (subject = first message line). The first
    // line that is none of these begins the stat block. Stat rows carry only a
    // single leading space, so they never match the 4-space message pattern.
    while (i < lines.length) {
        const line = lines[i] ?? "";
        if (line === "") {
            i++;
            continue;
        }
        if (LOG_HEADER_LINE.test(line)) {
            i++;
            continue;
        }
        const message = LOG_MESSAGE_LINE.exec(line);
        if (message) {
            if (subject === "") subject = (message[1] ?? "").trim();
            i++;
            continue;
        }
        break;
    }
    // The remainder is the diff-stat block (empty for a commit with no file
    // changes). Reuse the diff-stat line parser, fail-closed on hostile lines.
    const stat = parseGitDiffStat(lines.slice(i).join("\n"));
    if (!stat) return null;
    return {
        kind: "show-stat",
        hash,
        subject,
        files: stat.files,
        ...(stat.filesChanged !== undefined ? { filesChanged: stat.filesChanged } : {}),
        ...(stat.insertions !== undefined ? { insertions: stat.insertions } : {}),
        ...(stat.deletions !== undefined ? { deletions: stat.deletions } : {}),
    };
}
// ── git diff / git show parser ──────────────────────────────────────────────
// Splits unified diff output into per-file chunks, strips file headers and
// hunk headers, and converts content lines into the numbered `<prefix> <num>
// <content>` shape `buildSplitRows` (the `AdaptiveDiffComponent` input) reads.
// Every ambiguity returns null → the boxed Bash shell renders raw (ADR 0005).
const DIFF_GIT_HEADER = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const NEW_FILE_MODE = /^new file mode /;
const DELETED_FILE_MODE = /^deleted file mode /;
/** Strip the `a/` / `b/` prefix (and surrounding quotes) from a `--- `/`+++ ` path. */
function stripDiffPathPrefix(rawPath: string): string {
    let path = rawPath;
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path.startsWith("a/")) return path.slice(2);
    if (path.startsWith("b/")) return path.slice(2);
    return path;
}
function parseDiffChunk(chunk: readonly string[]): GitDiffFile | null {
    const header = chunk[0] ?? "";
    const dgMatch = DIFF_GIT_HEADER.exec(header);
    if (!dgMatch) return null;
    const dgOld = dgMatch[1] ?? undefined;
    const dgNew = dgMatch[2] ?? undefined;
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let status: GitDiffFile["status"];
    let binary = false;
    let renameDetected = false;
    const bodyLines: string[] = [];
    let additions = 0;
    let removals = 0;
    let inHunk = false;
    let oldLine = 0;
    let newLine = 0;
    for (let i = 1; i < chunk.length; i++) {
        const line = chunk[i] ?? "";
        const hunk = HUNK_HEADER.exec(line);
        if (hunk) {
            oldLine = Number(hunk[1] ?? 0);
            newLine = Number(hunk[2] ?? 0);
            inHunk = true;
            continue;
        }
        if (!inHunk) {
            if (line === "") continue; // section separator
            if (line.startsWith("index ")) continue;
            if (NEW_FILE_MODE.test(line)) {
                status = "added";
                continue;
            }
            if (DELETED_FILE_MODE.test(line)) {
                status = "deleted";
                continue;
            }
            if (line.startsWith("old mode ") || line.startsWith("new mode ")) continue;
            if (line.startsWith("similarity index ") || line.startsWith("dissimilarity index ")) {
                renameDetected = true;
                continue;
            }
            if (line.startsWith("rename from ")) {
                oldPath = line.slice("rename from ".length);
                renameDetected = true;
                status = "renamed";
                continue;
            }
            if (line.startsWith("rename to ")) {
                newPath = line.slice("rename to ".length);
                renameDetected = true;
                status = "renamed";
                continue;
            }
            if (line.startsWith("copy from ") || line.startsWith("copy to ")) continue;
            if (line.startsWith("--- ")) {
                const value = line.slice(4);
                if (value !== "/dev/null") oldPath = stripDiffPathPrefix(value);
                continue;
            }
            if (line.startsWith("+++ ")) {
                const value = line.slice(4);
                if (value !== "/dev/null") newPath = stripDiffPathPrefix(value);
                continue;
            }
            if (line.startsWith("Binary files ") || line === "Binary files differ") {
                binary = true;
                const bm = line.match(/^Binary files (?:a\/(\S*) )?and (?:b\/(\S*) )?differ/);
                if (bm) {
                    if (!oldPath && bm[1]) oldPath = bm[1];
                    if (!newPath && bm[2]) newPath = bm[2];
                }
                continue;
            }
            if (line.startsWith("GIT binary patch")) return null; // unparseable binary patch body
            return null; // unrecognized header line → hostile/localized output
        }
        // inside a hunk
        if (line.startsWith("\\ No newline")) continue;
        if (line.startsWith("+")) {
            bodyLines.push(`+ ${newLine} ${line.slice(1)}`);
            newLine++;
            additions++;
            continue;
        }
        if (line.startsWith("-")) {
            bodyLines.push(`- ${oldLine} ${line.slice(1)}`);
            oldLine++;
            removals++;
            continue;
        }
        if (line.startsWith(" ")) {
            bodyLines.push(` ${oldLine} ${line.slice(1)}`);
            oldLine++;
            newLine++;
            continue;
        }
        if (line === "") {
            // Blank context line whose leading space was stripped (trailing-ws
            // safety): keep it as an empty context row so the diff stays aligned.
            bodyLines.push(` ${oldLine} `);
            oldLine++;
            newLine++;
            continue;
        }
        return null; // unexpected line inside a hunk
    }
    if (!newPath) newPath = dgNew;
    if (!oldPath) oldPath = dgOld;
    let displayPath: string;
    if (renameDetected && oldPath && newPath && oldPath !== newPath) {
        displayPath = `${oldPath} => ${newPath}`;
    } else {
        displayPath = newPath ?? oldPath ?? "(unknown)";
    }
    if (!status) {
        if (binary) status = "modified";
        else if (oldPath && newPath) status = "modified";
        else if (newPath && !oldPath) status = "added";
        else if (oldPath && !newPath) status = "deleted";
    }
    return {
        path: displayPath,
        ...(status ? { status } : {}),
        ...(binary ? { binary: true } : {}),
        additions,
        removals,
        body: bodyLines.join("\n"),
    };
}
function parseUnifiedDiff(text: string): GitDiffFile[] | null {
    if (text === "") return []; // empty diff (no changes)
    const lines = text.split("\n");
    // Drop a single trailing empty line produced by the final newline.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const chunks: string[][] = [];
    let current: string[] | null = null;
    for (const line of lines) {
        if (line.startsWith("diff --git ")) {
            if (current) chunks.push(current);
            current = [line];
        } else if (current) {
            current.push(line);
        } else {
            return null; // content before the first `diff --git` (unrecognized prefix)
        }
    }
    if (current) chunks.push(current);
    if (chunks.length === 0) return null;
    const files: GitDiffFile[] = [];
    for (const chunk of chunks) {
        const file = parseDiffChunk(chunk);
        if (!file) return null;
        files.push(file);
    }
    return files;
}
const SHOW_COMMIT_LINE = /^commit ([0-9a-f]{4,40})/;
const SHOW_SUBJECT_LINE = /^ {4}(.+)$/;
function parseGitDiff(text: string, show: boolean): GitDiffParsed | null {
    const raw = String(text ?? "").replace(/\r/g, "");
    let body = raw;
    let hash: string | undefined;
    let subject: string | undefined;
    if (show) {
        const diffIndex = raw.indexOf("diff --git");
        if (diffIndex < 0) return null; // commit with no patch / blob content → raw shell
        const headerPart = raw.slice(0, diffIndex);
        body = raw.slice(diffIndex);
        const commitMatch = SHOW_COMMIT_LINE.exec(headerPart);
        if (commitMatch) hash = commitMatch[1];
        for (const headerLine of headerPart.split("\n")) {
            const subjectMatch = SHOW_SUBJECT_LINE.exec(headerLine);
            if (subjectMatch) {
                subject = (subjectMatch[1] ?? "").trim();
                break;
            }
        }
    }
    const files = parseUnifiedDiff(body);
    if (!files) return null;
    return {
        kind: "diff",
        show,
        files,
        ...(hash !== undefined ? { hash } : {}),
        ...(subject !== undefined ? { subject } : {}),
    };
}
// ── git commit / push / pull / fetch parsers ─────────────────────────────────
// State-change commands render a boxless summary card when their output parses
// (ADR 0005). Every parser is fail-closed: a single unrecognized line returns
// null and the boxed Bash shell renders raw. `git commit` with nothing staged
// exits nonzero; those informational exit-1 shapes (clean tree, unstaged-only)
// still parse to a `nothing to commit` card, while genuine errors (push
// rejected, hook failure) hold an unrecognized line and fall back raw.
/** `[<branch> <hash>] <subject>` — the first line of a successful commit. */
const COMMIT_SUCCESS = /^\[(\S+) ([0-9a-f]{7,40})\] (.*)$/;
/** Ref-update line with a status marker + bracketed/bare label, after leading
 *  whitespace is trimmed: `* [new branch] src -> dst`, `* branch src -> dst`,
 *  `= [up to date] src -> dst`. `!` (rejected) is excluded so rejected pushes
 *  fall back to the raw shell instead of rendering a partial card. */
const REF_CHAR_LABEL = /^([*=.-]) (?:\[([^\]]*)\]|(\S+))\s+(\S+)\s+->\s+(\S+)$/;
/** Ref-update line carrying a hash range (update), after trimming:
 *  `<a>..<b> src -> dst`. */
const REF_RANGE = /^([0-9a-f]{4,}\.\.[0-9a-f]{4,})\s+(\S+)\s+->\s+(\S+)$/;
/** Normalize a push/fetch ref-update line by collapsing alignment whitespace
 *  to single spaces. Returns null when the line is neither a char-labeled nor a
 *  range ref update (caller fails closed). */
function normalizeRefLine(trimmed: string): string | null {
    const labeled = REF_CHAR_LABEL.exec(trimmed);
    if (labeled) {
        const marker = labeled[1] ?? "";
        const label = labeled[2] !== undefined ? `[${labeled[2]}]` : (labeled[3] ?? "");
        return `${marker} ${label} ${labeled[4]} -> ${labeled[5]}`;
    }
    const range = REF_RANGE.exec(trimmed);
    if (range) return `${range[1]} ${range[2]} -> ${range[3]}`;
    return null;
}
/** Push/fetch progress chatter lines (stderr mixed into the captured output)
 *  that carry no ref information — skipped without failing the parse. */
function isProgressNoise(line: string): boolean {
    return (
        /^(?:Enumerating|Counting|Compressing|Writing|Deltaing|Resolving|Using) objects:/i.test(
            line,
        ) ||
        /^Total \d+/i.test(line) ||
        line.startsWith("remote: ") ||
        line.startsWith("remote:")
    );
}
function parseGitCommit(text: string): GitActionParsed | null {
    const lines = String(text ?? "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trimEnd());
    let start = 0;
    while (start < lines.length && (lines[start] ?? "") === "") start++;
    let end = lines.length;
    while (end > start && (lines[end - 1] ?? "") === "") end--;
    const body = lines.slice(start, end);
    if (body.length === 0) return null;
    const head = COMMIT_SUCCESS.exec(body[0] ?? "");
    if (head) {
        const branch = head[1] ?? "";
        const hash = head[2] ?? "";
        const subject = (head[3] ?? "").trim();
        if (!branch || !hash) return null;
        // Without `-v` only an optional summary line follows; any other extra line
        // (a per-file row, editor output) fails closed.
        let filesChanged: number | undefined;
        let insertions: number | undefined;
        let deletions: number | undefined;
        for (const line of body.slice(1)) {
            const summary = DIFF_STAT_SUMMARY.exec(line);
            if (!summary) return null;
            filesChanged = Number(summary[1]);
            if (summary[2] !== undefined) insertions = Number(summary[2]);
            if (summary[3] !== undefined) deletions = Number(summary[3]);
        }
        return {
            kind: "action",
            command: "commit",
            files: [],
            branch,
            hash,
            ...(subject ? { subject } : {}),
            ...(filesChanged !== undefined ? { filesChanged } : {}),
            ...(insertions !== undefined ? { insertions } : {}),
            ...(deletions !== undefined ? { deletions } : {}),
        };
    }
    // `git commit` with nothing to commit exits 1: either a clean tree or
    // unstaged/untracked-only changes. Both carry `On branch <name>` and a
    // terminator line; render a single `nothing to commit` row.
    const first = body[0] ?? "";
    const last = body[body.length - 1] ?? "";
    const cleanNothing = body.some((line) => line === "nothing to commit, working tree clean");
    const unstagedNothing = last.startsWith("no changes added to commit");
    if (/^On branch .+/.test(first) && (cleanNothing || unstagedNothing)) {
        return { kind: "action", command: "commit", files: [], status: "nothing to commit" };
    }
    return null;
}
function parseGitPush(text: string): GitActionParsed | null {
    let remote: string | undefined;
    let status: string | undefined;
    const refs: string[] = [];
    let sawContent = false;
    for (const rawLine of String(text ?? "")
        .replace(/\r/g, "")
        .split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        if (isProgressNoise(line)) continue;
        if (/^branch '.*' set up to track '.*'\.$/.test(line)) continue; // tracking info
        if (line.startsWith("Pushing to ")) continue; // verbose (rejected) preamble
        const toLine = /^To (.+)$/.exec(line);
        if (toLine) {
            sawContent = true;
            remote = toLine[1] ?? "";
            continue;
        }
        if (line === "Everything up-to-date") {
            sawContent = true;
            status = "Everything up-to-date";
            continue;
        }
        const ref = normalizeRefLine(line.trim());
        if (ref) {
            sawContent = true;
            refs.push(ref);
            continue;
        }
        return null; // rejected (`! [...]`), error:, or unknown line → fail closed
    }
    if (!sawContent) return null;
    return {
        kind: "action",
        command: "push",
        files: [],
        ...(remote !== undefined ? { remote } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(refs.length > 0 ? { refs } : {}),
    };
}
function parseGitPull(text: string): GitActionParsed | null {
    const lines = String(text ?? "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trimEnd());
    const nonEmpty = lines.filter((line) => line !== "");
    if (nonEmpty.length === 0) return null;
    if (nonEmpty.length === 1 && nonEmpty[0] === "Already up to date.") {
        return { kind: "action", command: "pull", files: [], status: "Already up to date." };
    }
    // Fast-forward: an optional `From <url>`/ref block, then `Updating a..b`,
    // `Fast-forward`, and the same per-file stat block `git diff --stat` reads.
    let range: string | undefined;
    let ffIndex = -1;
    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx] ?? "";
        if (line === "") continue;
        if (line.startsWith("From ")) continue;
        if (/^\s+[0-9a-f]{4,}\.\.[0-9a-f]{4,}\s+.+ -> .+$/.test(line)) continue; // fetch-style ref row
        const updating = /^Updating ([0-9a-f]{4,}\.\.[0-9a-f]{4,})$/.exec(line);
        if (updating) {
            range = updating[1] ?? "";
            continue;
        }
        if (line === "Fast-forward") {
            ffIndex = idx;
            break;
        }
        return null; // merge output, conflict markers, localized text → fail closed
    }
    if (!range || ffIndex < 0) return null;
    const stat = parseGitDiffStat(lines.slice(ffIndex + 1).join("\n"));
    if (!stat) return null;
    return {
        kind: "action",
        command: "pull",
        files: stat.files,
        status: "Fast-forward",
        range,
        ...(stat.filesChanged !== undefined ? { filesChanged: stat.filesChanged } : {}),
        ...(stat.insertions !== undefined ? { insertions: stat.insertions } : {}),
        ...(stat.deletions !== undefined ? { deletions: stat.deletions } : {}),
    };
}
function parseGitFetch(text: string): GitActionParsed | null {
    let remote: string | undefined;
    const refs: string[] = [];
    let sawContent = false;
    for (const rawLine of String(text ?? "")
        .replace(/\r/g, "")
        .split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        if (isProgressNoise(line)) continue;
        const fromLine = /^From (.+)$/.exec(line);
        if (fromLine) {
            sawContent = true;
            remote = fromLine[1] ?? "";
            continue;
        }
        const ref = normalizeRefLine(line.trim());
        if (ref) {
            sawContent = true;
            refs.push(ref);
            continue;
        }
        return null; // unknown line → fail closed
    }
    if (!sawContent) return { kind: "action", command: "fetch", files: [], status: "no new refs" };
    return {
        kind: "action",
        command: "fetch",
        files: [],
        ...(remote !== undefined ? { remote } : {}),
        ...(refs.length > 0 ? { refs } : {}),
    };
}
/** Lines appended to a merge/pull fast-forward stat block (after the summary)
 *  that carry no per-file change count — file mode/creation/deletion/rename
 *  notices. Filtered before the diff-stat line parser runs so merge stat
 *  blocks parse; legit stat rows (`path | N`, `path | Bin`, the summary) never
 *  match these shapes, so filtering is safe (ADR 0005). */
const DIFF_STAT_NOTICE_LINE =
    /^\s+(?:create|delete) mode \d+ |^\s+(?:old|new) mode |^\s+mode change |^\s+(?:similarity|dissimilarity) index |^\s+(?:rename|copy) (?:from|to) |^\s+rewrite /;
/** Parse a diff-stat block that may carry trailing file-mode/rename notices
 *  (merge / pull fast-forward output). Shares `parseGitDiffStat` after the
 *  notices are stripped; fails closed on any other hostile line. */
function parseGitDiffStatTolerant(text: string): GitDiffStatParsed | null {
    const filtered = String(text ?? "")
        .split("\n")
        .filter((line) => !DIFF_STAT_NOTICE_LINE.test(line))
        .join("\n");
    return parseGitDiffStat(filtered);
}
/** `git switch`/`checkout`: `Switched to a new branch 'X'`, `Switched to branch
 *  'X'`, `Already on 'X'`, silent success (empty), or `Updated N paths from
 *  the index` (checkout of paths). Advisory `Your branch …` lines are skipped
 *  (the status line owns branch state). */
const SWITCH_NEW_BRANCH = /^Switched to a new branch '(.+)'$/;
const SWITCH_BRANCH = /^Switched to branch '(.+)'$/;
const SWITCH_ALREADY = /^Already on '(.+)'$/;
const CHECKOUT_PATHS = /^Updated (\d+) paths? from the index$/;
function parseGitSwitchCheckout(
    text: string,
    command: "switch" | "checkout",
): GitActionParsed | null {
    const significant: string[] = [];
    for (const rawLine of String(text ?? "")
        .replace(/\r/g, "")
        .split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        // Advisory branch-state lines and their hints — the status line owns `⎇ main`.
        if (line.startsWith("Your branch ")) continue;
        if (/^\s+\(/.test(line)) continue;
        significant.push(line);
    }
    if (significant.length === 0) {
        return { kind: "action", command, files: [], status: "completed, no output" };
    }
    if (significant.length === 1) {
        const line = significant[0] ?? "";
        const created = SWITCH_NEW_BRANCH.exec(line);
        if (created && created[1] !== undefined)
            return { kind: "action", command, files: [], branch: created[1], created: true };
        const existing = SWITCH_BRANCH.exec(line);
        if (existing && existing[1] !== undefined)
            return { kind: "action", command, files: [], branch: existing[1] };
        const already = SWITCH_ALREADY.exec(line);
        if (already && already[1] !== undefined)
            return { kind: "action", command, files: [], branch: already[1] };
        const paths = CHECKOUT_PATHS.exec(line);
        if (paths) {
            const count = Number(paths[1]);
            return {
                kind: "action",
                command,
                files: [],
                status: `Updated ${count} ${pluralForm("file", count)} from the index`,
            };
        }
    }
    return null; // detached-HEAD note, `switch -m` merge rows, localized text → fail closed
}
/** `git add`/`restore`: success is silent (empty output). Any non-empty output
 *  is an error/`-v` listing/localized text → fail closed. */
function parseGitAddRestore(text: string, command: "add" | "restore"): GitActionParsed | null {
    const body = String(text ?? "").replace(/\r/g, "");
    if (body.trim() === "") {
        return { kind: "action", command, files: [], status: "completed, no output" };
    }
    return null;
}
/** `git reset`: `HEAD is now at <hash> <subject>` (`--hard`/`--keep`), the
 *  `Unstaged changes after reset:` block with `<marker>\t<path>` rows
 *  (`--mixed`), or silent success (`--soft`, or a clean mixed reset). */
const RESET_HEAD_NOW = /^HEAD is now at ([0-9a-f]{4,40}) (.*)$/;
const RESET_UNSTAGED_HEADER = "Unstaged changes after reset:";
const RESET_UNSTAGED_ROW = /^([MADRC?!]{1,2})\t(.+)$/;
function parseGitReset(text: string): GitActionParsed | null {
    const lines = String(text ?? "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trimEnd());
    const nonEmpty = lines.filter((line) => line !== "");
    if (nonEmpty.length === 0) {
        return { kind: "action", command: "reset", files: [], status: "completed, no output" };
    }
    if (nonEmpty.length === 1) {
        const head = RESET_HEAD_NOW.exec(nonEmpty[0] ?? "");
        if (head && head[1] !== undefined) {
            const subject = (head[2] ?? "").trim();
            return {
                kind: "action",
                command: "reset",
                files: [],
                hash: head[1],
                ...(subject ? { subject } : {}),
            };
        }
        return null;
    }
    if ((nonEmpty[0] ?? "") === RESET_UNSTAGED_HEADER) {
        const resetFiles: GitStatusFile[] = [];
        for (const row of nonEmpty.slice(1)) {
            const match = RESET_UNSTAGED_ROW.exec(row ?? "");
            if (!match) return null;
            const marker = match[1] ?? "";
            resetFiles.push({ x: marker[0] ?? " ", y: marker[1] ?? " ", path: match[2] ?? "" });
        }
        if (resetFiles.length === 0) return null;
        return { kind: "action", command: "reset", files: [], resetFiles };
    }
    return null; // unrecognized multi-line shape → fail closed
}
/** `git merge`: `Already up to date.`, a fast-forward (`Updating a..b` +
 *  `Fast-forward` + stat block), or `Merge made by the '…' strategy.` + stat
 *  block. Conflicts exit nonzero and hold unrecognized lines → fail closed. */
const MERGE_UPDATING = /^Updating ([0-9a-f]{4,}\.\.[0-9a-f]{4,})$/;
const MERGE_MADE = /^Merge made by the '.*' strategy\.$/;
function parseGitMerge(text: string): GitActionParsed | null {
    const lines = String(text ?? "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trimEnd());
    let start = 0;
    while (start < lines.length && (lines[start] ?? "") === "") start++;
    let end = lines.length;
    while (end > start && (lines[end - 1] ?? "") === "") end--;
    const body = lines.slice(start, end);
    if (body.length === 0) return null; // merge always reports; empty → hostile
    if (body.length === 1 && (body[0] ?? "") === "Already up to date.") {
        return { kind: "action", command: "merge", files: [], status: "Already up to date." };
    }
    let idx = 0;
    let range: string | undefined;
    const updating = MERGE_UPDATING.exec(body[0] ?? "");
    if (updating) {
        range = updating[1];
        idx = 1;
    }
    const marker = body[idx] ?? "";
    if (range && marker === "Fast-forward") {
        const stat = parseGitDiffStatTolerant(body.slice(idx + 1).join("\n"));
        if (!stat) return null;
        return {
            kind: "action",
            command: "merge",
            files: stat.files,
            status: "Fast-forward",
            range,
            ...(stat.filesChanged !== undefined ? { filesChanged: stat.filesChanged } : {}),
            ...(stat.insertions !== undefined ? { insertions: stat.insertions } : {}),
            ...(stat.deletions !== undefined ? { deletions: stat.deletions } : {}),
        };
    }
    if (MERGE_MADE.exec(marker)) {
        const stat = parseGitDiffStatTolerant(body.slice(idx + 1).join("\n"));
        if (!stat) return null;
        return {
            kind: "action",
            command: "merge",
            files: stat.files,
            status: marker,
            ...(stat.filesChanged !== undefined ? { filesChanged: stat.filesChanged } : {}),
            ...(stat.insertions !== undefined ? { insertions: stat.insertions } : {}),
            ...(stat.deletions !== undefined ? { deletions: stat.deletions } : {}),
        };
    }
    return null; // conflict markers, `--squash`/`--abort` output → fail closed
}
/** `git rebase`: `Successfully rebased and updated refs/heads/<branch>.` or
 *  `Current branch <branch> is up to date.`. The `Rebasing (N/M)` progress is
 *  carriage-return-separated; `\r` is split into its own line and dropped.
 *  Conflicts/`--abort`/`--continue` exit nonzero and fail closed. */
const REBASE_SUCCESS = /^Successfully rebased and updated refs\/heads\/(.+)$/;
const REBASE_UPTODATE = /^Current branch (.+) is up to date\.$/;
function parseGitRebase(text: string): GitActionParsed | null {
    const significant: string[] = [];
    for (const rawLine of String(text ?? "")
        .replace(/\r/g, "\n")
        .split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        // Progress chatter written with a carriage return, then overwritten.
        if (/^Rebasing \(\d+\/\d+\)/.test(line)) continue;
        if (/^Rewriting commits \(\d+\/\d+\)/.test(line)) continue;
        significant.push(line);
    }
    if (significant.length === 1) {
        const line = significant[0] ?? "";
        const success = REBASE_SUCCESS.exec(line);
        if (success && success[1] !== undefined)
            return {
                kind: "action",
                command: "rebase",
                files: [],
                branch: success[1].replace(/\.$/, ""),
                status: "Rebased",
            };
        const upToDate = REBASE_UPTODATE.exec(line);
        if (upToDate && upToDate[1] !== undefined)
            return {
                kind: "action",
                command: "rebase",
                files: [],
                branch: upToDate[1],
                status: "Up to date.",
            };
    }
    return null; // conflict, `--abort`/`--continue`, interactive editor → fail closed
}
function parseGitAction(command: GitActionParsed["command"], text: string): GitActionParsed | null {
    if (command === "commit") return parseGitCommit(text);
    if (command === "push") return parseGitPush(text);
    if (command === "pull") return parseGitPull(text);
    if (command === "fetch") return parseGitFetch(text);
    if (command === "switch" || command === "checkout")
        return parseGitSwitchCheckout(text, command);
    if (command === "add" || command === "restore") return parseGitAddRestore(text, command);
    if (command === "reset") return parseGitReset(text);
    if (command === "merge") return parseGitMerge(text);
    return parseGitRebase(text);
}
// ── Rendering ───────────────────────────────────────────────────────────────
/** Nerd Font git-branch glyph used on git card headers in Nerd Font mode. */
const GIT_ICON = "\u{E725}";
const GIT_CARD_HEAD_LIMIT = 6;
const GIT_CONFLICT_PAIRS = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);
function gitCardHeader(theme: BoxTheme, cls: GitSemanticClass, parsed?: GitParsedSemantic): string {
    const icon = getToolsRenderConfig().nerdFonts ? `${GIT_ICON} ` : "";
    let prefix: string;
    if (cls.kind === "diff") {
        const label = cls.show ? "Git show" : "Git diff";
        prefix = `${icon}${label}`;
        if (cls.show && parsed?.kind === "diff" && parsed.hash) {
            const shortHash = parsed.hash.slice(0, 7);
            prefix += ` · ${shortHash}`;
            if (parsed.subject) prefix += ` · ${parsed.subject}`;
        }
    } else if (cls.kind === "show-stat") {
        prefix = `${icon}Git show`;
        if (parsed?.kind === "show-stat") {
            prefix += ` · ${parsed.hash.slice(0, 7)}`;
            if (parsed.subject) prefix += ` · ${parsed.subject}`;
        }
    } else if (cls.kind === "action") {
        const label =
            cls.command === "commit"
                ? "Git commit"
                : cls.command === "push"
                  ? "Git push"
                  : cls.command === "pull"
                    ? "Git pull"
                    : cls.command === "fetch"
                      ? "Git fetch"
                      : cls.command === "switch"
                        ? "Git switch"
                        : cls.command === "checkout"
                          ? "Git checkout"
                          : cls.command === "add"
                            ? "Git add"
                            : cls.command === "restore"
                              ? "Git restore"
                              : cls.command === "reset"
                                ? "Git reset"
                                : cls.command === "merge"
                                  ? "Git merge"
                                  : "Git rebase";
        prefix = `${icon}${label}`;
        // Header detail carries the parsed identity, matching `Git show · hash ·
        // subject`: a commit's `[<branch> <hash>] <subject>`, a switch/checkout
        // target branch, a reset --hard `HEAD is now at <hash> <subject>`, or a
        // rebase `<branch>`. add/restore/merge stay label-only.
        if (parsed?.kind === "action") {
            if ((parsed.command === "commit" || parsed.command === "reset") && parsed.hash) {
                prefix += ` · ${parsed.hash.slice(0, 7)}`;
                if (parsed.subject) prefix += ` · ${parsed.subject}`;
            } else if (
                (parsed.command === "switch" ||
                    parsed.command === "checkout" ||
                    parsed.command === "rebase") &&
                parsed.branch
            ) {
                prefix += ` · ${parsed.branch}`;
            }
        }
    } else {
        const label =
            cls.kind === "status"
                ? "Git status"
                : cls.kind === "diff-stat"
                  ? "Git diff --stat"
                  : "Git log";
        prefix = `${icon}${label}`;
    }
    return typeof theme?.bold === "function" ? theme.bold(prefix) : prefix;
}
function statusMarker(file: GitStatusFile): string {
    const xy = `${file.x}${file.y}`;
    if (GIT_CONFLICT_PAIRS.has(xy)) return "U";
    if (file.x === "?" || file.x === "!") return file.x;
    const staged = file.x !== " " ? file.x : "";
    const worktree = file.y !== " " && file.y !== "?" && file.y !== "!" ? file.y : "";
    return `${staged}${worktree}` || " ";
}
function statusMarkColor(file: GitStatusFile): string {
    const xy = `${file.x}${file.y}`;
    if (GIT_CONFLICT_PAIRS.has(xy)) return "error";
    if (file.x === "?") return "warning";
    if (file.x === "!") return "dim";
    if (file.x !== " ") return "accent";
    return "toolOutput";
}
function statusCounts(theme: BoxTheme, parsed: GitStatusParsed): string[] {
    let staged = 0;
    let modified = 0;
    let untracked = 0;
    let ignored = 0;
    let conflicted = 0;
    for (const file of parsed.files) {
        const xy = `${file.x}${file.y}`;
        if (GIT_CONFLICT_PAIRS.has(xy)) conflicted++;
        else if (file.x === "?" || file.x === "!") {
            if (file.x === "!") ignored++;
            else untracked++;
        } else if (file.x !== " ") staged++;
        else if (file.y !== " ") modified++;
    }
    const parts: string[] = [];
    if (conflicted > 0) parts.push(theme.fg("error", `${conflicted} conflicted`));
    if (staged > 0) parts.push(theme.fg("accent", `${staged} staged`));
    if (modified > 0) parts.push(theme.fg("accent", `${modified} modified`));
    if (untracked > 0) parts.push(theme.fg("warning", `${untracked} untracked`));
    if (ignored > 0) parts.push(theme.fg("dim", `${ignored} ignored`));
    return parts;
}
function renderStatusCard(
    theme: BoxTheme,
    parsed: GitStatusParsed,
    out: string[],
    width: number,
): string[] {
    const counts = statusCounts(theme, parsed);
    if (counts.length > 0) out.push(`  ${counts.join(theme.fg("dim", " · "))}`);
    else out.push(theme.fg("muted", "  nothing to commit, working tree clean"));
    // Branch is only shown when it affects the result (push/merge/ahead-behind);
    // the status line owns `⎇ main` (ADR 0005).
    if (parsed.branch && (parsed.ahead !== undefined || parsed.behind !== undefined)) {
        const parts = [theme.fg("text", parsed.branch)];
        if (parsed.ahead !== undefined) parts.push(theme.fg("accent", `ahead ${parsed.ahead}`));
        if (parsed.behind !== undefined) parts.push(theme.fg("warning", `behind ${parsed.behind}`));
        out.push(`  ${parts.join(theme.fg("dim", " · "))}`);
    }
    const files = parsed.files;
    return renderStatusFileRows(theme, files, out, width);
}
/** Shared `├─ M  path` rows for status-style file lists (status card + reset). */
function renderStatusFileRows(
    theme: BoxTheme,
    files: readonly GitStatusFile[],
    out: string[],
    width: number,
): string[] {
    const visible = files.slice(0, GIT_CARD_HEAD_LIMIT);
    const more = files.length - visible.length;
    const lastIndex = visible.length - 1;
    for (let i = 0; i < visible.length; i++) {
        const file = visible[i];
        if (!file) continue;
        const branch = i < lastIndex || more > 0 ? "├─" : "└─";
        const mark = statusMarker(file);
        const line = `${TREE_INDENT}${dimLine(branch)} ${theme.fg(statusMarkColor(file), mark)}  ${theme.fg("toolOutput", file.path)}`;
        out.push(safeTruncateToWidth(line, width, "…"));
    }
    if (more > 0) {
        out.push(
            safeTruncateToWidth(
                `${TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("file", more)}`)}`,
                width,
                "…",
            ),
        );
    }
    return out;
}
function renderDiffStatCard(
    theme: BoxTheme,
    parsed: DiffStatSummary,
    out: string[],
    width: number,
): string[] {
    const summaryParts: string[] = [];
    if (parsed.filesChanged !== undefined) {
        summaryParts.push(
            theme.fg(
                "accent",
                `${parsed.filesChanged} ${pluralForm("file", parsed.filesChanged)} changed`,
            ),
        );
    }
    // +/− totals sit adjacent (no separator between them), unlike the `·`-joined parts.
    const diffParts: string[] = [];
    if (parsed.insertions !== undefined && parsed.insertions > 0) {
        diffParts.push(theme.fg("toolDiffAdded", `+${parsed.insertions}`));
    }
    if (parsed.deletions !== undefined && parsed.deletions > 0) {
        diffParts.push(theme.fg("toolDiffRemoved", `-${parsed.deletions}`));
    }
    if (diffParts.length > 0) summaryParts.push(diffParts.join(" "));
    if (summaryParts.length > 0) out.push(`  ${summaryParts.join(theme.fg("dim", " · "))}`);
    else out.push(theme.fg("muted", "  no changes"));
    const files = parsed.files;
    const visible = files.slice(0, GIT_CARD_HEAD_LIMIT);
    const more = files.length - visible.length;
    const lastIndex = visible.length - 1;
    for (let i = 0; i < visible.length; i++) {
        const file = visible[i];
        if (!file) continue;
        const branch = i < lastIndex || more > 0 ? "├─" : "└─";
        const changes = file.changes ?? 0;
        const detail = theme.fg(
            "dim",
            file.binary ? "· binary" : `· ${changes} ${pluralForm("change", changes)}`,
        );
        const line = `${TREE_INDENT}${dimLine(branch)} ${theme.fg("toolOutput", file.path)} ${detail}`;
        out.push(safeTruncateToWidth(line, width, "…"));
    }
    if (more > 0) {
        out.push(
            safeTruncateToWidth(
                `${TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("file", more)}`)}`,
                width,
                "…",
            ),
        );
    }
    return out;
}
function renderLogCard(
    theme: BoxTheme,
    parsed: GitLogParsed,
    out: string[],
    width: number,
): string[] {
    const commits = parsed.commits;
    if (commits.length === 0) {
        out.push(theme.fg("muted", "  no commits"));
        return out;
    }
    const visible = commits.slice(0, GIT_CARD_HEAD_LIMIT);
    const more = commits.length - visible.length;
    const lastIndex = visible.length - 1;
    for (let i = 0; i < visible.length; i++) {
        const commit = visible[i];
        if (!commit) continue;
        const branch = i < lastIndex || more > 0 ? "├─" : "└─";
        const refs = commit.refs ? ` (${commit.refs})` : "";
        const subject = commit.subject ? `  ${commit.subject}` : "";
        const line = `${TREE_INDENT}${dimLine(branch)} ${theme.fg("accent", commit.hash)}${theme.fg("dim", refs)}${theme.fg("toolOutput", subject)}`;
        out.push(line);
    }
    if (more > 0) {
        out.push(
            safeTruncateToWidth(
                `${TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("commit", more)}`)}`,
                width,
                "…",
            ),
        );
    }
    return out;
}
function renderDiffCard(
    theme: BoxTheme,
    parsed: GitDiffParsed,
    out: string[],
    width: number,
): string[] {
    const files = parsed.files;
    if (files.length === 0) {
        out.push(theme.fg("muted", "  no changes"));
        return out;
    }
    let additions = 0;
    let removals = 0;
    for (const file of files) {
        additions += file.additions;
        removals += file.removals;
    }
    const parts: string[] = [
        theme.fg("accent", `${files.length} ${pluralForm("file", files.length)}`),
    ];
    if (additions > 0) parts.push(theme.fg("toolDiffAdded", `+${additions}`));
    if (removals > 0) parts.push(theme.fg("toolDiffRemoved", `-${removals}`));
    out.push(safeTruncateToWidth(`  ${parts.join(" ")}`, width, "…"));
    return out;
}
/** Render a state-change card. `commit`/`pull` reuse the diff-stat summary +
 *  `├─/└─` rows; `push`/`fetch` show the remote (dim) and normalized ref rows.
 *  Every line is width-safe (the caller truncates again). */
function renderActionCard(
    theme: BoxTheme,
    parsed: GitActionParsed,
    out: string[],
    width: number,
): string[] {
    if (parsed.command === "commit") {
        if (parsed.status) {
            out.push(theme.fg("muted", `  ${parsed.status}`)); // nothing to commit
            return out;
        }
        renderDiffStatCard(theme, parsed, out, width); // success: summary line only (no -v rows)
        return out;
    }
    if (parsed.command === "pull") {
        if (parsed.status === "Already up to date.") {
            out.push(theme.fg("muted", "  Already up to date."));
            return out;
        }
        // Fast-forward: range + Fast-forward + diff-stat summary/rows.
        if (parsed.range) out.push(`  ${theme.fg("text", parsed.range)}`);
        out.push(`  ${theme.fg("accent", "Fast-forward")}`);
        renderDiffStatCard(theme, parsed, out, width);
        return out;
    }
    if (parsed.command === "push") {
        if (parsed.remote) out.push(theme.fg("dim", `  To ${parsed.remote}`));
        for (const ref of parsed.refs ?? [])
            out.push(safeTruncateToWidth(`  ${theme.fg("toolOutput", ref)}`, width, "…"));
        if (parsed.status) out.push(theme.fg("muted", `  ${parsed.status}`)); // Everything up-to-date
        return out;
    }
    if (parsed.command === "fetch") {
        if (parsed.status) {
            out.push(theme.fg("muted", `  ${parsed.status}`)); // no new refs (empty fetch)
            return out;
        }
        if (parsed.remote) out.push(theme.fg("dim", `  From ${parsed.remote}`));
        for (const ref of parsed.refs ?? [])
            out.push(safeTruncateToWidth(`  ${theme.fg("toolOutput", ref)}`, width, "…"));
        return out;
    }
    if (parsed.command === "merge") {
        if (parsed.status === "Already up to date.") {
            out.push(theme.fg("muted", "  Already up to date."));
            return out;
        }
        // Fast-forward / `Merge made by the '…' strategy.` + stat summary/rows.
        if (parsed.range) out.push(`  ${theme.fg("text", parsed.range)}`);
        if (parsed.status) out.push(`  ${theme.fg("accent", parsed.status)}`);
        renderDiffStatCard(theme, parsed, out, width);
        return out;
    }
    if (parsed.command === "reset") {
        // Mixed reset with unstaged changes: `M  path` rows (hash/subject live in
        // the header for --hard/--soft via `HEAD is now at`).
        if (parsed.resetFiles && parsed.resetFiles.length > 0) {
            return renderStatusFileRows(theme, parsed.resetFiles, out, width);
        }
        if (parsed.status) out.push(theme.fg("muted", `  ${parsed.status}`)); // completed, no output
        return out;
    }
    // switch/checkout (branch in the header), add/restore/rebase (status line).
    if (parsed.status) out.push(theme.fg("muted", `  ${parsed.status}`));
    return out;
}
// ── Dispatch helpers (used by bash.ts) ──────────────────────────────────────
function parseGitOutput(cls: GitSemanticClass, output: string): GitParsedSemantic | null {
    const text = String(output ?? "");
    if (cls.kind === "status") return parseGitStatus(cls, text);
    if (cls.kind === "diff-stat") return parseGitDiffStat(text);
    if (cls.kind === "show-stat") return parseGitShowStat(text);
    if (cls.kind === "diff") return parseGitDiff(text, cls.show);
    if (cls.kind === "action") return parseGitAction(cls.command, text);
    return parseGitLog(text);
}
/**
 * Render the git semantic card for one call: the header always renders (so a
 * pending call shows a single summary line); once the result parses, counts,
 * file/commit rows, and the `… N more` collapse follow. Every line is
 * width-safe.
 */
function renderGitCardLines(
    theme: BoxTheme,
    state: { readonly cls: GitSemanticClass; readonly parsed?: GitParsedSemantic },
    width: number,
): string[] {
    const safeWidth = Math.max(1, width);
    const out: string[] = [
        safeTruncateToWidth(gitCardHeader(theme, state.cls, state.parsed), safeWidth, "…"),
    ];
    const parsed = state.parsed;
    if (!parsed) return out;
    if (parsed.kind === "status") renderStatusCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "diff-stat") renderDiffStatCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "show-stat") renderDiffStatCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "diff") renderDiffCard(theme, parsed, out, safeWidth);
    else if (parsed.kind === "action") renderActionCard(theme, parsed, out, safeWidth);
    else renderLogCard(theme, parsed, out, safeWidth);
    return out.map((line) => safeTruncateToWidth(line, safeWidth, "…"));
}
// ── Boxed diff result (Phase 8B) ──────────────────────────────────────────
// `git diff` / `git show` results render one frame per file via
// `renderBoxedToolResult` + the same `AdaptiveDiffComponent` `Edit` uses — no
// second diff visual language (ADR 0005 / GIT-002). The Git header lives
// outside the box (the call panel card); each file gets its own `╭…╰` frame
// whose top border carries `path · +N -M` (no divider — the stats live in the
// header, exactly like `Edit`), with a `Ctrl+O more` expand hint on the bottom
// border when collapsed.
const GIT_DIFF_MAX_HIGHLIGHT_CHARS = 12000;
const GIT_DIFF_MAX_HIGHLIGHT_ROWS = 120;
const GIT_DIFF_MAX_ROWS_COLLAPSED = 36;
const GIT_DIFF_MAX_ROWS_EXPANDED = 160;
/** Colored `+N -M` stats fragment shared by diff frame headers. */
function diffStatsFragment(
    theme: BoxTheme,
    stats: { additions: number; removals: number },
): string {
    const plus =
        stats.additions > 0
            ? theme.fg("toolDiffAdded", `+${stats.additions}`)
            : theme.fg("dim", "+0");
    const minus =
        stats.removals > 0
            ? theme.fg("toolDiffRemoved", `-${stats.removals}`)
            : theme.fg("dim", "-0");
    return `${plus} ${minus}`;
}
function fileBoxTopLabel(
    theme: BoxTheme,
    path: string,
    stats?: { additions: number; removals: number },
): string {
    const body = stats
        ? `${theme.fg("text", path)} · ${diffStatsFragment(theme, stats)}`
        : theme.fg("text", path);
    return typeof theme?.bold === "function" ? theme.bold(body) : body;
}
function binaryBodyLine(theme: BoxTheme, status: GitDiffFile["status"]): string {
    const verb =
        status === "added"
            ? "added"
            : status === "deleted"
              ? "removed"
              : status === "renamed"
                ? "renamed"
                : "changed";
    return theme.fg("muted", `Binary file ${verb} (content not shown)`);
}
interface DiffFileBox {
    readonly topLabel: string;
    readonly resultComponent: Component;
}
/** Build a complete boxed-diff result component for a parsed `git diff`/`show`.
 *  The call panel renders the boxless Git header; this component renders one
 *  `╭…╰` frame per file (or a single `No changes` frame for an empty diff).
 *  Construction is memoized on the call state: repeated result passes reuse
 *  the cached component (identity-stable, invalidate propagates inward) so
 *  the per-file `AdaptiveDiffComponent` build never re-runs per render pass. */
function renderGitDiffResult(
    theme: BoxTheme,
    parsed: GitDiffParsed,
    options: { expanded: boolean; isPartial: boolean },
    context: BoxedToolContext,
): Component {
    const expanded = Boolean(options.expanded);
    // Cheap cache key capturing everything that affects output — theme, show vs
    // diff, expansion, partial-vs-settled status, error state, file count/totals,
    // and per-file identity (path, body length, counts, binary/status) — computed
    // WITHOUT building rows or components; the expensive build runs only on cache
    // misses.
    let totalAdditions = 0;
    let totalRemovals = 0;
    const sigParts: string[] = [];
    for (const file of parsed.files) {
        totalAdditions += file.additions;
        totalRemovals += file.removals;
        sigParts.push(
            `${file.path}:${file.body.length}:${file.additions}:${file.removals}:${file.binary ? 1 : 0}:${file.status ?? ""}`,
        );
    }
    const sig = sigParts.join(";").slice(0, 2048);
    return memoizedStateComponent(
        context.state,
        "__piStyleGitDiffResult",
        getRenderCacheKey(
            "git-diff-result",
            theme,
            String(parsed.show),
            String(expanded),
            String(options.isPartial),
            String(context.isError),
            parsed.files.length,
            totalAdditions,
            totalRemovals,
            sig,
        ),
        () => buildGitDiffResultComponent(theme, parsed, expanded, options.isPartial, context),
    );
}
/** Uncached boxed git-diff construction: one `╭…╰` frame per file. */
function buildGitDiffResultComponent(
    theme: BoxTheme,
    parsed: GitDiffParsed,
    expanded: boolean,
    isPartial: boolean,
    context: BoxedToolContext,
): Component {
    const elapsedMs = getStateElapsedMs(context.state);
    const fileCount = parsed.files.length;
    const footerParts: string[] = [];
    if (elapsedMs !== undefined) footerParts.push(formatElapsedMetric(theme, elapsedMs));
    // A single frame already implies one file — the count is only worth a footer
    // slot when the diff spans several.
    if (fileCount > 1)
        footerParts.push(theme.fg("dim", `${fileCount} ${pluralForm("file", fileCount)}`));
    const footer = footerParts.join(theme.fg("dim", " · "));
    const fileBoxes: DiffFileBox[] = [];
    if (parsed.files.length === 0) {
        // Empty diff (`git diff` with no changes): a single `No changes` frame so
        // the result is not a blank panel.
        const emptyFooterParts: string[] = [];
        if (elapsedMs !== undefined) emptyFooterParts.push(formatElapsedMetric(theme, elapsedMs));
        const emptyFooter = emptyFooterParts.join(theme.fg("dim", " · "));
        fileBoxes.push({
            topLabel: fileBoxTopLabel(theme, parsed.show ? "Git show" : "Git diff"),
            resultComponent: renderBoxedToolResult(theme, () => [theme.fg("muted", "No changes")], {
                showDivider: false,
                skipLeadingBlank: true,
                footerLines: emptyFooter ? [emptyFooter] : [],
                isError: context.isError,
                isPartial,
            }),
        });
    } else {
        for (const file of parsed.files) {
            if (file.binary) {
                fileBoxes.push({
                    topLabel: fileBoxTopLabel(theme, file.path),
                    resultComponent: renderBoxedToolResult(
                        theme,
                        () => [binaryBodyLine(theme, file.status)],
                        {
                            showDivider: false,
                            skipLeadingBlank: true,
                            footerLines: footer ? [footer] : [],
                            isError: context.isError,
                            isPartial,
                        },
                    ),
                });
                continue;
            }
            const rows = buildSplitRows(file.body);
            const language = getLanguageFromPath(file.path);
            const shouldHighlight =
                Boolean(language) &&
                file.body.length <= GIT_DIFF_MAX_HIGHLIGHT_CHARS &&
                rows.length <= GIT_DIFF_MAX_HIGHLIGHT_ROWS;
            const maxRows = expanded ? GIT_DIFF_MAX_ROWS_EXPANDED : GIT_DIFF_MAX_ROWS_COLLAPSED;
            const view = new AdaptiveDiffComponent(
                theme,
                rows,
                maxRows,
                shouldHighlight ? language : undefined,
            );
            const expandHint = !expanded && view.hasCollapsed() ? "Ctrl+O more" : undefined;
            fileBoxes.push({
                topLabel: fileBoxTopLabel(theme, file.path, countDiffStats(file.body)),
                resultComponent: renderBoxedToolResult(theme, view, {
                    // Stats live in the frame's top border (`path · +N -M`) — no divider.
                    showDivider: false,
                    skipLeadingBlank: true,
                    footerLines: footer ? [footer] : [],
                    ...(expandHint ? { expandHint } : {}),
                    isError: context.isError,
                    isPartial,
                }),
            });
        }
    }
    let cacheWidth: number | undefined;
    let cacheLines: string[] | undefined;
    return {
        invalidate() {
            cacheWidth = undefined;
            cacheLines = undefined;
            for (const box of fileBoxes) box.resultComponent.invalidate();
        },
        render(width: number): string[] {
            if (cacheWidth === width && cacheLines) return cacheLines;
            const renderedWidth = boxWidth(width);
            // One frame identity per file box: the top border is drawn here, the
            // body/bottom by the file's result component, so both must agree.
            const frameColor = boxFrameColor(context.isError, isPartial);
            const lines: string[] = [];
            for (const box of fileBoxes) {
                lines.push(
                    boxLabeledBorder(
                        theme,
                        "╭",
                        "╮",
                        box.topLabel,
                        undefined,
                        renderedWidth,
                        frameColor,
                    ),
                );
                lines.push(boxBlankLine(theme, renderedWidth, frameColor));
                lines.push(...box.resultComponent.render(width));
            }
            cacheWidth = width;
            cacheLines = lines;
            return lines;
        },
    };
}

// from: pistyle\features\tools\boxed\bash.ts

// Boxed bash tool renderer
// (renderCall/renderResult only).
const BASH_TOOL_NOTICE_PATTERN = /^\[Showing (?:last|lines)\b.*\. Full output: .+\]$/;
const BG_ANSI_PATTERN = new RegExp(`${ESC}\\[4[0-9;]*m`, "g");
const SHELL_VAR_PATTERN = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;
const SHELL_OP_PATTERN = /^(?:&&|\|\||>>|>&|\|&|[|&;()<>])$/;
function highlightBashFallback(line: string): string {
    try {
        const highlighted = highlightCode(line, "bash")[0] ?? line;
        // Strip background colors to avoid clashing with badge/parens styling
        return highlighted.replace(BG_ANSI_PATTERN, "");
    } catch {
        return line;
    }
}
function normalizeShellWord(word: string): string {
    return word.replace(/^(['"])(.*)\1$/, "$2");
}
function colorShellWord(theme: BoxTheme, word: string, commandExpected: boolean): string {
    const normalized = normalizeShellWord(word);
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(normalized)) return theme.fg("syntaxVariable", word);
    if (normalized.startsWith("-")) return theme.fg("syntaxKeyword", word);
    if (normalized.includes("/") || /^\.{1,2}(?:\/|$)/.test(normalized))
        return theme.fg("syntaxVariable", word);
    if (SHELL_VAR_PATTERN.test(normalized)) return theme.fg("syntaxVariable", word);
    return commandExpected ? theme.fg("syntaxFunction", word) : theme.fg("syntaxString", word);
}
function tokenizeShellLinePreservingText(line: string): string[] | undefined {
    const tokens: string[] = [];
    let current = "";
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const char = line[i] ?? "";
        const next = line[i + 1] ?? "";
        if (quote) {
            current += char;
            if (char === "\\" && next) current += line[++i] ?? "";
            else if (char === quote) quote = null;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) tokens.push(current);
            current = "";
            tokens.push(char);
            continue;
        }
        if (char === "#" && !current) {
            if (current) tokens.push(current);
            tokens.push(line.slice(i));
            return tokens;
        }
        const two = `${char}${next}`;
        if (SHELL_OP_PATTERN.test(two) || SHELL_OP_PATTERN.test(char)) {
            if (current) tokens.push(current);
            current = "";
            if (SHELL_OP_PATTERN.test(two)) {
                tokens.push(two);
                i++;
            } else {
                tokens.push(char);
            }
            continue;
        }
        current += char;
    }
    if (quote) return undefined;
    if (current) tokens.push(current);
    return tokens;
}
function highlightBashLine(line: string, theme: BoxTheme): string {
    const tokens = tokenizeShellLinePreservingText(line);
    if (!tokens) return highlightBashFallback(line);
    let commandExpected = true;
    return tokens
        .map((token) => {
            if (/^\s+$/.test(token)) return token;
            if (token.startsWith("#")) return theme.fg("syntaxComment", token);
            if (SHELL_OP_PATTERN.test(token)) {
                commandExpected =
                    token === "|" ||
                    token === "||" ||
                    token === "&&" ||
                    token === ";" ||
                    token === "&";
                return theme.fg("syntaxOperator", token);
            }
            const styled = colorShellWord(theme, token, commandExpected);
            if (!/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(normalizeShellWord(token)))
                commandExpected = false;
            return styled;
        })
        .join("");
}
function countNewlines(text: string, from: number, to: number): number {
    let count = 0;
    for (let i = from; i < to; i++) {
        if (text.charCodeAt(i) === 10) count++;
    }
    return count;
}
/** Index just past the `need`-th newline counted backwards from `end` (0 when
 *  the window holds fewer), so only `text.slice(index, end)` needs further
 *  processing. Plain char scan, no allocation. */
function findBackwardLineStart(text: string, need: number, end: number = text.length): number {
    let found = 0;
    for (let i = end - 1; i >= 0; i--) {
        if (text.charCodeAt(i) === 10 && ++found >= need) return i + 1;
    }
    return 0;
}
/** Whitespace per `String.prototype.trim` (superset of ASCII blank/line
 *  terminators); anything else counts as visible output. */
function isOutputWhitespaceCode(code: number): boolean {
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
    if (code === 0x85 || code === 0xa0 || code === 0x1680) return true;
    if (code >= 0x2000 && code <= 0x200a) return true;
    return (
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff
    );
}
/** End index (exclusive) of the last non-whitespace character in `text` — the
 *  streaming equivalent of `stripAnsi(text).trimEnd()`: trailing blank lines and
 *  padding never push the visible tail out of the processing window. ANSI
 *  escape bytes count as non-whitespace; a slice ending inside one still
 *  strips correctly downstream. */
function lastVisibleEnd(text: string): number {
    for (let i = text.length - 1; i >= 0; i--) {
        if (!isOutputWhitespaceCode(text.charCodeAt(i))) return i + 1;
    }
    return 0;
}
function stripBashToolNoticeLines(text: string): string {
    const filteredLines = text
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !BASH_TOOL_NOTICE_PATTERN.test(line.trim()));
    return filteredLines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd();
}
function bashWidthKey(rawCommand: string, timeout: unknown): string {
    return boxedToolWidthKey("Bash", `${rawCommand}|${timeout ?? ""}`);
}
function renderBoxedBashCall(
    theme: BoxTheme,
    commandLines: string[],
    context: BoxedToolContext,
    widthKey: string,
): Component {
    // Expanded (click / Ctrl+O) reveals the whole command; collapsed keeps the
    // command head plus an omitted-line note.
    const maxCommandLines = context.expanded ? commandLines.length : 5;
    const shownCount = Math.min(commandLines.length, maxCommandLines + 1);
    const detailLines: string[] = [];
    for (let i = 0; i < shownCount; i++) {
        const prefix = i === 0 ? theme.fg("dim", "$ ") : theme.fg("dim", "> ");
        detailLines.push(`${prefix}${highlightBashLine(commandLines[i] ?? "", theme)}`);
    }
    if (commandLines.length > maxCommandLines + 1) {
        detailLines.push(
            theme.fg("muted", `... ${commandLines.length - maxCommandLines - 1} more lines`),
        );
    }
    const running = Boolean(context.executionStarted);
    const resultSeen = isResultSeen(context.state);
    const base = {
        widthKey,
        isError: Boolean(context.isError),
        isPartial: Boolean(context.isPartial),
        isPending: Boolean(context.isPartial),
        running,
    };
    if (running && context.isPartial && !resultSeen) {
        // Pre-result running card: the call closes the box with a live running
        // footer and a `No output received yet` line. The first partial result
        // renders nothing, so this card is never duplicated below.
        detailLines.push(theme.fg("dim", "No output received yet"));
        return renderBoxedToolCall(theme, "Bash", detailLines, {
            ...base,
            pendingLabel: formatBoxedRunningStatus(theme, getStateElapsedMs(context.state)),
        });
    }
    // Streaming (a result renderer already continues this box) and terminal
    // (settled) passes leave the box open so the result closes it.
    return renderBoxedToolCall(theme, "Bash", detailLines, { ...base, resultSeen });
}
// ── Terminal status detection ────────────────────────────────────────────────
// The bash tool appends a `\n\n<status>` suffix to failed results (nonzero exit,
// timeout, abort). Parse it off the raw text so the footer can carry the real
// status instead of displaying the suffix as output.
type BashTerminalStatus =
    | { kind: "exit"; exitCode: number }
    | { kind: "timeout"; seconds: number }
    | { kind: "cancelled" };
const BASH_STATUS_PATTERNS: ReadonlyArray<{
    re: RegExp;
    build: (match: RegExpMatchArray) => BashTerminalStatus;
}> = [
    {
        re: /(?:^|\n\n)Command timed out after ([\d.]+) seconds$/i,
        build: (match) => ({ kind: "timeout", seconds: Number(match[1]) }),
    },
    { re: /(?:^|\n\n)[^\n]*aborted$/i, build: () => ({ kind: "cancelled" }) },
    {
        re: /(?:^|\n\n)Command exited with code (\d+)$/i,
        build: (match) => ({ kind: "exit", exitCode: Number(match[1]) }),
    },
];
function parseBashTerminalStatus(text: string): {
    status: BashTerminalStatus | undefined;
    body: string;
} {
    const clean = String(text ?? "").replace(/\r/g, "");
    for (const { re, build } of BASH_STATUS_PATTERNS) {
        const match = clean.match(re);
        if (match && match.index !== undefined) {
            return { status: build(match), body: clean.slice(0, match.index).trimEnd() };
        }
    }
    // Pi's message_end error path (agent aborted) sends a bare status text with
    // no bash output shape; recognize it as a cancelled state.
    if (/^(?:operation )?aborted(?: after \d+ retry attempts?)?$/i.test(clean.trim())) {
        return { status: { kind: "cancelled" }, body: "" };
    }
    return { status: undefined, body: clean };
}
function bashErrorLabel(status: BashTerminalStatus | undefined): string | undefined {
    if (status?.kind === "timeout") return "✗ Timed out";
    if (status?.kind === "cancelled") return "✗ Cancelled";
    return undefined;
}
/** Body text shown when a terminal bash result produced no output. */
function bashEmptyBodyText(status: BashTerminalStatus | undefined, isError: boolean): string {
    if (status?.kind === "timeout") return "No output was received before the timeout";
    if (status?.kind === "cancelled") return "Command was cancelled without producing output";
    if (isError) return "Command failed without producing output";
    return "Command completed without producing output";
}
function bashFooter(
    theme: BoxTheme,
    status: BashTerminalStatus | undefined,
    elapsedMs: number | undefined,
    bodyText: string,
    isError: boolean,
): string {
    const elapsed =
        elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs);
    const words = bodyText.trim() ? formatBoxedWords(theme, bodyText) : "";
    if (status?.kind === "timeout") {
        const seconds =
            Number.isFinite(status.seconds) && status.seconds > 0 ? status.seconds : Number.NaN;
        return theme.fg(
            "warning",
            Number.isFinite(seconds)
                ? `Terminated after ${seconds.toFixed(1)}s`
                : "Terminated by timeout",
        );
    }
    if (status?.kind === "cancelled") {
        return [theme.fg("warning", "Cancelled"), elapsed].join(theme.fg("dim", " · "));
    }
    const exitLabel =
        status?.kind === "exit" ? `Exit ${status.exitCode}` : isError ? "Failed" : "Exit 0";
    const exitColor = status?.kind === "exit" && status.exitCode !== 0 ? "error" : "text";
    const parts = [theme.fg(exitColor, exitLabel), elapsed];
    if (words) parts.push(words);
    return parts.join(theme.fg("dim", " · "));
}
// ── Interactive command heuristics ───────────────────────────────────────────
// Terminal programs that read stdin or own the screen produce no pipe output;
// when one runs silently we hint that it may be waiting for terminal input.
const INTERACTIVE_COMMANDS = new Set([
    "pi",
    "vim",
    "vi",
    "nvim",
    "nano",
    "less",
    "more",
    "man",
    "top",
    "htop",
    "btop",
    "ssh",
    "telnet",
    "python",
    "python3",
    "node",
    "sqlite3",
    "mysql",
    "psql",
    "redis-cli",
    "mongosh",
    "bc",
    "irssi",
]);
function isInteractiveCommand(command: unknown): boolean {
    const base =
        (
            String(command ?? "")
                .trim()
                .split(/\s+/)[0] ?? ""
        )
            .split("/")
            .pop() ?? "";
    return INTERACTIVE_COMMANDS.has(base);
}
/** Wrap an output preview so an empty result renders state text instead of `∅`. */
function bashBodyComponent(preview: Component, emptyLines: string[] | undefined): Component {
    if (!emptyLines) return preview;
    return {
        invalidate: () => preview.invalidate(),
        render(width: number): string[] {
            const lines = preview.render(width);
            return lines.length > 0 ? lines : emptyLines;
        },
    };
}
/** Streaming continuation: streamed output (or `No output received yet`), a
 *  live running footer, and no `Response` divider until the tool settles. */
function renderBashStreamingResult(
    theme: BoxTheme,
    raw: string,
    options: { expanded: boolean },
    context: BoxedToolContext,
): Component {
    // Tail-only processing: the preview collapses to maxCollapsedLines lines
    // anyway, so only the last maxCollapsedLines + 10 raw lines (the same headroom
    // the final collapsed scan uses, covering notice lines stripped from the
    // tail) get ANSI stripping/truncation work, and trailing blank lines never
    // push real content out of the window (the raw-string equivalent of the old
    // whole-buffer stripAnsi + trimEnd). Streaming passes stay O(tail) as the
    // output grows instead of re-stripping the whole buffer each pass.
    const contentEnd = lastVisibleEnd(raw);
    const hasOutput = contentEnd > 0;
    const tailStart = hasOutput
        ? findBackwardLineStart(raw, getToolsRenderConfig().maxCollapsedLines + 10, contentEnd)
        : 0;
    const body = stripBashToolNoticeLines(stripAnsi(raw.slice(tailStart, contentEnd)));
    const elapsed = getStateElapsedMs(context.state);
    const emptyLines: string[] = [theme.fg("dim", "No output received yet")];
    if (!hasOutput && isInteractiveCommand(context?.args?.command) && (elapsed ?? 0) >= 1000) {
        emptyLines.push(theme.fg("dim", "The process may be waiting for terminal input"));
    }
    const preview = createBashResultPreview(theme, body, options, "toolOutput");
    const rawCommand = String(context?.args?.command ?? "...");
    return renderBoxedToolResult(
        theme,
        bashBodyComponent(preview, hasOutput ? undefined : emptyLines),
        {
            widthKey: bashWidthKey(rawCommand, context?.args?.timeout),
            referenceLines: rawCommand
                .split("\n")
                .map((line, index) => `${index === 0 ? "$ " : "> "}${line}`),
            dividerLabel: "Output",
            showDivider: hasOutput,
            footerLines: [formatBoxedRunningStatus(theme, elapsed)],
            isPartial: true,
        },
    );
}
function renderBashFinalResult(
    theme: BoxTheme,
    raw: string,
    options: { expanded: boolean },
    context: BoxedToolContext,
): Component {
    const isError = Boolean(context.isError);
    const clean = stripAnsi(raw);
    const { status, body: statusStripped } = parseBashTerminalStatus(clean);
    const output = stripBashToolNoticeLines(statusStripped);
    const elapsed = getStateElapsedMs(context.state);
    const outputColor = isError ? "error" : "toolOutput";
    const footer = bashFooter(theme, status, elapsed, output, isError);
    const errorLabel = isError ? (bashErrorLabel(status) ?? "✗ Error") : undefined;
    const rawCommand = String(context?.args?.command ?? "...");
    const widthKey = bashWidthKey(rawCommand, context?.args?.timeout);
    const referenceLines = rawCommand
        .split("\n")
        .map((line, index) => `${index === 0 ? "$ " : "> "}${line}`);
    if (!options.expanded) {
        // Collapsed: only process the tail of the output (notices stripped per line).
        const scanLines = getToolsRenderConfig().maxCollapsedLines + 10;
        const tailStart = findBackwardLineStart(statusStripped, scanLines);
        const tail = stripBashToolNoticeLines(stripAnsi(statusStripped.slice(tailStart)));
        const totalLinesBefore = tailStart > 0 ? countNewlines(statusStripped, 0, tailStart) : 0;
        const preview = createBashResultPreview(theme, tail, options, outputColor);
        return renderBoxedToolResult(
            theme,
            bashBodyComponent(
                preview,
                statusStripped.trim()
                    ? undefined
                    : [theme.fg("muted", bashEmptyBodyText(status, isError))],
            ),
            {
                widthKey,
                referenceLines,
                footerLines: [footer],
                ...(totalLinesBefore > 0 ? { expandHint: "Ctrl+O for more" } : {}),
                isError,
                isPartial: false,
                ...(errorLabel ? { errorLabel } : {}),
            },
        );
    }
    const preview = createBashResultPreview(theme, output, options, outputColor);
    return renderBoxedToolResult(
        theme,
        bashBodyComponent(
            preview,
            output.trim() ? undefined : [theme.fg("muted", bashEmptyBodyText(status, isError))],
        ),
        {
            widthKey,
            referenceLines,
            footerLines: [footer],
            isError,
            isPartial: false,
            ...(errorLabel ? { errorLabel } : {}),
        },
    );
}
/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_BASH_RESULT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});
function createBashResultPreview(
    theme: BoxTheme,
    text: string,
    options: { expanded: boolean },
    color: "toolOutput" | "error",
): Component {
    let cacheKey = "";
    let cacheLines: string[] | null = null;
    return {
        invalidate() {
            cacheKey = "";
            cacheLines = null;
        },
        render(width: number): string[] {
            const bodyWidth = Math.max(1, width);
            const cfg = getToolsRenderConfig();
            const expanded = Boolean(options.expanded);
            const cacheId = `${bodyWidth}|${expanded ? 1 : 0}|${cfg.maxExpandedLines}|${cfg.dimOutput ? 1 : 0}`;
            if (cacheLines && cacheKey === cacheId) return cacheLines;
            if (!expanded) {
                // Collapsed: only process the tail of the output
                const needed = cfg.maxCollapsedLines;
                const scanFrom = findBackwardLineStart(text, needed); // full text when fewer newlines
                if (text.length === 0) {
                    cacheKey = cacheId;
                    cacheLines = [];
                    return cacheLines;
                }
                const tail = replaceTabs(text.slice(scanFrom)).replace(/\r/g, "");
                const shownLines = tail ? tail.split("\n").map((l) => clampRenderLine(l)) : [];
                if (shownLines.length === 0) {
                    cacheKey = cacheId;
                    cacheLines = [];
                    return cacheLines;
                }
                const truncatedShown = shownLines.map((line) => {
                    const truncated = safeTruncateToWidth(line, bodyWidth, "…");
                    if (color === "error") return formatToolOutputLine(theme, truncated, "error");
                    return cfg.dimOutput
                        ? formatToolOutputLine(theme, truncated)
                        : formatToolOutputLine(theme, truncated, "text");
                });
                cacheKey = cacheId;
                cacheLines = truncatedShown;
                return cacheLines;
            }
            // Expanded: only the tail lines the expanded budget can show receive
            // clamp/truncate/color work; earlier lines collapse into one `… N earlier
            // lines` head row, so per-line cost scales with maxExpandedLines instead
            // of the full output.
            const normalized = replaceTabs(text);
            const rawLines = normalized.split("\n");
            const totalLines = rawLines.length;
            const hasOutput = !(totalLines === 1 && rawLines[0] === "");
            if (!hasOutput) {
                cacheKey = cacheId;
                cacheLines = [];
                return cacheLines;
            }
            const applyColor = (l: string) =>
                color === "error"
                    ? formatToolOutputLine(theme, l, "error")
                    : cfg.dimOutput
                      ? formatToolOutputLine(theme, l)
                      : formatToolOutputLine(theme, l, "text");
            const renderRawLine = (line: string) =>
                safeTruncateToWidth(clampRenderLine(line), bodyWidth, "…");
            if (cfg.maxExpandedLines > 0 && totalLines > cfg.maxExpandedLines) {
                const truncated = rawLines
                    .slice(-cfg.maxExpandedLines)
                    .map((line) => applyColor(renderRawLine(line)));
                const remaining = totalLines - cfg.maxExpandedLines;
                truncated.unshift(theme.fg("dim", `… ${remaining} earlier lines`));
                cacheKey = cacheId;
                cacheLines = truncated;
                return cacheLines;
            }
            cacheKey = cacheId;
            cacheLines = rawLines.map((line) => applyColor(renderRawLine(line)));
            return cacheLines;
        },
    };
}
// ── ls/find/grep/rg command detection ───────────────────────────────────────
// A bash command whose real command is ls/find/grep/rg (after env assignments,
// sudo/env/time prefixes, and path stripping), with no shell metacharacters
// (pipes, redirects, `;`, `&&`, command substitution, subshells, newlines), is
// rendered as the same boxless output tree as the corresponding native tool.
// Everything else keeps the boxed command/response shell.
type BashTreeKind = "ls" | "find" | "grep";
interface BashTreeClass {
    readonly kind: BashTreeKind;
    readonly pattern?: string;
    readonly pathLabel?: string;
    /** grep: exactly one path positional — single-file output (`line: content`)
     *  is attributed to it. */
    readonly singlePath?: string;
}
const BASH_GREP_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);
/** grep/rg flags that consume a separate value token (`--type ts`). */
const GREP_VALUE_FLAGS = new Set([
    "-e",
    "--regexp",
    "-g",
    "--glob",
    "--type",
    "-t",
    "--include",
    "--exclude",
    "-C",
    "-A",
    "-B",
    "--context",
    "--after-context",
    "--before-context",
    "-m",
    "--max-count",
    "-M",
    "--max-columns",
    "--ignore-file",
]);
/** find flags that consume a separate value token (`-type f`). */
const FIND_VALUE_FLAGS = new Set([
    "-type",
    "-mtime",
    "-atime",
    "-ctime",
    "-size",
    "-maxdepth",
    "-mindepth",
    "-perm",
    "-group",
    "-user",
    "-newer",
]);
function classifyByArgs(kind: BashTreeKind, args: string[]): BashTreeClass {
    const positionals: string[] = [];
    let pattern: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const token = args[i] ?? "";
        if (
            (kind === "grep" && (token === "-e" || token === "--regexp")) ||
            (kind === "find" &&
                (token === "-name" ||
                    token === "-iname" ||
                    token === "-path" ||
                    token === "-ipath"))
        ) {
            pattern = args[++i];
            continue;
        }
        if (kind === "grep" && GREP_VALUE_FLAGS.has(token)) {
            i++; // skip the flag and its value
            continue;
        }
        if (kind === "find" && FIND_VALUE_FLAGS.has(token)) {
            i++; // skip the flag and its value
            continue;
        }
        if (token.startsWith("-")) continue;
        positionals.push(token);
    }
    const rawPath = positionals[0] ?? ".";
    const pathLabel = rawPath === "." ? "current directory" : shortenPath(rawPath);
    if (kind === "ls") return { kind, pathLabel };
    if (kind === "find") return { kind, ...(pattern !== undefined ? { pattern } : {}), pathLabel };
    const grepPattern = pattern ?? positionals[0];
    const pathArgs = pattern !== undefined ? positionals : positionals.slice(1);
    const grepPath = pathArgs.join(" ");
    const grepPathLabel =
        !grepPath || grepPath === "." ? "current directory" : shortenPath(grepPath);
    return {
        kind,
        ...(grepPattern !== undefined ? { pattern: grepPattern } : {}),
        pathLabel: grepPathLabel,
        ...(pathArgs.length === 1 ? { singlePath: pathArgs[0] ?? "" } : {}),
    };
}
/** Classify a bash command for tree rendering, or null to keep the boxed shell. */
function classifyBashCommand(command: string): BashTreeClass | null {
    const shape = parseSimpleBashCommand(command, { allowTrailingTruncationPipe: true });
    if (!shape) return null;
    const rest = shape.tokens;
    const base = (rest[0] ?? "").split("/").pop() ?? "";
    let kind: BashTreeKind | null = null;
    if (base === "ls") kind = "ls";
    else if (base === "find") kind = "find";
    else if (BASH_GREP_COMMANDS.has(base)) kind = "grep";
    if (!kind) return null;
    const cls = classifyByArgs(kind, rest.slice(1));
    if (shape.cdDir && cls.pathLabel === "current directory") {
        return {
            kind,
            ...(cls.pattern !== undefined ? { pattern: cls.pattern } : {}),
            pathLabel: shortenPath(shape.cdDir),
            ...(cls.singlePath !== undefined ? { singlePath: cls.singlePath } : {}),
        };
    }
    return cls;
}
function bashTreeHeader(
    theme: BoxTheme,
    cls: BashTreeClass,
    counts?: { files?: number; matches?: number },
): string {
    const label = cls.kind === "find" ? "Find" : cls.kind === "ls" ? "List" : "Grep";
    const hasDetail = Boolean(cls.pattern) || Boolean(counts);
    // ls/find/grep headers carry the magnifying-glass icon in Nerd Font mode.
    const icon = getToolsRenderConfig().nerdFonts ? `${SEARCH_ICON} ` : "";
    const prefix = icon + (hasDetail ? `${label}:` : label);
    const patternPart = cls.pattern ? ` ${theme.fg("text", cls.pattern)}` : "";
    let middle = "";
    if (counts) {
        if (cls.kind === "grep") {
            const matches = counts.matches ?? 0;
            const files = counts.files ?? 0;
            middle = ` ${theme.fg("accent", `${matches} ${pluralForm("match", matches)}`)}${theme.fg("dim", ` · ${files} ${pluralForm("file", files)}`)}`;
        } else {
            const files = counts.files ?? 0;
            middle = ` ${theme.fg("accent", `${files} ${pluralForm("file", files)}`)}`;
        }
    }
    const pathPart =
        cls.pathLabel && cls.pathLabel !== "current directory"
            ? theme.fg("dim", ` · in ${cls.pathLabel}`)
            : "";
    return `${typeof theme?.bold === "function" ? theme.bold(prefix) : prefix}${patternPart}${middle}${pathPart}`;
}
/** `ls -l` long-format lines (permissions block) can't be parsed into names
 *  reliably; fall back to the boxed shell for those. A leading `total N`
 *  summary line is skipped before the check. */
function isLongFormatLs(text: string): boolean {
    const first = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !/^total\s+\d+$/i.test(line));
    return Boolean(first) && /^[bcdlsp-][rwxtsST-]{9}[\s@]/.test(first as string);
}
/** Parsed bash tree output, or null to fall back to the boxed shell
 *  (long-format ls, unparseable grep). */
type ParsedBashTree = { entries: string[] } | { matches: GrepMatch[] };
function parseBashTreeOutput(cls: BashTreeClass, output: string): ParsedBashTree | null {
    if (cls.kind === "ls") {
        // `ls -l`/`ls -la` long format is parsed into names (with `/` for dirs)
        // so bash listings render like the List tool tree.
        if (isLongFormatLs(output)) return { entries: parseLsLongOutput(output) };
        return { entries: parseLsOutput(output) };
    }
    if (cls.kind === "find") return { entries: parseFindOutput(output) };
    const matches = parseGrepOutput(output);
    if (matches.length === 0 && output.trim().length > 0) {
        // Single-file `rg`/`grep` output is `line: content` with no filename:
        // attribute matches to the command's single path argument.
        if (cls.singlePath) {
            const bare = parseGrepBareOutput(output, cls.singlePath);
            if (bare.length > 0) return { matches: bare };
        }
        return null;
    }
    return { matches };
}
type FinalSemanticRenderCache = {
    key: string;
    lines: string[];
};
interface BashTreeState {
    cls: BashSemanticClass;
    /** Raw command, so the call panel can render the boxed bash call on fallback. */
    command: string;
    /** `parsed` once the result arrives; `fallback` when the boxed shell takes over. */
    parsed?: ParsedSemantic;
    fallback?: boolean;
    finished: boolean;
    revision: number;
    renderCache?: FinalSemanticRenderCache;
    /** Raw output length at the last streaming parse attempt: partial passes
     *  with smaller growth than PARTIAL_REPARSE_THRESHOLD skip the re-parse (the
     *  final pass always parses the settled output in full). */
    lastParsedLength?: number;
}
/** Classified semantic command: a bash tree (ls/find/grep), a git card, or a
 *  gh card (pr/issue/run). */
type BashSemanticClass = BashTreeClass | GitSemanticClass | GhSemanticClass;
type ParsedSemantic = ParsedBashTree | GitParsedSemantic | GhParsedSemantic;
/** Classify a bash command for semantic rendering (tree, git card, or gh
 *  card), or null to keep the boxed command/response shell. */
function classifyBashSemantic(command: string): BashSemanticClass | null {
    return (
        classifyBashCommand(command) ?? classifyGitCommand(command) ?? classifyGhCommand(command)
    );
}
function isBashTreeClass(cls: BashSemanticClass): cls is BashTreeClass {
    return cls.kind === "ls" || cls.kind === "find" || cls.kind === "grep";
}
/** Type guard for the gh semantic classes (pr/issue/run list/view/checks/
 *  create/job). */
function isGhClass(cls: BashSemanticClass): cls is GhSemanticClass {
    switch (cls.kind) {
        case "pr-list":
        case "pr-view":
        case "pr-checks":
        case "pr-create":
        case "issue-list":
        case "issue-view":
        case "run-list":
        case "run-view":
        case "run-job":
            return true;
        default:
            return false;
    }
}
/** `gh run view --job=<id>` renders a boxed log result (Phase 8D); the other gh
 *  classes render their whole panel in the call card. */
function isGhRunJobClass(cls: BashSemanticClass): boolean {
    return cls.kind === "run-job";
}
/** `git diff` / `git show` render a boxed adaptive-diff result (Phase 8B); the
 *  other semantic classes render their whole panel in the call card. */
function isGitDiffClass(cls: BashSemanticClass): boolean {
    return !isBashTreeClass(cls) && (cls as GitSemanticClass).kind === "diff";
}
/** `git commit`/`push`/`pull`/`fetch` may produce informational exit-1 output
 *  (e.g. `git commit` with nothing staged) that still parses to a card. Their
 *  parsers are fail-closed, so genuine errors (push rejected, hook failure)
 *  return null and fall back to the raw boxed shell (ADR 0005). */
function isGitActionClass(cls: BashSemanticClass): boolean {
    return !isBashTreeClass(cls) && (cls as GitSemanticClass).kind === "action";
}
/** Minimum raw-output growth (chars) before a streaming partial pass re-parses
 *  a live tree command's output; smaller deltas keep the current tree until the
 *  final pass re-parses everything. */
const PARTIAL_REPARSE_THRESHOLD = 4096;
function parseSemanticOutput(cls: BashSemanticClass, output: string): ParsedSemantic | null {
    if (isBashTreeClass(cls)) return parseBashTreeOutput(cls, output);
    if (isGhClass(cls)) return parseGhOutput(cls, output);
    return parseGitOutput(cls, output);
}
const semanticStates = new Map<string, BashTreeState>();
/** Reset all semantic bash state (session start/shutdown, new message). */
export function resetBashTreeRegistry(): void {
    semanticStates.clear();
}
function renderBashTreeLines(
    theme: BoxTheme,
    state: { cls: BashTreeClass; parsed?: ParsedBashTree },
    width: number,
): string[] {
    const safeWidth = Math.max(1, width);
    const cls = state.cls;
    if (state.parsed && "entries" in state.parsed) {
        const entries = state.parsed.entries;
        return renderOutputTree(
            theme,
            bashTreeHeader(theme, cls, { files: entries.length }),
            entries,
            safeWidth,
            {
                moreUnit: "file",
                indent: TREE_INDENT,
                withIcons: getToolsRenderConfig().nerdFonts,
            },
        );
    }
    if (state.parsed && "matches" in state.parsed) {
        const matches = state.parsed.matches;
        return renderGrepTree(
            theme,
            bashTreeHeader(theme, cls, {
                matches: matches.length,
                files: groupMatchesByFile(matches).length,
            }),
            matches,
            safeWidth,
            { indent: TREE_INDENT, withIcons: getToolsRenderConfig().nerdFonts },
        );
    }
    return [safeTruncateToWidth(bashTreeHeader(theme, cls), safeWidth, "…")];
}
/** Empty result component — the tree lives in the call panel, which re-renders
 *  with the parsed output once the result arrives. */
const EMPTY_BASH_TREE_RESULT: Component = {
    invalidate() {},
    render() {
        return [];
    },
};
/** Live panel component for a classified bash command: pending header until the
 *  result arrives, then the parsed output tree/card. When the result falls back
 *  to the boxed shell, the call renders the boxed bash call instead, so call and
 *  result form one complete box and never duplicate. The state reference is
 *  captured at creation so a registry clear on session reset/resume does not
 *  blank already-rendered panels. */
function renderSemanticPanel(
    theme: BoxTheme,
    toolCallId: string,
    context: BoxedToolContext,
): Component {
    const state = semanticStates.get(toolCallId);
    return {
        invalidate() {},
        render(width: number): string[] {
            if (!state) return [];
            const renderFresh = () => {
                if (state.fallback) {
                    return renderBoxedBashCall(
                        theme,
                        state.command.split("\n"),
                        context,
                        bashWidthKey(state.command, context?.args?.timeout),
                    ).render(width);
                }
                if (isBashTreeClass(state.cls)) {
                    const treeState: { cls: BashTreeClass; parsed?: ParsedBashTree } = {
                        cls: state.cls,
                    };
                    if (state.parsed !== undefined)
                        treeState.parsed = state.parsed as ParsedBashTree;
                    return renderBashTreeLines(theme, treeState, width);
                }
                // Git classes only ever carry git parsed values (parseSemanticOutput
                // dispatches on the class), so the narrowed cast is exact.
                if (isGhClass(state.cls)) {
                    const ghState: { cls: GhSemanticClass; parsed?: GhParsedSemantic } = {
                        cls: state.cls,
                    };
                    if (state.parsed !== undefined)
                        ghState.parsed = state.parsed as GhParsedSemantic;
                    return renderGhCardLines(theme, ghState, width);
                }
                const gitState: { cls: GitSemanticClass; parsed?: GitParsedSemantic } = {
                    cls: state.cls,
                };
                if (state.parsed !== undefined) gitState.parsed = state.parsed as GitParsedSemantic;
                return renderGitCardLines(theme, gitState, width);
            };
            if (!state.finished) return renderFresh();
            const cacheKey = [
                themeCacheKey(theme),
                getToolsRenderCacheSignature(),
                width,
                state.revision,
            ].join("|");
            if (state.renderCache?.key === cacheKey) return state.renderCache.lines;
            const lines = renderFresh();
            state.renderCache = { key: cacheKey, lines };
            return lines;
        },
    };
}
const bashTool: BoxedToolDefinition = {
    call(args, theme, context) {
        noteExecutionStart(context);
        const cls = classifyBashSemantic(String(args?.command ?? ""));
        if (cls) {
            const command = String(args?.command ?? "");
            const existing = semanticStates.get(context.toolCallId);
            if (existing) {
                if (existing.command !== command || existing.cls.kind !== cls.kind) {
                    delete existing.parsed;
                    delete existing.fallback;
                    existing.finished = false;
                    existing.revision++;
                    delete existing.renderCache;
                    delete existing.lastParsedLength;
                }
                existing.command = command;
                existing.cls = cls;
            } else {
                semanticStates.set(context.toolCallId, {
                    cls,
                    command,
                    finished: false,
                    revision: 0,
                });
            }
            return renderSemanticPanel(theme, context.toolCallId, context);
        }
        noteBoxedCallState(context);
        const rawCommand = String(args?.command ?? "...");
        return renderBoxedBashCall(
            theme,
            rawCommand.split("\n"),
            context,
            bashWidthKey(rawCommand, args?.timeout),
        );
    },
    result(result, options, theme, context) {
        const firstResultPass = !isResultSeen(context.state);
        markResultSeen(context.state);
        const cls = classifyBashSemantic(String(context?.args?.command ?? ""));
        // Action classes (commit/push/pull/fetch) also attempt parsing on exit-1
        // results so informational states like `git commit` with nothing staged
        // render as a card; the fail-closed parser keeps genuine errors raw.
        if (cls && (!context.isError || isGitActionClass(cls))) {
            // Semantic-classified commands render in the call panel; the result adds
            // nothing. Keep terminal state in sync without an elapsed ticker. Git
            // parsers only run on the terminal result: streaming partial output may
            // hold a truncated line that would fail parsing and wrongly fall back.
            if (!options.isPartial) {
                recordExecutionEnded(context.state);
                stopElapsedTicker(context.state);
            }
            if (!options.isPartial || isBashTreeClass(cls)) {
                const output = stripBashToolNoticeLines(stripAnsi(getTextOutput(result)));
                const state = semanticStates.get(context.toolCallId);
                // Live tree classes re-parse on streaming passes, but only once the raw
                // output grew ≥ PARTIAL_REPARSE_THRESHOLD chars since the last parse
                // attempt: re-parsing the full buffer on every partial pass made
                // streaming O(n²). Small deltas keep the current tree; the final pass
                // always re-parses, so the settled registry state matches the ungated
                // path byte for byte.
                const shouldParse =
                    !options.isPartial ||
                    state === undefined ||
                    state.lastParsedLength === undefined ||
                    output.length - state.lastParsedLength >= PARTIAL_REPARSE_THRESHOLD;
                const parsed = shouldParse ? parseSemanticOutput(cls, output) : undefined;
                if (parsed) {
                    if (state) {
                        state.parsed = parsed;
                        state.finished = !options.isPartial;
                        state.revision++;
                        delete state.renderCache;
                        if (options.isPartial) state.lastParsedLength = output.length;
                    } else
                        semanticStates.set(context.toolCallId, {
                            cls,
                            command: String(context?.args?.command ?? ""),
                            parsed,
                            finished: !options.isPartial,
                            revision: 0,
                            ...(options.isPartial ? { lastParsedLength: output.length } : {}),
                        });
                    // `git diff` / `git show` render a boxed adaptive-diff result (one frame
                    // per file); `gh run view --job=<id>` renders a boxed log result. Every
                    // other semantic class renders its whole panel in the call card, so the
                    // result adds nothing.
                    if (isGitDiffClass(cls)) {
                        return renderGitDiffResult(
                            theme,
                            parsed as GitDiffParsed,
                            options,
                            context,
                        );
                    }
                    if (isGhRunJobClass(cls)) {
                        return renderGhRunJobResult(
                            theme,
                            parsed as GhRunJobParsed,
                            options,
                            context,
                        );
                    }
                    return EMPTY_BASH_TREE_RESULT;
                }
                if (!shouldParse) {
                    // Skipped re-parse (sub-threshold growth): keep the current panel. A
                    // live parsed tree still owns the display (the call panel renders it, the
                    // result adds nothing); a fallback keeps streaming raw output into the
                    // open box below.
                    if (state?.parsed !== undefined) return EMPTY_BASH_TREE_RESULT;
                }
                // Unparseable output (ls -l, raw rg summary, non-git output): the boxed
                // shell owns the result; flag the call panel to render nothing so the
                // two don't duplicate. Skipped passes (sub-threshold growth) leave the
                // current panel untouched.
                if (shouldParse) {
                    if (state) {
                        state.fallback = true;
                        state.finished = !options.isPartial;
                        state.revision++;
                        delete state.renderCache;
                        if (options.isPartial) state.lastParsedLength = output.length;
                    }
                }
            }
        } else if (options.isPartial) {
            startElapsedTicker(context.state, context.invalidate);
        } else {
            recordExecutionEnded(context.state);
            stopElapsedTicker(context.state);
        }
        const raw = getTextOutput(result);
        if (options.isPartial) {
            // First partial pass: the running call card stands alone. Later passes
            // stream output into the open continuation without a Response divider.
            if (firstResultPass) return EMPTY_BASH_RESULT;
            return renderBashStreamingResult(theme, raw, options, context);
        }
        return memoizedStateComponent(
            context.state,
            "__piStyleBashFinalResult",
            getRenderCacheKey(
                "bash-final-result",
                theme,
                Boolean(options.expanded),
                Boolean(context.isError),
                String(context?.args?.command ?? ""),
                raw,
                getStateElapsedMs(context.state) ?? "",
            ),
            () => renderBashFinalResult(theme, raw, options, context),
        );
    },
};

// from: pistyle\features\tools\boxed\batch.ts

// Consecutive quiet-tool (read/ls/find) call batching.
//
// Groups back-to-back calls of the same quiet tool inside one assistant turn
// into a single collapsible, **boxless** tree panel instead of one boxed panel
// per call. The first call of a batch becomes its leader: the leader's call
// component renders the whole panel (header + tree), reading the live batch
// state on every render pass. Subsequent members render zero lines, so they
// consume no vertical space.
//
// Design notes:
// - Live batches render directly from the registry so member completions (which
//   trigger ui.requestRender via Pi's tool_execution_end handler) are picked up
//   without cross-component invalidation plumbing. Once a batch is finalized,
//   width/config-stable renders reuse the cached line array.
// - Batch boundaries: a new batch starts when the active batch is closed. The
//   active batch closes when a non-batchable tool call is dispatched
//   (boxed/index.ts), when a new message starts (pi/index.ts), and on session
//   reset (session-coordinator.ts). A lone `read` call renders as a single
//   inline line (`➔ Read <path>`); lone ls/find calls render a flat output
//   tree (a batch of one).
// - No surrounding box: indentation and tree glyphs (├─/└─) carry the
//   hierarchy; the header line of a batched panel is the summary
//   (` Read (N) · 0.08s`).
// - Errors stay visible: failed members are always rendered inline (even in the
//   collapsed state), with their error text indented beneath the path.
// - read members render a single path row (a lone read collapses to one inline
//   line). ls/find members render their parsed output as a file subtree (flat
//   for a lone call, nested per member when batched) — see
//   renderOutputBatchPanel. Pending/failed members without output fall back to
//   the path row.
/** Quiet tools whose calls group into a single batch panel. */
const BATCHABLE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "ls", "find"]);
function isBatchableTool(toolName: unknown): boolean {
    return typeof toolName === "string" && BATCHABLE_TOOL_NAMES.has(toolName);
}
interface BatchToolMeta {
    readonly toolName: string;
    /** Human label shown in the batch header (e.g. "Read", "List", "Find"). */
    readonly label: string;
    /** Header label for output-tree panels: "Find" for find, "List" for ls. */
    readonly headerLabel?: string;
}
type BatchMemberStatus = "pending" | "running" | "done";
interface BatchMember {
    readonly toolCallId: string;
    detail: string;
    status: BatchMemberStatus;
    isError: boolean;
    errorText?: string;
    /** find glob pattern (header detail for output panels). */
    pattern?: string;
    /** Display path (header detail for output panels). */
    pathLabel?: string;
    /** Parsed output entries once the result arrives (ls/find). `undefined` until
     *  the result is registered; an empty array means a successful zero-entry
     *  result (e.g. an empty directory). */
    outputEntries?: string[];
}
type BatchRenderCache = {
    key: string;
    lines: string[];
};
interface BatchState {
    readonly meta: BatchToolMeta;
    readonly leaderId: string;
    readonly startedAt: number;
    completedAt?: number;
    closed: boolean;
    readonly members: BatchMember[];
    revision: number;
    renderCache?: BatchRenderCache;
}
/** Tree head limit: only the first few members are listed, the rest collapse. */
const BATCH_TREE_HEAD_LIMIT = 5;
/** Per-member file subtree head limit in a batched output panel. */
const BATCH_MEMBER_FILE_HEAD_LIMIT = 4;
const BATCH_ERROR_LINES = 2;
/** Indent for tree lines below the header. */
const BATCH_TREE_INDENT = TREE_INDENT;
/** Component rendered for non-leader batch members (zero height). */
const EMPTY_BATCH_COMPONENT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});
let activeBatch: BatchState | undefined;
const batchByCallId = new Map<string, BatchState>();
/** Close the current batch: no new members join; existing panels keep rendering. */
function closeActiveBatch(): void {
    if (!activeBatch) return;
    activeBatch.closed = true;
    activeBatch = undefined;
}
/** Reset all batch state (session start/shutdown). */
export function resetBatchRegistry(): void {
    activeBatch = undefined;
    batchByCallId.clear();
}
function createBatch(
    meta: BatchToolMeta,
    leaderId: string,
    detail: string,
    opts: { pattern?: string; pathLabel?: string } = {},
): BatchState {
    const batch: BatchState = {
        meta,
        leaderId,
        startedAt: performance.now(),
        closed: false,
        revision: 0,
        members: [
            {
                toolCallId: leaderId,
                detail,
                status: "pending",
                isError: false,
                ...(opts.pattern ? { pattern: opts.pattern } : {}),
                ...(opts.pathLabel ? { pathLabel: opts.pathLabel } : {}),
            },
        ],
    };
    activeBatch = batch;
    batchByCallId.set(leaderId, batch);
    return batch;
}
function bumpBatchRevision(batch: BatchState): void {
    batch.revision++;
    delete batch.renderCache;
}
/**
 * Register a call renderer invocation. Idempotent per toolCallId: re-fires
 * (updateDisplay on the same component) reuse the call's existing batch, even
 * after the batch was closed.
 */
function registerBatchCall(
    meta: BatchToolMeta,
    detail: string,
    context: BoxedToolContext,
    opts: { pattern?: string; pathLabel?: string } = {},
): { batch: BatchState; isLeader: boolean } {
    const existing = batchByCallId.get(context.toolCallId);
    if (existing) {
        const member = existing.members.find((entry) => entry.toolCallId === context.toolCallId);
        if (member) {
            const changed =
                member.detail !== detail ||
                member.pattern !== opts.pattern ||
                member.pathLabel !== opts.pathLabel;
            member.detail = detail;
            if (opts.pattern !== undefined) member.pattern = opts.pattern;
            if (opts.pathLabel !== undefined) member.pathLabel = opts.pathLabel;
            if (changed) bumpBatchRevision(existing);
        }
        return { batch: existing, isLeader: existing.leaderId === context.toolCallId };
    }
    const current = activeBatch;
    if (!current || current.closed || current.meta.toolName !== meta.toolName) {
        closeActiveBatch();
        return { batch: createBatch(meta, context.toolCallId, detail, opts), isLeader: true };
    }
    const member: BatchMember = {
        toolCallId: context.toolCallId,
        detail,
        status: "pending",
        isError: false,
        ...(opts.pattern ? { pattern: opts.pattern } : {}),
        ...(opts.pathLabel ? { pathLabel: opts.pathLabel } : {}),
    };
    current.members.push(member);
    batchByCallId.set(context.toolCallId, current);
    bumpBatchRevision(current);
    return { batch: current, isLeader: false };
}
interface BatchResultData {
    readonly isPartial: boolean;
    readonly isError: boolean;
    readonly errorText: string | undefined;
    /** Parsed output entries (ls/find) stored on the member for tree rendering. */
    readonly entries?: string[];
}
/**
 * Register a result renderer invocation: updates the member's status/metadata
 * and records batch completion once every member has settled. The member's
 * display detail stays as registered by the call renderer (the result context's
 * args may be normalized differently).
 *
 * `data.entries === undefined` means "keep the registered entries": callers
 * that already registered final output (see hasFinalBatchOutput) omit the
 * field on warm re-render passes, and that must never count as a change —
 * comparing against the stored array would otherwise bump the revision on
 * every pass.
 */
function registerBatchResult(
    meta: BatchToolMeta,
    data: BatchResultData,
    context: BoxedToolContext,
): { batch: BatchState | undefined; isLeader: boolean } {
    const batch = batchByCallId.get(context.toolCallId);
    if (!batch || batch.meta.toolName !== meta.toolName)
        return { batch: undefined, isLeader: false };
    const member = batch.members.find((entry) => entry.toolCallId === context.toolCallId);
    if (member) {
        const nextStatus = data.isPartial ? "running" : "done";
        const nextIsError = !data.isPartial && data.isError;
        const changed =
            member.status !== nextStatus ||
            member.isError !== nextIsError ||
            member.errorText !== (nextIsError ? data.errorText : undefined) ||
            (data.entries !== undefined && member.outputEntries !== data.entries);
        member.status = nextStatus;
        member.isError = nextIsError;
        if (member.isError && data.errorText !== undefined) member.errorText = data.errorText;
        else delete member.errorText;
        if (data.entries !== undefined) member.outputEntries = data.entries;
        if (changed) bumpBatchRevision(batch);
    }
    if (
        batch.completedAt === undefined &&
        batch.members.every((entry) => entry.status === "done")
    ) {
        batch.completedAt = performance.now();
        bumpBatchRevision(batch);
    }
    return { batch, isLeader: batch.leaderId === context.toolCallId };
}
/** True when the member for `toolCallId` has settled with final parsed output
 *  (done, non-error, entries registered). Result renderers use this to skip
 *  re-parsing an unchanged final output on warm re-render passes. */
function hasFinalBatchOutput(toolCallId: string): boolean {
    const batch = batchByCallId.get(toolCallId);
    if (!batch) return false;
    const member = batch.members.find((entry) => entry.toolCallId === toolCallId);
    return (
        member !== undefined &&
        member.outputEntries !== undefined &&
        member.status === "done" &&
        !member.isError
    );
}
interface BatchStatus {
    readonly total: number;
    readonly done: number;
    readonly failed: number;
    readonly allDone: boolean;
    readonly elapsedMs: number | undefined;
}
function batchStatus(batch: BatchState): BatchStatus {
    let done = 0;
    let failed = 0;
    for (const member of batch.members) {
        if (member.status !== "done") continue;
        done++;
        if (member.isError) failed++;
    }
    const total = batch.members.length;
    const allDone = done === total;
    return {
        total,
        done,
        failed,
        allDone,
        elapsedMs:
            allDone && batch.completedAt !== undefined
                ? batch.completedAt - batch.startedAt
                : undefined,
    };
}
function formatElapsed(theme: BoxTheme, elapsedMs: number): string {
    return `${theme.fg("dim", " · ")}${formatElapsedMetric(theme, elapsedMs)}`;
}
function bold(theme: BoxTheme, text: string): string {
    return typeof theme?.bold === "function" ? theme.bold(text) : text;
}
function isOutputTool(meta: BatchToolMeta): boolean {
    return meta.toolName === "ls" || meta.toolName === "find";
}
/** Header line: state glyph + batch label(count) + progress/elapsed (no box). */
function formatBatchHeader(theme: BoxTheme, batch: BatchState, status: BatchStatus): string {
    const label = `${batch.meta.headerLabel ?? batch.meta.label} (${status.total})`;
    if (status.failed > 0)
        return theme.fg("error", bold(theme, `✗ ${label} · ${status.failed} failed`));
    if (status.allDone) {
        const glyph = getToolsRenderConfig().batchOpenGlyph;
        const elapsed =
            status.elapsedMs === undefined ? "" : formatElapsed(theme, status.elapsedMs);
        return `${theme.fg("text", bold(theme, `${glyph} ${label}`))}${elapsed}`;
    }
    if (status.done > 0)
        return `${theme.fg("text", bold(theme, `${RUNNING_TITLE_GLYPH} ${label}`))}${theme.fg("dim", ` · ${status.done}/${status.total}`)}`;
    return bold(theme, formatToolTitlePrefix(theme, label));
}
function memberGlyph(theme: BoxTheme, member: BatchMember, show: boolean): string {
    if (!show) return "";
    if (member.isError) return theme.fg("error", "✗");
    if (member.status === "done") return theme.fg("success", "✓");
    return theme.fg("text", RUNNING_TITLE_GLYPH);
}
function renderErrorLines(theme: BoxTheme, errorText: string, width: number): string[] {
    const raw = stripAnsi(errorText)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (raw.length === 0) return [];
    const prefix = `${dimLine("  │  ")}`;
    const out = raw
        .slice(0, BATCH_ERROR_LINES)
        .map((line) =>
            safeTruncateToWidth(`${prefix}${theme.fg("error", line)}`, Math.max(1, width), "…"),
        );
    if (raw.length > BATCH_ERROR_LINES)
        out.push(
            safeTruncateToWidth(`${prefix}${theme.fg("error", "…")}`, Math.max(1, width), "…"),
        );
    return out;
}
function renderBatchTree(
    theme: BoxTheme,
    batch: BatchState,
    status: BatchStatus,
    width: number,
): string[] {
    const showGlyphs = !status.allDone || status.failed > 0;
    const visible = batch.members.slice(0, BATCH_TREE_HEAD_LIMIT);
    const more = batch.members.length - visible.length;
    const lastIndex = visible.length - 1;
    const out: string[] = [];
    for (let i = 0; i < visible.length; i++) {
        const member = visible[i];
        if (!member) continue;
        const branch = i < lastIndex || more > 0 ? "├─" : "└─";
        const glyph = memberGlyph(theme, member, showGlyphs);
        // Primary color for files read successfully, error red for failures.
        const pathColor = member.isError ? "error" : member.status === "done" ? "accent" : "text";
        const line = `${BATCH_TREE_INDENT}${dimLine(branch)}${glyph ? ` ${glyph}` : ""} ${theme.fg(pathColor, member.detail)}`;
        out.push(safeTruncateToWidth(line, Math.max(1, width), "…"));
        if (member.isError && member.errorText)
            out.push(...renderErrorLines(theme, member.errorText, width));
    }
    if (more > 0) {
        out.push(
            safeTruncateToWidth(
                `${BATCH_TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `${more} more`)}`,
                Math.max(1, width),
                "…",
            ),
        );
    }
    return out;
}
/** Header for a lone (batch-of-one) ls/find output panel: `Find: <pattern> <N> files · in <path>`. */
function formatLoneOutputHeader(theme: BoxTheme, meta: BatchToolMeta, member: BatchMember): string {
    const label = meta.headerLabel ?? meta.label;
    const count = member.outputEntries?.length ?? 0;
    const filesPart = theme.fg("accent", `${count} ${count === 1 ? "file" : "files"}`);
    const patternPart =
        meta.toolName === "find" && member.pattern ? `${theme.fg("text", member.pattern)} ` : "";
    const pathPart = member.pathLabel ? theme.fg("dim", ` · in ${member.pathLabel}`) : "";
    // ls/find headers carry the magnifying-glass icon in Nerd Font mode,
    // matching find/grep.
    const icon = getToolsRenderConfig().nerdFonts ? `${SEARCH_ICON} ` : "";
    return `${icon}${bold(theme, `${label}:`)} ${patternPart}${filesPart}${pathPart}`;
}
/** Nested file subtree for one member inside a batched (2+) output panel. */
function renderMemberSubtree(
    theme: BoxTheme,
    member: BatchMember,
    isLastMember: boolean,
    width: number,
): string[] {
    const safeWidth = Math.max(1, width);
    const trunk = isLastMember ? " " : dimLine("│");
    const out: string[] = [];
    // Member header row: path + file count (or status glyph when not done).
    const entries = member.outputEntries ?? [];
    if (member.isError) {
        const line = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} ${theme.fg("error", "✗")} ${theme.fg("error", member.pathLabel ?? member.detail)}`;
        out.push(safeTruncateToWidth(line, safeWidth, "…"));
        if (member.errorText) out.push(...renderErrorLines(theme, member.errorText, width));
        return out;
    }
    if (member.status !== "done" || member.outputEntries === undefined) {
        const glyph =
            member.status === "done"
                ? theme.fg("success", "✓")
                : theme.fg("text", RUNNING_TITLE_GLYPH);
        const line = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} ${glyph} ${theme.fg("text", member.pathLabel ?? member.detail)}`;
        out.push(safeTruncateToWidth(line, safeWidth, "…"));
        return out;
    }
    const countLabel = theme.fg(
        "dim",
        ` · ${entries.length} ${pluralForm("file", entries.length)}`,
    );
    const headerLine = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} ${theme.fg("accent", member.pathLabel ?? member.detail)}${countLabel}`;
    out.push(safeTruncateToWidth(headerLine, safeWidth, "…"));
    const visible = entries.slice(0, BATCH_MEMBER_FILE_HEAD_LIMIT);
    const more = entries.length - visible.length;
    const lastIndex = visible.length - 1;
    const icons = getToolsRenderConfig().nerdFonts;
    for (let i = 0; i < visible.length; i++) {
        const entry = visible[i] ?? "";
        const label = icons && entry ? `${fileIcon(entry)} ${entry}` : entry;
        const branch = i < lastIndex || more > 0 ? "├─" : "└─";
        const line = `${BATCH_TREE_INDENT}${trunk}${TREE_CHILD_INDENT}${dimLine(branch)} ${theme.fg("toolOutput", label)}`;
        out.push(safeTruncateToWidth(line, safeWidth, "…"));
    }
    if (more > 0) {
        const line = `${BATCH_TREE_INDENT}${trunk}${TREE_CHILD_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("file", more)}`)}`;
        out.push(safeTruncateToWidth(line, safeWidth, "…"));
    }
    return out;
}
/** ls/find output panel: lone call renders a flat tree; a batch renders nested subtrees. */
function renderOutputBatchPanel(
    theme: BoxTheme,
    batch: BatchState,
    status: BatchStatus,
    width: number,
): string[] {
    const safeWidth = Math.max(1, width);
    // Lone successful call with output: flat tree under a `Find:/List:` header.
    if (batch.members.length === 1) {
        const member = batch.members[0];
        if (member && member.outputEntries !== undefined && !member.isError) {
            const header = safeTruncateToWidth(
                formatLoneOutputHeader(theme, batch.meta, member),
                safeWidth,
                "…",
            );
            return renderOutputTree(theme, header, member.outputEntries, safeWidth, {
                headLimit: OUTPUT_TREE_HEAD_LIMIT,
                moreUnit: "file",
                entryColor: "toolOutput",
                indent: BATCH_TREE_INDENT,
                withIcons: getToolsRenderConfig().nerdFonts,
            });
        }
        // Pending/error/empty-without-entries: fall through to the path-only panel.
    }
    // Batched (2+) or a not-yet-ready lone call: per-member rows/subtrees.
    const header = safeTruncateToWidth(formatBatchHeader(theme, batch, status), safeWidth, "…");
    const out: string[] = [header];
    const visible = batch.members.slice(0, BATCH_TREE_HEAD_LIMIT);
    const more = batch.members.length - visible.length;
    visible.forEach((member, index) => {
        const isLast = index === visible.length - 1 && more <= 0;
        out.push(...renderMemberSubtree(theme, member, isLast, safeWidth));
    });
    if (more > 0) {
        out.push(
            safeTruncateToWidth(
                `${BATCH_TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `${more} more`)}`,
                safeWidth,
                "…",
            ),
        );
    }
    return out;
}
/** Lone `read` call: single inline line `➔ Read <path>` — no count, no tree. */
function isLoneRead(batch: BatchState): boolean {
    return batch.meta.toolName === "read" && batch.members.length === 1;
}
/** Lone read renders `➔ Read <path>` on one line; errors keep their error text. */
function renderLoneReadPanel(
    theme: BoxTheme,
    batch: BatchState,
    status: BatchStatus,
    width: number,
): string[] {
    const member = batch.members[0];
    if (!member) return [];
    const prefix = bold(theme, formatToolTitlePrefix(theme, batch.meta.label));
    const glyph = memberGlyph(theme, member, !status.allDone || status.failed > 0);
    const pathColor = member.isError ? "error" : member.status === "done" ? "accent" : "text";
    const out = [
        safeTruncateToWidth(
            `${prefix}${glyph ? ` ${glyph}` : ""} ${theme.fg(pathColor, member.detail)}`,
            Math.max(1, width),
            "…",
        ),
    ];
    if (member.isError && member.errorText)
        out.push(...renderErrorLines(theme, member.errorText, width));
    return out;
}
function renderBatchPanelLines(
    theme: BoxTheme,
    batch: BatchState,
    status: BatchStatus,
    width: number,
): string[] {
    // Lone read collapses to a single inline line; batched reads and lone
    // ls/find calls keep their tree panels.
    if (isLoneRead(batch)) return renderLoneReadPanel(theme, batch, status, width);
    if (
        isOutputTool(batch.meta) &&
        batch.members.some((member) => member.outputEntries !== undefined)
    ) {
        return renderOutputBatchPanel(theme, batch, status, width);
    }
    const header = safeTruncateToWidth(
        formatBatchHeader(theme, batch, status),
        Math.max(1, width),
        "…",
    );
    const lines = [header];
    lines.push(...renderBatchTree(theme, batch, status, width));
    return lines;
}
/**
 * Leader call component: renders the live batch panel (header + tree) reading
 * the registry on every render pass. Members render EMPTY_BATCH_COMPONENT.
 */
function renderBatchAwareCall(theme: BoxTheme, batch: BatchState): Component {
    return {
        invalidate() {
            delete batch.renderCache;
        },
        render(width: number): string[] {
            const status = batchStatus(batch);
            if (!status.allDone) return renderBatchPanelLines(theme, batch, status, width);
            const cacheKey = [
                themeCacheKey(theme),
                getToolsRenderCacheSignature(),
                width,
                batch.revision,
            ].join("|");
            if (batch.renderCache?.key === cacheKey) return batch.renderCache.lines;
            const lines = renderBatchPanelLines(theme, batch, status, width);
            batch.renderCache = { key: cacheKey, lines };
            return lines;
        },
    };
}
/**
 * Empty result component for the batch leader. The panel lives in the call
 * component; the result adds nothing. Deliberately NOT the shared member
 * singleton, so the decoration's hideBatchMember (identity-compared to
 * EMPTY_BATCH_COMPONENT) never hides the leader.
 */
function emptyBatchResult(): Component {
    return {
        invalidate() {},
        render() {
            return [];
        },
    };
}

// from: pistyle\features\tools\boxed\edit.ts

// Boxed edit tool renderer
// (renderCall/renderResult only; no edit-core re-registration).
const MAX_HIGHLIGHT_DIFF_CHARS = 12000;
const MAX_HIGHLIGHT_DIFF_ROWS = 120;
/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_EDIT_RESULT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});
type EditResultDetails = { diff?: string; path?: string } | undefined;
/** Edit footer: elapsed time only. The diff stats live in the box header and
 *  a single edited file is implied, so neither repeats in the footer. */
function editDiffFooter(
    theme: BoxTheme,
    result: { content?: readonly unknown[]; details?: unknown },
    context: BoxedToolContext,
): string {
    const elapsedMs = getElapsedMs(result) ?? stateElapsedMs(context);
    return formatElapsedMetric(theme, elapsedMs);
}
const editTool: BoxedToolDefinition = {
    call(args, theme, context) {
        noteExecutionStart(context);
        noteBoxedCallState(context);
        const path = displayPath(String(args?.path ?? args?.file_path ?? ""), context);
        return renderBoxedToolCall(theme, "Edit", [], {
            // Lazy: the settled result publishes diff stats into the shared renderer
            // state, and this function resolves at render time — so the header picks
            // up `· +N -M` on the same paint the diff body appears (the write footer
            // uses the same state-sharing contract).
            headerDetail: () => `${path}${diffHeaderStatsSuffix(theme, context)}`,
            isError: Boolean(context.isError),
            isPartial: Boolean(context.isPartial),
            isPending: Boolean(context.isPartial),
            running: Boolean(context.executionStarted),
            resultSeen: isResultSeen(context.state),
        });
    },
    result(result, options, theme, context) {
        // Handle partial/streaming state: continue the open call box with the
        // applying hint (no Response divider until the tool settles).
        if (options.isPartial) {
            const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
            if (firstResultPass) return EMPTY_EDIT_RESULT;
            return renderBoxedToolResult(
                theme,
                () => [`${theme.fg("dim", "↳")} ${theme.fg("muted", "Applying edit...")}`],
                {
                    showDivider: false,
                    footerLines: [formatBoxedRunningStatus(theme, stateElapsedMs(context))],
                    isPartial: true,
                },
            );
        }
        // Handle errors
        if (context.isError) {
            clearDiffHeaderStats(context);
            const output = getTextOutput(result);
            return renderBoxedToolResult(
                theme,
                () => [theme.fg("error", stripAnsi(output).trim() || "Error")],
                {
                    footerLines: resultFooterLines(theme, result, context),
                    isError: true,
                },
            );
        }
        // Extract diff from result details
        const details = result.details as EditResultDetails;
        const diff = details?.diff as string | undefined;
        if (!diff) {
            clearDiffHeaderStats(context);
            const output = stripAnsi(getTextOutput(result)).trim();
            const fallback = `↳ ${output || "Edit applied"}`;
            return renderBoxedToolResult(theme, () => [theme.fg("dim", fallback)], {
                footerLines: resultFooterLines(theme, result, context),
            });
        }
        // Resolve the edited path (cache-key input + language hint source).
        const message = firstText(result.content as Array<{ type: string; text?: string }>);
        const argPath = String(context?.args?.path ?? context?.args?.file_path ?? "");
        const sourcePath = details?.path ?? (argPath || extractEditedPath(message));
        const expanded = options.expanded;
        // Stats feed the header slot and the cache key (cheap line scan — unlike
        // the row/component construction below, which must not run on hits).
        const stats = countDiffStats(diff);
        noteDiffHeaderStats(context, stats);
        const footer = editDiffFooter(theme, result, context);
        return memoizedStateComponent(
            context.state,
            "__piStyleEditDiffResult",
            getRenderCacheKey(
                "edit-diff-result",
                theme,
                Boolean(expanded),
                diff,
                sourcePath ?? "",
                footer,
            ),
            () => {
                // Expensive construction (buildSplitRows + AdaptiveDiffComponent,
                // ~0.4ms for a 160-row diff) runs only on cache misses, never per
                // render pass. Everything below is a pure function of the key inputs.
                const language = sourcePath ? getLanguageFromPath(sourcePath) : undefined;
                const rows = buildSplitRows(diff);
                const shouldHighlight =
                    Boolean(language) &&
                    diff.length <= MAX_HIGHLIGHT_DIFF_CHARS &&
                    rows.length <= MAX_HIGHLIGHT_DIFF_ROWS;
                // Render adaptive diff (unified/split per width) with syntax colors for small outputs.
                const maxRows = expanded ? 160 : 36;
                const diffView = new AdaptiveDiffComponent(
                    theme,
                    rows,
                    maxRows,
                    shouldHighlight ? language : undefined,
                );
                const expandHint = !expanded && diffView.hasCollapsed() ? "Ctrl+O more" : undefined;
                return renderBoxedToolResult(
                    theme,
                    {
                        render(width: number): string[] {
                            return diffView.render(width);
                        },
                        invalidate(): void {
                            diffView.invalidate();
                        },
                    },
                    {
                        // Stats live in the box header (`➔ Edit ✓ · path · +N -M`), so no
                        // `Diff` divider: the body continues the open call box directly.
                        showDivider: false,
                        skipLeadingBlank: true,
                        ...(expandHint ? { expandHint } : {}),
                        footerLines: footer ? [footer] : [],
                    },
                );
            },
        );
    },
};

// from: pistyle\features\tools\boxed\fallback.ts

// Boxed fallback for tools without a dedicated renderer.
// (component side only; no ToolExecutionComponent prototype patching).
const MAX_FALLBACK_PREVIEW_LINES = 10;
export function renderFallbackCall(
    toolName: unknown,
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    noteExecutionStart(context);
    noteBoxedCallState(context);
    return renderBoxedToolCall(
        theme,
        formatToolName(String(toolName ?? "Tool")),
        formatToolParamLines(args, theme),
        {
            isError: Boolean(context.isError),
            isPartial: Boolean(context.isPartial),
            isPending: Boolean(context.isPartial),
            running: Boolean(context.executionStarted),
            resultSeen: isResultSeen(context.state),
        },
    );
}
export function renderFallbackResult(
    _toolName: unknown,
    result: MetricResultLike,
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
    const isError = Boolean(context.isError);
    const expanded = Boolean(options.expanded);
    const maxLines = expanded
        ? getToolsRenderConfig().maxExpandedLines
        : MAX_FALLBACK_PREVIEW_LINES;
    const output = getTextOutput(result);
    const elapsedMs = getStateElapsedMs(context.state);
    const { lines, omitted } = selectRenderLines(output, maxLines);
    if (options.isPartial) {
        // Streaming continuation into the open call box: no Response divider and
        // no metrics footer until the tool settles. The first partial pass renders
        // nothing so the pending/running call card stands alone.
        if (firstResultPass) return EMPTY_FALLBACK_RESULT;
        const hasOutput = output.trim().length > 0;
        return renderBoxedToolResult(
            theme,
            () => {
                const body = lines.map((line) => formatToolOutputLine(theme, line, "toolOutput"));
                if (!hasOutput) body.push(theme.fg("dim", "No output received yet"));
                return body;
            },
            {
                dividerLabel: "Output",
                showDivider: hasOutput,
                footerLines: [formatBoxedRunningStatus(theme, elapsedMs)],
                isPartial: true,
            },
        );
    }
    return renderBoxedToolResult(
        theme,
        () => {
            const body = lines.map((line) =>
                formatToolOutputLine(theme, line, isError ? "error" : "toolOutput"),
            );
            if (expanded && omitted > 0) {
                body.push(theme.fg("muted", `… ${omitted} more lines omitted by render budget`));
            }
            return body;
        },
        {
            footerLines: [formatBoxedFooterWithElapsed(theme, elapsedMs, output)],
            renderLineBudget: maxLines,
            ...(expanded || omitted <= 0 ? {} : { expandHint: "Ctrl+O for more" }),
            isError,
            isPartial: Boolean(options.isPartial),
        },
    );
}
/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_FALLBACK_RESULT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});
function formatBoxedFooterWithElapsed(
    theme: BoxTheme,
    elapsedMs: number | undefined,
    output: string,
): string {
    const elapsed =
        elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs);
    const words = output.trim() ? formatBoxedWords(theme, output) : "";
    const parts = [elapsed];
    if (words) parts.push(words);
    return parts.join(theme.fg("dim", " · "));
}
// Re-exported for callers that need the tool-name label normalization.
export { formatToolName };

// from: pistyle\features\tools\boxed\find.ts

// Boxed find tool renderer.
//
// find calls render as a boxless tree panel — a lone find shows its parsed
// output as a flat `Find: <pattern> <N> files · in <path>` tree; consecutive
// find calls group into one panel with per-member nested subtrees (see
// batch.ts). Pending/failed calls without output fall back to a path row.
const FIND_META: BatchToolMeta = Object.freeze({
    toolName: "find",
    label: "Find",
    headerLabel: "Find",
});
function pathLabel(rawPath: string): string {
    const displayPath = String(rawPath ?? ".");
    return displayPath === "." || displayPath === ""
        ? "current directory"
        : shortenPath(displayPath);
}
function queryDetail(pattern: string, rawPath: string): string {
    const path = pathLabel(rawPath);
    return pattern ? `${pattern} in ${path}` : path;
}
const findTool: BoxedToolDefinition = {
    call(args, theme, context) {
        noteExecutionStart(context);
        const pattern = String(args?.pattern ?? "");
        const rawPath = String(args?.path ?? ".");
        const detail = queryDetail(pattern, rawPath);
        const { isLeader, batch } = registerBatchCall(FIND_META, detail, context, {
            pattern,
            pathLabel: pathLabel(rawPath),
        });
        if (!isLeader) return EMPTY_BATCH_COMPONENT;
        return renderBatchAwareCall(theme, batch);
    },
    result(result, options, _theme, context) {
        const isError = Boolean(context.isError);
        // Result renderers re-fire on every repaint/scroll; once the final output
        // is parsed and registered, skip stripping/parsing the same text again.
        const settled = !options.isPartial && !isError && hasFinalBatchOutput(context.toolCallId);
        const output = settled ? "" : stripAnsi(getTextOutput(result)).trimEnd();
        const entries = settled || isError ? undefined : parseFindOutput(output);
        registerBatchResult(
            FIND_META,
            {
                isPartial: Boolean(options.isPartial),
                isError,
                errorText: isError ? output || undefined : undefined,
                ...(entries !== undefined ? { entries } : {}),
            },
            context,
        );
        return emptyBatchResult();
    },
};

// from: pistyle\features\tools\boxed\grep.ts

// Boxed grep/search tool renderer.
//
// grep renders a **boxless tree panel**: a summary header
// (`Grep: <pattern> <N> matches · <M> files · in <path>`) followed by match rows
// grouped by file (`├─ *line│content`). Like the quiet-tool batch panel, the
// whole panel lives in the call component and reads a live registry on every
// render, so the result's match data is picked up without cross-component
// invalidation. grep does not batch (each call owns its own panel).
//
// Lifecycle: panels are keyed by toolCallId and cleared on session reset and new
// message boundaries (see resetGrepRegistry wiring in session-coordinator.ts and
// pi/index.ts), mirroring the batch registry.
const GREP_HEAD_LIMIT = 6;
const GREP_ERROR_LINES = 2;
interface GrepPanelState {
    pattern: string;
    pathLabel: string;
    /** `undefined` until the result arrives; an empty array means zero matches. */
    matches: GrepMatch[] | undefined;
    isError: boolean;
    errorText: string | undefined;
    isPartial: boolean;
}
const grepPanels = new Map<string, GrepPanelState>();
/** Reset all grep panel state (session start/shutdown). */
export function resetGrepRegistry(): void {
    grepPanels.clear();
}
function registerGrepCall(toolCallId: string, pattern: string, label: string): void {
    const existing = grepPanels.get(toolCallId);
    if (existing) {
        existing.pattern = pattern;
        existing.pathLabel = label;
        return;
    }
    grepPanels.set(toolCallId, {
        pattern,
        pathLabel: label,
        matches: undefined,
        isError: false,
        errorText: undefined,
        isPartial: true,
    });
}
function registerGrepResult(
    toolCallId: string,
    data: {
        matches: GrepMatch[];
        isError: boolean;
        errorText: string | undefined;
        isPartial: boolean;
    },
): void {
    const state = grepPanels.get(toolCallId);
    if (!state) return;
    state.matches = data.matches;
    state.isError = data.isError;
    state.errorText = data.errorText;
    state.isPartial = data.isPartial;
}
/** `Grep: <pattern> <N> matches · <M> files · in <path>` (done) /
 *  `Grep: <pattern> · in <path>` (pending). */
function formatGrepHeader(theme: BoxTheme, state: GrepPanelState): string {
    const icon = getToolsRenderConfig().nerdFonts ? `${SEARCH_ICON} ` : "";
    const label = bold(theme, "Grep:");
    const patternPart = state.pattern ? ` ${theme.fg("text", state.pattern)}` : "";
    const pathPart = state.pathLabel ? theme.fg("dim", ` · in ${state.pathLabel}`) : "";
    if (state.isError) {
        return `${icon}${theme.fg("error", bold(theme, "✗ Grep:"))}${state.pattern ? ` ${theme.fg("error", state.pattern)}` : ""}${pathPart}`;
    }
    if (state.matches === undefined) {
        return `${icon}${label}${patternPart}${pathPart}`;
    }
    const matchCount = state.matches.length;
    const fileCount = groupMatchesByFile(state.matches).length;
    const matchesPart = theme.fg("accent", `${matchCount} ${pluralForm("match", matchCount)}`);
    const filesPart = theme.fg("dim", ` · ${fileCount} ${pluralForm("file", fileCount)}`);
    return `${icon}${label}${patternPart} ${matchesPart}${filesPart}${pathPart}`;
}
function renderGrepErrorLines(theme: BoxTheme, errorText: string, width: number): string[] {
    const raw = stripAnsi(errorText)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (raw.length === 0) return [];
    const prefix = `${TREE_INDENT}${dimLine("└─")} `;
    const out = raw
        .slice(0, GREP_ERROR_LINES)
        .map((line) =>
            safeTruncateToWidth(`${prefix}${theme.fg("error", line)}`, Math.max(1, width), "…"),
        );
    if (raw.length > GREP_ERROR_LINES)
        out.push(
            safeTruncateToWidth(`${prefix}${theme.fg("error", "…")}`, Math.max(1, width), "…"),
        );
    return out;
}
function renderGrepPanelLines(theme: BoxTheme, state: GrepPanelState, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const header = safeTruncateToWidth(formatGrepHeader(theme, state), safeWidth, "…");
    if (state.isError) {
        return [
            header,
            ...(state.errorText ? renderGrepErrorLines(theme, state.errorText, width) : []),
        ];
    }
    if (state.matches === undefined) return [header];
    return renderGrepTree(theme, header, state.matches, safeWidth, {
        headLimit: GREP_HEAD_LIMIT,
        withIcons: getToolsRenderConfig().nerdFonts,
    });
}
/** Live panel component reading the registry on every render pass. The state
 *  reference is captured at creation (like the batch panel): a registry clear
 *  on session reset/resume must not blank already-rendered panels — the result
 *  renderer mutates this same object, so live updates still flow. */
function renderGrepPanel(theme: BoxTheme, toolCallId: string): Component {
    const state = grepPanels.get(toolCallId);
    return {
        invalidate() {},
        render(width: number): string[] {
            if (!state) return [safeTruncateToWidth(bold(theme, "Grep:"), Math.max(1, width), "…")];
            return renderGrepPanelLines(theme, state, width);
        },
    };
}
/** Empty result component — the panel lives in the call component, which
 *  re-renders when the result arrives (Pi re-renders the tool execution
 *  component on tool_execution_end), picking up the stored matches. */
const EMPTY_GREP_RESULT: Component = {
    invalidate() {},
    render() {
        return [];
    },
};
const grepTool: BoxedToolDefinition = {
    call(args, theme, context) {
        noteExecutionStart(context);
        const pattern = String(args?.pattern ?? "");
        registerGrepCall(context.toolCallId, pattern, pathLabel(String(args?.path ?? ".")));
        return renderGrepPanel(theme, context.toolCallId);
    },
    result(result, options, _theme, context) {
        const isError = Boolean(context.isError);
        const isPartial = Boolean(options.isPartial);
        // Result renderers re-fire on every repaint/scroll; once final matches
        // are registered the registry is already final — skip stripping/parsing.
        const state = grepPanels.get(context.toolCallId);
        if (
            !isPartial &&
            !isError &&
            state !== undefined &&
            state.matches !== undefined &&
            !state.isPartial
        ) {
            return EMPTY_GREP_RESULT;
        }
        const output = stripAnsi(getTextOutput(result)).trimEnd();
        const matches = isError ? [] : parseGrepOutput(output);
        registerGrepResult(context.toolCallId, {
            matches,
            isError,
            errorText: isError ? output || undefined : undefined,
            isPartial,
        });
        return EMPTY_GREP_RESULT;
    },
};

// from: pistyle\features\tools\boxed\ls.ts

// Boxed ls tool renderer.
//
// ls calls render as a boxless tree panel — a lone ls shows its parsed output as
// a flat `List: <N> files · in <path>` tree; consecutive ls calls group into one
// panel with per-member nested subtrees (see batch.ts). Pending/failed calls
// without output fall back to a path row.
const LIST_META: BatchToolMeta = Object.freeze({
    toolName: "ls",
    label: "List",
    headerLabel: "List",
});
function lsDisplayPath(rawPath: string): string {
    const path = String(rawPath ?? ".");
    if (path === "." || path === "") return "current directory";
    return shortenPath(path);
}
const lsTool: BoxedToolDefinition = {
    call(args, theme, context) {
        noteExecutionStart(context);
        const rawPath = String(args?.path ?? ".");
        const detail = lsDisplayPath(rawPath);
        const { isLeader, batch } = registerBatchCall(LIST_META, detail, context, {
            pathLabel: detail,
        });
        if (!isLeader) return EMPTY_BATCH_COMPONENT;
        return renderBatchAwareCall(theme, batch);
    },
    result(result, options, _theme, context) {
        const isError = Boolean(context.isError);
        // Result renderers re-fire on every repaint/scroll; once the final output
        // is parsed and registered, skip stripping/parsing the same text again.
        const settled = !options.isPartial && !isError && hasFinalBatchOutput(context.toolCallId);
        const output = settled ? "" : stripAnsi(getTextOutput(result)).trimEnd();
        const entries = settled || isError ? undefined : parseLsOutput(output);
        registerBatchResult(
            LIST_META,
            {
                isPartial: Boolean(options.isPartial),
                isError,
                errorText: isError ? output || undefined : undefined,
                ...(entries !== undefined ? { entries } : {}),
            },
            context,
        );
        return emptyBatchResult();
    },
};

// from: pistyle\features\tools\boxed\quick-edit.ts

// Boxed quick-edit / substitute-edit / target-edit renderer.
/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_QUICK_EDIT_RESULT = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});
interface QuickEditToolConfig {
    toolLabel: string;
    applyingLabel: string;
    fallbackLabel: string;
}
const QUICK_EDIT_TOOLS: Readonly<Record<string, QuickEditToolConfig>> = {
    quick_edit: {
        toolLabel: "Quick Edit",
        applyingLabel: "quick-edit",
        fallbackLabel: "Quick edit applied",
    },
    substitute_edit: {
        toolLabel: "Substitute Edit",
        applyingLabel: "substitute-edit",
        fallbackLabel: "Substitute edit applied",
    },
    target_edit: {
        toolLabel: "Target Edit",
        applyingLabel: "target-edit",
        fallbackLabel: "Target edit applied",
    },
};
function getQuickEditToolConfig(toolName: unknown): QuickEditToolConfig | undefined {
    return typeof toolName === "string" ? QUICK_EDIT_TOOLS[toolName] : undefined;
}
/**
 * Parse the `── diff ──` section of a quick-edit-family output text into a
 * synthetic unified diff (exported for the turn-summary registry, which
 * derives diff stats from session content without a renderer).
 */
function extractQuickEditDiff(text: string): string | undefined {
    const lines = stripAnsi(text).replace(/\r/g, "").split("\n");
    const start = lines.indexOf("── diff ──");
    if (start < 0) return undefined;
    const diffLines: string[] = [];
    let cumulativeDelta = 0;
    let oldLine: number | undefined;
    let newLine: number | undefined;
    let chunkAdditions = 0;
    let chunkRemovals = 0;
    const finishChunk = () => {
        cumulativeDelta += chunkAdditions - chunkRemovals;
        oldLine = undefined;
        newLine = undefined;
        chunkAdditions = 0;
        chunkRemovals = 0;
    };
    for (const line of lines.slice(start + 1)) {
        if (line === "") {
            finishChunk();
            continue;
        }
        const headerMatch = line.match(/^:(\d+)(?:-\d+)?$/);
        if (headerMatch) {
            finishChunk();
            const startLine = Number.parseInt(headerMatch[1] ?? "", 10);
            oldLine = startLine;
            newLine = startLine + cumulativeDelta;
            continue;
        }
        const match = line.match(/^([+-]) (.*)$/);
        if (match) {
            const [, sign, content = ""] = match;
            let gutter = "";
            if (sign === "-" && oldLine !== undefined) gutter = String(oldLine++);
            if (sign === "+" && newLine !== undefined) gutter = String(newLine++);
            if (!gutter) continue;
            if (sign === "-") chunkRemovals++;
            if (sign === "+") chunkAdditions++;
            diffLines.push(`${sign} ${gutter} ${content}`);
            continue;
        }
        if (line === "---") break;
    }
    return diffLines.length > 0 ? diffLines.join("\n") : undefined;
}
/** Quick-edit footer: elapsed time only. The diff stats live in the box
 *  header and a single edited file is implied, so neither repeats there. */
function quickEditDiffFooter(
    theme: BoxTheme,
    result: { content?: readonly unknown[]; details?: unknown },
    context: BoxedToolContext,
): string {
    const elapsedMs = getElapsedMs(result) ?? getStateElapsedMs(context.state);
    return formatElapsedMetric(theme, elapsedMs);
}
function renderQuickEditResult(
    _toolName: string,
    result: { content?: readonly unknown[]; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
    config: QuickEditToolConfig,
) {
    if (options.isPartial) {
        const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
        if (firstResultPass) return EMPTY_QUICK_EDIT_RESULT;
        return renderBoxedToolResult(
            theme,
            () => [
                `${theme.fg("dim", "↳")} ${theme.fg("muted", `Applying ${config.applyingLabel}...`)}`,
            ],
            {
                showDivider: false,
                footerLines: [formatBoxedRunningStatus(theme, stateElapsedMs(context))],
                isPartial: true,
            },
        );
    }
    const output = getTextOutput(result);
    if (context.isError) {
        clearDiffHeaderStats(context);
        const footer = quickEditFooter(theme, context);
        return renderBoxedToolResult(
            theme,
            () => [theme.fg("error", stripAnsi(output).trim() || "Error")],
            {
                ...(footer ? { footerLines: [footer] } : {}),
                isError: true,
            },
        );
    }
    const diff = extractQuickEditDiff(output);
    if (!diff) {
        clearDiffHeaderStats(context);
        const fallback = stripAnsi(output).trim() || config.fallbackLabel;
        const footer = quickEditFooter(theme, context);
        return renderBoxedToolResult(
            theme,
            () => [`${theme.fg("dim", "↳")} ${theme.fg("muted", fallback)}`],
            {
                ...(footer ? { footerLines: [footer] } : {}),
            },
        );
    }
    const expanded = options.expanded;
    const argPath = String(context?.args?.path ?? "");
    // Stats feed the header slot and the cache key (cheap line scan — unlike
    // the row/component construction below, which must not run on hits).
    const stats = countDiffStats(diff);
    noteDiffHeaderStats(context, stats);
    const footer = quickEditDiffFooter(theme, result, context);
    return memoizedStateComponent(
        context.state,
        "__piStyleQuickEditDiffResult",
        getRenderCacheKey(
            "quick-edit-diff-result",
            theme,
            config.toolLabel,
            Boolean(expanded),
            diff,
            argPath,
            footer,
        ),
        () => {
            // Expensive construction (buildSplitRows + AdaptiveDiffComponent) runs
            // only on cache misses, never per render pass. Everything below is a
            // pure function of the key inputs.
            const rows = buildSplitRows(diff);
            const language = argPath ? getLanguageFromPath(argPath) : undefined;
            const shouldHighlight =
                Boolean(language) &&
                diff.length <= MAX_HIGHLIGHT_DIFF_CHARS &&
                rows.length <= MAX_HIGHLIGHT_DIFF_ROWS;
            const maxRows = expanded ? 160 : 36;
            const diffView = new AdaptiveDiffComponent(
                theme,
                rows,
                maxRows,
                shouldHighlight ? language : undefined,
            );
            const expandHint = !expanded && diffView.hasCollapsed() ? "Ctrl+O more" : undefined;
            return renderBoxedToolResult(
                theme,
                {
                    render(width: number): string[] {
                        return diffView.render(width);
                    },
                    invalidate(): void {
                        diffView.invalidate();
                    },
                },
                {
                    // Stats live in the box header (`➔ Quick Edit ✓ · path · +N -M`),
                    // so no `Diff` divider: the body continues the open call box directly.
                    showDivider: false,
                    skipLeadingBlank: true,
                    ...(expandHint ? { expandHint } : {}),
                    footerLines: footer ? [footer] : [],
                },
            );
        },
    );
}
function quickEditFooter(theme: BoxTheme, context: BoxedToolContext): string {
    const elapsedMs = getStateElapsedMs(context.state);
    return formatElapsedMetric(theme, elapsedMs);
}
function quickEditTool(config: QuickEditToolConfig): BoxedToolDefinition {
    return {
        call(args, theme, context) {
            noteExecutionStart(context);
            noteBoxedCallState(context);
            const path = displayPath(String(args?.path ?? ""), context);
            return renderBoxedToolCall(theme, config.toolLabel, [], {
                // Lazy: the settled result publishes diff stats into the shared renderer
                // state, and this function resolves at render time — so the header picks
                // up `· +N -M` on the same paint the diff body appears.
                headerDetail: () => `${path}${diffHeaderStatsSuffix(theme, context)}`,
                isError: Boolean(context.isError),
                isPartial: Boolean(context.isPartial),
                isPending: Boolean(context.isPartial),
                running: Boolean(context.executionStarted),
                resultSeen: isResultSeen(context.state),
            });
        },
        result(result, options, theme, context) {
            return renderQuickEditResult(config.toolLabel, result, options, theme, context, config);
        },
    };
}

// from: pistyle\features\tools\boxed\read.ts

// Boxed read tool renderer
// (renderCall/renderResult only; no tool re-registration).
//
// Read calls render boxless: a lone read is a single inline line
// (`➔ Read <path>`), consecutive reads group into one tree panel (see
// batch.ts).
const READ_META: BatchToolMeta = Object.freeze({
    toolName: "read",
    label: "Read",
});
const readTool: BoxedToolDefinition = {
    call(args, theme, context) {
        noteExecutionStart(context);
        const rawPath = String(args?.path ?? args?.file_path ?? "");
        const detail = pathRangeDetail(rawPath, args?.offset, args?.limit, context);
        const { isLeader, batch } = registerBatchCall(READ_META, detail, context);
        if (!isLeader) return EMPTY_BATCH_COMPONENT;
        return renderBatchAwareCall(theme, batch);
    },
    result(result, options, _theme, context) {
        // The strip is only needed for error text — keep it off the success path
        // (result renderers re-fire on every repaint/scroll).
        const errorText = context.isError
            ? stripAnsi(getTextOutput(result)).trimEnd() || undefined
            : undefined;
        registerBatchResult(
            READ_META,
            {
                isPartial: Boolean(options.isPartial),
                isError: Boolean(context.isError),
                errorText,
            },
            context,
        );
        return emptyBatchResult();
    },
};

// from: pistyle\features\tools\boxed\write.ts

// Boxed write tool renderer
// (renderCall/renderResult only).
//
// The write call renders a compact preview box: the file path in the top
// border, the written content as numbered lines in the body (cat -n style),
// and the metrics footer in the bottom border. The footer lives in the shared
// renderer state — the result renderer stores it (elapsed + words), the call
// component reads it at paint time and closes the box. The preview is capped
// at the collapsed line budget with a `Ctrl+O for more` hint on the bottom
// border when truncated; expanded shows the expanded budget. Errors keep the
// plain open call box so the boxed error result never duplicates a box.
/** Right-side bottom-border hint shown when the compact preview is truncated. */
const WRITE_EXPAND_HINT = "Ctrl+O for more";
/** Partial-pass result: the compact call keeps its `󰐊 Running` card. */
const EMPTY_WRITE_RESULT: Component = Object.freeze({
    invalidate() {},
    render() {
        return [];
    },
});
type NumberedLine = { number: string; content: string };
/**
 * Numbered preview lines for the written content, `cat -n` style: every split
 * line keeps its number (including a trailing empty line produced by a final
 * newline), right-aligned to the widest line number.
 */
function numberedPreviewLines(content: string): NumberedLine[] {
    const normalized = replaceTabs(String(content ?? "")).replace(/\r/g, "");
    if (!normalized) return [];
    const lines = normalized.split("\n");
    const gutterWidth = Math.max(1, String(lines.length).length);
    return lines.map((line, index) => ({
        number: String(index + 1).padStart(gutterWidth),
        content: line,
    }));
}
/** One boxed preview row: dim gutter + toolOutput content. */
function formatNumberedLine(theme: BoxTheme, line: NumberedLine): string {
    return `${dimLine(`${line.number} `)}${theme.fg("toolOutput", line.content)}`;
}
/** Compact write box: path header, numbered content preview, metrics footer. */
function renderWritePreviewBox(
    theme: BoxTheme,
    detailLine: string,
    content: string,
    options: {
        state?: Record<string, unknown>;
        isError: boolean;
        isPartial: boolean;
        running?: boolean;
        expanded: boolean;
    },
): Component {
    const preview = numberedPreviewLines(content);
    const config = getToolsRenderConfig();
    const budget = options.expanded ? config.maxExpandedLines : config.maxCollapsedLines;
    const truncated = preview.length > budget;
    return renderCompactBoxedToolCall(theme, "Write", detailLine, {
        ...(options.state ? { state: options.state } : {}),
        isError: options.isError,
        isPartial: options.isPartial,
        isPending: options.isPartial,
        running: Boolean(options.running),
        tint: true, // the write preview is a framed box — it owns its status tint
        bodyLines: () => {
            if (preview.length === 0) return [];
            const shown = preview.slice(0, budget).map((line) => formatNumberedLine(theme, line));
            if (!truncated) return shown;
            const omitted = preview.length - budget;
            const note = options.expanded
                ? `… ${omitted} more lines omitted by render budget`
                : `… ${omitted} more lines`;
            return [...shown, theme.fg("muted", note)];
        },
        ...(options.expanded || options.isPartial || !truncated
            ? {}
            : { bottomRightLabel: WRITE_EXPAND_HINT }),
    });
}
const writeTool: BoxedToolDefinition = {
    call(args, theme, context) {
        noteExecutionStart(context);
        const detail = displayPath(String(args?.path ?? args?.file_path ?? ""), context);
        const detailLine = `${theme.fg("dim", "Path: ")}${detail}`;
        // On error keep the plain open box: the result renderer continues it with
        // the boxed error body, so call and result never duplicate a box.
        if (context.isError) {
            return compactCall(theme, "Write", detailLine, {
                detailKey: detail,
                context,
            });
        }
        return renderWritePreviewBox(theme, detailLine, String(args?.content ?? ""), {
            state: context.state,
            isError: context.isError,
            isPartial: context.isPartial,
            running: context.executionStarted,
            expanded: context.expanded,
        });
    },
    result(result, options, theme, context) {
        clearFooterState(context);
        const output = getTextOutput(result);
        const detail = displayPath(
            String(context?.args?.path ?? context?.args?.file_path ?? ""),
            context,
        );
        const widthKey = boxedToolWidthKey("Write", detail);
        if (context.isError) {
            return renderBoxedToolResult(
                theme,
                () => [theme.fg("error", stripAnsi(output).trim() || "Error")],
                {
                    widthKey,
                    footerLines: resultFooterLines(theme, result, context),
                    isError: true,
                },
            );
        }
        // While the result is still streaming, don't stamp a metrics footer into
        // the shared state: the compact call keeps its `󰐊 Running` card and only
        // closes with `elapsed · words` once the tool settles.
        if (options.isPartial) return EMPTY_WRITE_RESULT;
        // Success (compact and expanded): the preview box closes with the metrics
        // footer stored into the shared renderer state; the result adds nothing.
        return compactFooterWithState(theme, result, context);
    },
};

// from: pistyle\features\tools\boxed\index.ts

// Boxed tool renderer dispatcher.
//
// Maps Pi tool names to their boxed call/result renderers and falls back to a
// boxed generic renderer for unknown tools. The dispatcher is invoked from the
// tool decoration owner when tools.style === "compact-box".
function quickEditToolFor(toolName: string): BoxedToolDefinition {
    const config = getQuickEditToolConfig(toolName);
    if (!config) throw new Error(`missing quick-edit config for ${toolName}`);
    return quickEditTool(config);
}
const REGISTRY: Readonly<Record<string, BoxedToolDefinition>> = {
    read: readTool,
    write: writeTool,
    edit: editTool,
    bash: bashTool,
    ls: lsTool,
    find: findTool,
    grep: grepTool,
    quick_edit: quickEditToolFor("quick_edit"),
    substitute_edit: quickEditToolFor("substitute_edit"),
    target_edit: quickEditToolFor("target_edit"),
};
/**
 * Turn-summary gate (ADR 0007): the member belongs to an ended turn, Pi's
 * global tool-output state is collapsed, the surface is enabled, and the block
 * itself is not an error (errors always stay visible). Mutating tools
 * (edit/write/…) are exempt unless `tools.collapseMutatingTools` is on — their
 * blocks are the record of what was done and stay visible by default.
 */
export function renderBoxedToolForCall(
    toolName: unknown,
    args: Record<string, unknown>,
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    if (!isBatchableTool(toolName)) closeActiveBatch();
    const tool = typeof toolName === "string" ? REGISTRY[toolName] : undefined;
    if (tool) return tool.call(args, theme, context);
    return renderFallbackCall(toolName, args, theme, context);
}

export function renderBoxedToolForResult(
    toolName: unknown,
    result: { content?: readonly unknown[]; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: BoxTheme,
    context: BoxedToolContext,
): Component {
    const tool = typeof toolName === "string" ? REGISTRY[toolName] : undefined;
    if (tool) return tool.result(result, options, theme, context);
    return renderFallbackResult(toolName, result, options, theme, context);
}
