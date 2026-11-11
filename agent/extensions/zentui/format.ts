import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    resolveOsIcon,
    renderStyleForSource,
    componentColor,
    editorShellColor,
    OPENCODE_FORMAT_VARIABLES,
    renderCustomValue,
    normalizeTemplateVariables,
    isHostTemplateVariable,
    liveMetadataColor,
    EDITOR_ACCENT_FALLBACK,
    renderStyleForSourceOrFallback,
    safeThemeFg,
    type CompactFooterMaxLines,
    type ColorSource,
    type ColorSpec,
    type ContextStyle,
    type ContextThresholds,
    type GitBranchMaxLength,
    type PathDisplayMode,
    type IconMode,
    type ZentuiConfig,
    type HostTemplateValues,
} from "./config.ts";
import { homedir, hostname, userInfo } from "node:os";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../shared/strip-ansi.ts";

const execFileAsync = promisify(execFile);

const GIT_COMMAND_TIMEOUT_MS = 2_000;

// Background probes must not take .git/index.lock: a probe killed mid-refresh leaves a stale lock that blocks commits.
const GIT_PROBE_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

export type GitOperationState =
    | "REBASING"
    | "MERGING"
    | "CHERRY-PICKING"
    | "REVERTING"
    | "BISECTING";

/**
 * Starship `git_commit`-style info derived from the existing porcelain probe.
 *
 * `oid` is the full `branch.oid` from `git status --porcelain=2 --branch`
 * (free — no extra git call). `detached` mirrors `branch.head === "(detached)"`.
 * `tag` is populated only when the caller opts into the exact-tag probe
 * (`readGitStatus({ readExactTag: true })`); `null` means no exact-match tag
 * or the probe was skipped.
 */
export type GitCommitInfo = {
    oid: string | null;
    detached: boolean;
    tag: string | null;
};

/**
 * Starship `git_metrics`-style aggregate line-change counts.
 * See https://starship.rs/config/#git-metrics
 */
export type GitMetricsInfo = {
    added: number;
    deleted: number;
};

export type GitStatusSummary = {
    branch?: string;
    dirty: boolean;
    ahead: number;
    behind: number;
    conflicted: number;
    untracked: number;
    stashed: number;
    modified: number;
    staged: number;
    renamed: number;
    deleted: number;
    typechanged: number;
    gitState?: GitOperationState;
    gitStateLabel?: string;
    commit?: GitCommitInfo;
    metrics?: GitMetricsInfo | null;
};

export type GitReadResult =
    | { kind: "ok"; status: GitStatusSummary }
    | { kind: "not_a_repo" }
    | { kind: "error" };

export type GitStatePaths = {
    rebaseMerge?: string;
    rebaseApply?: string;
    mergeHead?: string;
    cherryPickHead?: string;
    revertHead?: string;
    bisectLog?: string;
    rebaseMsgnum?: string;
    rebaseEnd?: string;
};

export function emptyGitStatus(): GitStatusSummary {
    return {
        branch: undefined,
        dirty: false,
        ahead: 0,
        behind: 0,
        conflicted: 0,
        untracked: 0,
        stashed: 0,
        modified: 0,
        staged: 0,
        renamed: 0,
        deleted: 0,
        typechanged: 0,
        gitState: undefined,
        gitStateLabel: undefined,
        commit: undefined,
        metrics: undefined,
    };
}

export function parseGitStatusPorcelain(stdoutText: string, stashCount: number): GitStatusSummary {
    const status = emptyGitStatus();
    status.stashed = stashCount;

    let oid: string | null = null;
    let sawBranchHead = false;
    let detached = false;

    for (const line of stdoutText.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("# branch.oid ")) {
            const value = line.slice("# branch.oid ".length).trim();
            if (value && value !== "(initial)") oid = value;
            continue;
        }
        if (line.startsWith("# branch.head ")) {
            sawBranchHead = true;
            const branch = line.slice("# branch.head ".length).trim();
            if (branch === "(detached)") {
                detached = true;
                status.branch = undefined;
            } else if (branch) {
                status.branch = branch;
            }
            continue;
        }
        if (line.startsWith("# branch.ab ")) {
            const match = line.match(/\+(\d+)\s+-(\d+)/);
            if (match) {
                status.ahead = Number(match[1] ?? 0);
                status.behind = Number(match[2] ?? 0);
            }
            continue;
        }
        if (line.startsWith("#")) continue;

        status.dirty = true;

        if (line.startsWith("? ")) {
            status.untracked += 1;
            continue;
        }
        if (line.startsWith("u ")) {
            status.conflicted += 1;
            continue;
        }
        if (!(line.startsWith("1 ") || line.startsWith("2 "))) continue;

        const xy = line.split(" ")[1] ?? "..";
        const x = xy[0] ?? ".";
        const y = xy[1] ?? ".";

        if (x === "R") status.renamed += 1;
        else if (x === "D") status.deleted += 1;
        else if (x === "T") status.typechanged += 1;
        else if (x !== "." && x !== " ") status.staged += 1;

        if (y === "M") status.modified += 1;
        else if (y === "D") status.deleted += 1;
        else if (y === "T") status.typechanged += 1;
    }

    // Only populate commit info when we actually saw branch headers (inside
    // a repo with commits). An unborn branch has no oid.
    if (sawBranchHead) {
        status.commit = { oid, detached, tag: null };
    }

    return status;
}

/**
 * Parse `git diff --numstat` output into aggregate added/deleted counts.
 *
 * Each line is `added\tdeleted\tpath` (or `added\tdeleted\told\tnew` for
 * renames). Binary rows carry `-` in both numeric columns and are skipped.
 * Malformed/unparseable lines are ignored rather than aborting the sum.
 *
 * See https://git-scm.com/docs/git-diff#Documentation/git-diff.txt---numstat
 */
export function parseGitNumstat(stdoutText: string): GitMetricsInfo {
    let added = 0;
    let deleted = 0;
    for (const line of stdoutText.split(/\r?\n/)) {
        if (!line) continue;
        const parts = line.split("\t");
        // `added\tdeleted\tpath...` — need at least 3 tab-delimited fields.
        if (parts.length < 3) continue;
        const a = parts[0];
        const d = parts[1];
        // Binary files report `-` for both; skip.
        if (a === "-" || d === "-") continue;
        const na = Number(a);
        const nd = Number(d);
        if (!Number.isFinite(na) || !Number.isFinite(nd)) continue;
        if (na < 0 || nd < 0) continue;
        added += na;
        deleted += nd;
    }
    return { added, deleted };
}

function readOptionalText(path: string | undefined): string | undefined {
    if (!path || !existsSync(path)) return undefined;
    try {
        return readFileSync(path, "utf8").trim();
    } catch {
        return undefined;
    }
}

/**
 * Pure git operation-state detector. Paths that exist (truthy strings that
 * callers verified with `existsSync`) select the active state in Starship order.
 */
export function detectGitState(paths: GitStatePaths): {
    gitState?: GitOperationState;
    gitStateLabel?: string;
} {
    if (paths.rebaseMerge || paths.rebaseApply) {
        const msgnum = readOptionalText(paths.rebaseMsgnum);
        const end = readOptionalText(paths.rebaseEnd);
        if (msgnum && end) {
            return { gitState: "REBASING", gitStateLabel: `REBASING ${msgnum}/${end}` };
        }
        return { gitState: "REBASING", gitStateLabel: "REBASING" };
    }
    if (paths.mergeHead) return { gitState: "MERGING", gitStateLabel: "MERGING" };
    if (paths.cherryPickHead) {
        return { gitState: "CHERRY-PICKING", gitStateLabel: "CHERRY-PICKING" };
    }
    if (paths.revertHead) return { gitState: "REVERTING", gitStateLabel: "REVERTING" };
    if (paths.bisectLog) return { gitState: "BISECTING", gitStateLabel: "BISECTING" };
    return {};
}

const GIT_OPERATION_PATHS = [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
] as const;

async function readGitOperationState(cwd: string): Promise<{
    gitState?: GitOperationState;
    gitStateLabel?: string;
}> {
    let paths: string[];
    try {
        const { stdout } = await execFileAsync(
            "git",
            [
                "rev-parse",
                "--path-format=absolute",
                ...GIT_OPERATION_PATHS.flatMap((path) => ["--git-path", path]),
            ],
            { cwd, timeout: GIT_COMMAND_TIMEOUT_MS },
        );
        // rev-parse is line-delimited, not NUL-delimited. Reject ambiguous paths
        // (including embedded newlines) rather than assigning another operation's path.
        paths = String(stdout)
            .replace(/\r?\n$/, "")
            .split(/\r?\n/);
        if (
            paths.length !== GIT_OPERATION_PATHS.length ||
            paths.some((path) => !isAbsolute(path) || /[\r\n\0]/.test(path))
        )
            return {};
    } catch {
        return {};
    }
    const [rebaseMerge, rebaseApply, mergeHead, cherryPickHead, revertHead, bisectLog] = paths;

    const existing = (path: string | undefined) => (path && existsSync(path) ? path : undefined);
    const rebaseDir = existing(rebaseMerge) ?? existing(rebaseApply);

    return detectGitState({
        rebaseMerge: existing(rebaseMerge),
        rebaseApply: existing(rebaseApply),
        mergeHead: existing(mergeHead),
        cherryPickHead: existing(cherryPickHead),
        revertHead: existing(revertHead),
        bisectLog: existing(bisectLog),
        rebaseMsgnum: rebaseDir ? join(rebaseDir, "msgnum") : undefined,
        rebaseEnd: rebaseDir ? join(rebaseDir, "end") : undefined,
    });
}

function isNotARepoError(error: unknown): boolean {
    const message =
        error instanceof Error
            ? `${error.message}\n${"stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : ""}`
            : String(error);
    return /not a git repository|outside repository|not a git repo/i.test(message);
}

/**
 * Options for the optional probes that piggyback on the existing git refresh.
 * Tag/metrics default to false; stash/operation state retain the full-status
 * default for standalone callers. UI consumers may omit probes they do not display.
 */
export type ReadGitStatusOptions = {
    /** Read stash counts (default true). */
    readStash?: boolean;
    /** Resolve and inspect operation paths (default true). */
    readOperationState?: boolean;
    /** Run `git describe --tags --exact-match HEAD` for the git_commit segment. */
    readExactTag?: boolean;
    /**
     * Run `git diff HEAD --numstat` for the git_metrics segment. Uses the
     * Starship-like “total dirty” view (staged + unstaged combined).
     */
    readMetrics?: boolean;
    /** Add `--ignore-submodules=all` to the metrics diff when requested. */
    ignoreSubmodules?: boolean;
};

export async function readGitStatus(
    cwd: string,
    options: ReadGitStatusOptions = {},
): Promise<GitReadResult> {
    const readExactTag = options.readExactTag === true;
    const readMetrics = options.readMetrics === true;
    try {
        // diff's index refresh does not always honor GIT_OPTIONAL_LOCKS.
        const numstatArgs = ["-c", "diff.autoRefreshIndex=false", "diff", "HEAD", "--numstat"];
        if (options.ignoreSubmodules) numstatArgs.push("--ignore-submodules=all");
        const [{ stdout: statusStdout }, stashResult, tagResult, metricsResult] = await Promise.all(
            [
                execFileAsync("git", ["status", "--porcelain=2", "--branch"], {
                    cwd,
                    timeout: GIT_COMMAND_TIMEOUT_MS,
                    env: GIT_PROBE_ENV,
                }),
                options.readStash !== false
                    ? execFileAsync("git", ["stash", "list"], {
                          cwd,
                          timeout: GIT_COMMAND_TIMEOUT_MS,
                      }).catch(() => ({ stdout: "" }))
                    : Promise.resolve({ stdout: "" }),
                readExactTag
                    ? execFileAsync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
                          cwd,
                          timeout: GIT_COMMAND_TIMEOUT_MS,
                      }).then(
                          (r) => ({
                              stdout: typeof r.stdout === "string" ? r.stdout : String(r.stdout),
                          }),
                          () => ({ stdout: "" }),
                      )
                    : Promise.resolve({ stdout: "" }),
                readMetrics
                    ? execFileAsync("git", numstatArgs, {
                          cwd,
                          timeout: GIT_COMMAND_TIMEOUT_MS,
                          env: GIT_PROBE_ENV,
                      }).then(
                          (r) => ({
                              stdout: typeof r.stdout === "string" ? r.stdout : String(r.stdout),
                          }),
                          () => ({ stdout: "", failed: true as const }),
                      )
                    : Promise.resolve({ stdout: "", failed: true as const }),
            ],
        );
        const stdoutText = typeof statusStdout === "string" ? statusStdout : String(statusStdout);
        const stashStdout =
            typeof stashResult.stdout === "string"
                ? stashResult.stdout
                : String(stashResult.stdout);
        const stashCount = stashStdout
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0).length;
        const status = parseGitStatusPorcelain(stdoutText, stashCount);
        if (status.commit) {
            const tagStdout =
                typeof tagResult.stdout === "string" ? tagResult.stdout : String(tagResult.stdout);
            const tag = tagStdout.trim();
            status.commit = { ...status.commit, tag: tag || null };
        }
        if (readMetrics) {
            if ("failed" in metricsResult && metricsResult.failed) {
                status.metrics = null;
            } else {
                const metricsStdout =
                    typeof metricsResult.stdout === "string"
                        ? metricsResult.stdout
                        : String(metricsResult.stdout);
                status.metrics = parseGitNumstat(metricsStdout);
            }
        }
        const operation =
            options.readOperationState !== false ? await readGitOperationState(cwd) : {};
        return {
            kind: "ok",
            status: {
                ...status,
                ...operation,
            },
        };
    } catch (error) {
        if (isNotARepoError(error)) return { kind: "not_a_repo" };

        // Distinguish not-a-repo vs transient with a cheap rev-parse on the error path.
        try {
            const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
                cwd,
                timeout: GIT_COMMAND_TIMEOUT_MS,
            });
            const inside = (typeof stdout === "string" ? stdout : String(stdout)).trim();
            if (inside !== "true") return { kind: "not_a_repo" };
            return { kind: "error" };
        } catch (inner) {
            if (isNotARepoError(inner)) return { kind: "not_a_repo" };
            return { kind: "error" };
        }
    }
}

export type FormatToken =
    | { kind: "text"; value: string }
    | { kind: "var"; name: string }
    | { kind: "fill" }
    | { kind: "group"; tokens: FormatToken[] };

export type CompactBoundaryKind = "space" | "separator";

export type CompactFormatChunk =
    | { kind: "tokens"; tokens: FormatToken[]; boundary: CompactBoundaryKind }
    | { kind: "extensions"; boundary: CompactBoundaryKind };

/** Cached syntax is deeply readonly; public parser/compiler results remain mutable. */
export type ReadonlyFormatToken =
    | Readonly<Exclude<FormatToken, { kind: "group" }>>
    | { readonly kind: "group"; readonly tokens: readonly ReadonlyFormatToken[] };

type ReadonlyCompactChunk =
    | {
          readonly kind: "tokens";
          readonly tokens: readonly ReadonlyFormatToken[];
          readonly boundary: CompactBoundaryKind;
      }
    | { readonly kind: "extensions"; readonly boundary: CompactBoundaryKind };

export type CompiledCompactChunk = ReadonlyCompactChunk & {
    readonly references: readonly string[];
};

export type CompiledFooterFormat = {
    readonly tokens: readonly ReadonlyFormatToken[];
    readonly references: readonly string[];
    readonly compact: {
        readonly left: readonly CompiledCompactChunk[];
        readonly right: readonly CompiledCompactChunk[];
        readonly alignRight: boolean;
    };
};

type SyntaxEntry = {
    tokens: readonly ReadonlyFormatToken[];
    compact: {
        left: readonly ReadonlyCompactChunk[];
        right: readonly ReadonlyCompactChunk[];
        alignRight: boolean;
    };
    names: readonly string[];
    canonicalNames?: readonly string[];
    compiled?: CompiledFooterFormat;
};

// Format text only: no session, config object, rendered output, or theme is retained.
const syntaxCache = new Map<string, SyntaxEntry>();

const SYNTAX_CACHE_LIMIT = 32;

function freezeTokens(tokens: FormatToken[]): readonly ReadonlyFormatToken[] {
    for (const token of tokens) {
        if (token.kind === "group") freezeTokens(token.tokens);
        Object.freeze(token);
    }
    return Object.freeze(tokens);
}

function canonicalVariableName(name: string, aliases: Readonly<Record<string, string>>): string {
    const alias = aliases[name];
    // Inherited string aliases are supported, but Object.prototype methods are not aliases.
    return typeof alias === "string" ? alias : name;
}

/** Share bounded syntax/analysis across rendering and dependency-demand checks. */
export function compiledFooterFormat(
    format: string,
    aliases: Readonly<Record<string, string>> = {},
): CompiledFooterFormat {
    let entry = syntaxCache.get(format);
    if (!entry) {
        const tokens = parseFooterFormat(format);
        const compact = compileCompactFormatSplit(tokens);
        const names = new Set<string>();
        const visit = (items: FormatToken[]) => {
            for (const token of items) {
                if (token.kind === "group") visit(token.tokens);
                else if (token.kind === "var") names.add(token.name);
            }
        };
        visit(tokens);
        const freezeChunks = (chunks: CompactFormatChunk[]) =>
            Object.freeze(
                chunks.map((chunk) => {
                    if (chunk.kind === "tokens") freezeTokens(chunk.tokens);
                    return Object.freeze(chunk);
                }),
            );
        entry = {
            tokens: freezeTokens(tokens),
            compact: Object.freeze({
                left: freezeChunks(compact.left),
                right: freezeChunks(compact.right),
                alignRight: compact.alignRight,
            }),
            names: Object.freeze([...names]),
        };
        if (syntaxCache.size >= SYNTAX_CACHE_LIMIT) {
            const oldest = syntaxCache.keys().next().value;
            if (oldest !== undefined) syntaxCache.delete(oldest);
        }
    } else {
        syntaxCache.delete(format);
    }
    syntaxCache.set(format, entry);
    // Compare only names that occur in this syntax, including structural variables.
    // This observes in-place alias edits without retaining mutable caller objects.
    if (
        entry.compiled &&
        entry.names.every(
            (name, i) => canonicalVariableName(name, aliases) === entry.canonicalNames?.[i],
        )
    ) {
        return entry.compiled;
    }
    const references = (tokens: readonly ReadonlyFormatToken[]) =>
        Object.freeze([...collectFooterFormatReferences(tokens, aliases)]);
    const analyzeChunks = (chunks: readonly ReadonlyCompactChunk[]) =>
        Object.freeze(
            chunks.map((chunk) =>
                Object.freeze({
                    ...chunk,
                    references:
                        chunk.kind === "tokens"
                            ? references(chunk.tokens)
                            : Object.freeze([] as string[]),
                }),
            ),
        );
    entry.canonicalNames = Object.freeze(
        entry.names.map((name) => canonicalVariableName(name, aliases)),
    );
    entry.compiled = Object.freeze({
        tokens: entry.tokens,
        references: references(entry.tokens),
        compact: Object.freeze({
            left: analyzeChunks(entry.compact.left),
            right: analyzeChunks(entry.compact.right),
            alignRight: entry.compact.alignRight,
        }),
    });
    return entry.compiled;
}

const TOKEN_REGEX = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Tokenize a format string into text/var/fill/group tokens.
 *
 * `$name` and `${name}` both produce a variable token. A variable named
 * `fill` becomes a fill token instead. Parentheses form conditional groups
 * that drop entirely when all nested vars are empty.
 */
export function parseFooterFormat(format: string): FormatToken[] {
    if (!format) return [];
    return parseTokenSlice(format, 0, format.length, true).tokens;
}

function parseTokenSlice(
    format: string,
    start: number,
    end: number,
    topLevel = false,
): { tokens: FormatToken[]; nextIndex: number } {
    const tokens: FormatToken[] = [];
    let index = start;
    let textStart = start;

    const flushText = (until: number) => {
        if (until > textStart) {
            tokens.push({ kind: "text", value: format.slice(textStart, until) });
        }
    };

    while (index < end) {
        const ch = format[index];

        if (ch === "(") {
            flushText(index);
            const nested = parseTokenSlice(format, index + 1, end, false);
            tokens.push({ kind: "group", tokens: nested.tokens });
            index = nested.nextIndex;
            textStart = index;
            continue;
        }

        if (ch === ")") {
            // Nested groups close on `)`. Unmatched top-level `)` is literal text so
            // trailing tokens like `$cwd) $tokens` are not discarded.
            if (topLevel) {
                index += 1;
                continue;
            }
            flushText(index);
            return { tokens, nextIndex: index + 1 };
        }

        if (ch === "$") {
            TOKEN_REGEX.lastIndex = index;
            const match = TOKEN_REGEX.exec(format);
            if (match && match.index === index && match.index < end) {
                const full = match[0];
                const matchEnd = match.index + full.length;
                if (matchEnd > end) {
                    index += 1;
                    continue;
                }
                flushText(index);
                const name = match[1] ?? match[2] ?? "";
                if (name === "fill") {
                    tokens.push({ kind: "fill" });
                } else {
                    tokens.push({ kind: "var", name });
                }
                index = matchEnd;
                textStart = index;
                continue;
            }
        }

        index += 1;
    }

    flushText(end);
    return { tokens, nextIndex: end };
}

/**
 * Render tokens into `{ left, middle, right }` based on `$fill` markers.
 *
 * - No fill: everything → `left`; `middle` and `right` are `""`.
 * - One fill: tokens before → `left`, tokens after → `right`; `middle` is `""`.
 * - Two fills: before the first → `left`, between the two → `middle`
 *   (centered by the caller via the existing middle-zone logic), after the
 *   second → `right`.
 * - Additional fills beyond the first two are ignored.
 * - `$fill` inside a group is ignored (renders empty).
 *
 * Text tokens contribute their `value` verbatim (unstyled/plain); var tokens
 * contribute `renderVariable(name)` (already styled by caller). No automatic
 * spaces are inserted except the styled separator between `$join_sep` fields.
 */
export function renderFormatSplit(
    tokens: readonly ReadonlyFormatToken[],
    renderVariable: (name: string) => string,
): { left: string; middle: string; right: string } {
    const fillIndices = findTopLevelFillIndices(tokens);

    if (fillIndices.length === 0) {
        return {
            left: renderTokenSlice(tokens, 0, tokens.length, renderVariable),
            middle: "",
            right: "",
        };
    }

    const first = fillIndices[0];
    const second = fillIndices[1];

    if (first === undefined) {
        return {
            left: renderTokenSlice(tokens, 0, tokens.length, renderVariable),
            middle: "",
            right: "",
        };
    }

    if (second === undefined) {
        return {
            left: renderTokenSlice(tokens, 0, first, renderVariable),
            middle: "",
            right: renderTokenSlice(tokens, first + 1, tokens.length, renderVariable),
        };
    }

    return {
        left: renderTokenSlice(tokens, 0, first, renderVariable),
        middle: renderTokenSlice(tokens, first + 1, second, renderVariable),
        right: renderTokenSlice(tokens, second + 1, tokens.length, renderVariable),
    };
}

/** Compact uses only the first top-level fill; later fills remain nonstructural. */
export function compileCompactFormatSplit(tokens: FormatToken[]): {
    left: CompactFormatChunk[];
    right: CompactFormatChunk[];
    alignRight: boolean;
} {
    const first = tokens.findIndex((token) => token.kind === "fill");
    return first < 0
        ? { left: compileCompactFormat(tokens), right: [], alignRight: false }
        : {
              left: compileCompactFormat(tokens.slice(0, first)),
              right: compileCompactFormat(tokens.slice(first + 1)),
              alignRight: true,
          };
}

export function compileCompactFormat(tokens: FormatToken[]): CompactFormatChunk[] {
    const chunks: CompactFormatChunk[] = [];
    let current: FormatToken[] = [];
    let incomingBoundary: CompactBoundaryKind = "space";

    const flush = () => {
        const normalized = trimBoundaryWhitespace(current);
        current = [];
        if (normalized.length === 0) return;
        if (
            normalized.length === 1 &&
            normalized[0]?.kind === "var" &&
            normalized[0].name === "extensions"
        ) {
            chunks.push({ kind: "extensions", boundary: incomingBoundary });
            return;
        }
        chunks.push({ kind: "tokens", tokens: normalized, boundary: incomingBoundary });
    };

    for (const token of tokens) {
        if (token.kind === "var" && (token.name === "wrap" || token.name === "wrap_sep")) {
            flush();
            incomingBoundary = token.name === "wrap_sep" ? "separator" : "space";
            continue;
        }
        if (token.kind === "fill") continue;
        current.push(token);
    }
    flush();
    return chunks;
}

function trimBoundaryWhitespace(tokens: FormatToken[]): FormatToken[] {
    const result = tokens.map((token) => (token.kind === "text" ? { ...token } : token));
    while (result[0]?.kind === "text") {
        result[0].value = result[0].value.replace(/^\s+/, "");
        if (result[0].value) break;
        result.shift();
    }
    while (result.at(-1)?.kind === "text") {
        const last = result.at(-1);
        if (last?.kind !== "text") break;
        last.value = last.value.replace(/\s+$/, "");
        if (last.value) break;
        result.pop();
    }
    return result;
}

export function renderFormatTokens(
    tokens: readonly ReadonlyFormatToken[],
    renderVariable: (name: string) => string,
): string {
    return renderTokenSlice(tokens, 0, tokens.length, renderVariable);
}

export function collectFooterFormatReferences(
    tokens: readonly ReadonlyFormatToken[],
    aliases: Record<string, string> = {},
): Set<string> {
    const references = new Set<string>();
    const visit = (items: readonly ReadonlyFormatToken[]) => {
        for (const token of items) {
            if (token.kind === "group") {
                visit(token.tokens);
                continue;
            }
            if (token.kind !== "var" || token.name === "join_sep") continue;
            const canonical = canonicalVariableName(token.name, aliases);
            if (canonical !== "wrap" && canonical !== "wrap_sep" && canonical !== "extensions") {
                references.add(canonical);
            }
        }
    };
    visit(tokens);
    return references;
}

function findTopLevelFillIndices(tokens: readonly ReadonlyFormatToken[]): number[] {
    const fillIndices: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index]?.kind === "fill") fillIndices.push(index);
    }
    return fillIndices;
}

/** Join sibling fields only when a marker occurs; legacy output stays verbatim.
 * VT controls are ignored for detection, never removed from retained output.
 */
export function renderJoinedTokenFields(
    tokens: readonly ReadonlyFormatToken[],
    renderField: (field: readonly ReadonlyFormatToken[]) => string,
    renderSeparator: () => string,
): string {
    if (!tokens.some((token) => token.kind === "var" && token.name === "join_sep"))
        return renderField(tokens);
    const fields: string[] = [];
    let start = 0;
    for (let index = 0; index <= tokens.length; index++) {
        const token = tokens[index];
        if (index !== tokens.length && !(token?.kind === "var" && token.name === "join_sep"))
            continue;
        const rendered = renderField(tokens.slice(start, index));
        if (stripVTControlCharacters(rendered).trim()) fields.push(rendered);
        start = index + 1;
    }
    return fields.join(fields.length > 1 ? renderSeparator() : "");
}

function renderTokenSlice(
    tokens: readonly ReadonlyFormatToken[],
    start: number,
    end: number,
    renderVariable: (name: string) => string,
): string {
    return renderJoinedTokenFields(
        tokens.slice(start, end),
        (field) => field.map((token) => renderToken(token, renderVariable)).join(""),
        () => renderVariable("sep"),
    );
}

function renderToken(token: ReadonlyFormatToken, renderVariable: (name: string) => string): string {
    if (token.kind === "text") return token.value;
    if (token.kind === "var") return renderVariable(token.name);
    if (token.kind === "fill") return "";
    // group
    const rendered = renderTokenSlice(token.tokens, 0, token.tokens.length, renderVariable);
    if (isGroupEmpty(token, renderVariable)) return "";
    return rendered;
}

/**
 * Separator vars only style gaps between content; they must not keep a group
 * alive when every real content var is empty (e.g. `($sep$tokens)` drops if
 * tokens is empty).
 */
const NON_CONTENT_VARS = new Set(["sep", "separator", "join_sep"]);

/**
 * A group is empty iff every content var leaf is empty and every nested group
 * is empty. Text-only groups (no vars) always show. `$sep` / `$separator` and
 * `$join_sep` are not content; an empty joined scope is also empty to its parent.
 */
function isGroupEmpty(
    group: ReadonlyFormatToken & { kind: "group" },
    renderVariable: (name: string) => string,
): boolean {
    if (
        group.tokens.some((token) => token.kind === "var" && token.name === "join_sep") &&
        !stripVTControlCharacters(
            renderTokenSlice(group.tokens, 0, group.tokens.length, renderVariable),
        ).trim()
    )
        return true;
    let sawContentVarOrGroup = false;
    for (const child of group.tokens) {
        if (child.kind === "var") {
            if (NON_CONTENT_VARS.has(child.name)) continue;
            sawContentVarOrGroup = true;
            if (renderVariable(child.name) !== "") return false;
        } else if (child.kind === "group") {
            sawContentVarOrGroup = true;
            if (!isGroupEmpty(child, renderVariable)) return false;
        }
    }
    // Text-only groups (or groups with only $sep) are shown only when no content vars.
    // Groups that only contain $sep still count as empty so they drop.
    return sawContentVarOrGroup || groupOnlyNonContentVars(group);
}

function groupOnlyNonContentVars(group: ReadonlyFormatToken & { kind: "group" }): boolean {
    let sawSep = false;
    for (const child of group.tokens) {
        if (child.kind === "text") {
            if (child.value.trim() !== "") return false;
            continue;
        }
        if (child.kind === "var") {
            if (!NON_CONTENT_VARS.has(child.name)) return false;
            sawSep = true;
            continue;
        }
        if (child.kind === "group") return false;
        if (child.kind === "fill") continue;
    }
    return sawSep;
}

/** One optional SGR sequence (`\x1b[…m`). */
const ANSI_ONE_SRC = "\u001b\\[[0-9;]*m";

/**
 * One ` | ` separator unit, plain or with a single ANSI wrapper on either side
 * of the spaces/pipe (matches `renderStyle(..., " | ")` output).
 */
const SEP_UNIT_SRC = `(?:${ANSI_ONE_SRC})?\\s+\\|\\s+(?:${ANSI_ONE_SRC})?`;

/**
 * Join non-empty parts with a separator (segment-mode style).
 * Useful when building right-side metrics without orphan pipes.
 */
export function joinNonEmpty(parts: string[], separator: string): string {
    return parts.filter(Boolean).join(separator);
}

/**
 * Tidy a rendered format left/middle/right slice:
 * - collapse repeated pipe separators (plain or simple ANSI-wrapped) into one
 * - strip leading/trailing pipe separators
 * - strip leading/trailing whitespace
 * - drop slices that are only ANSI / whitespace after cleanup
 */
export function stripOrphanSeparators(rendered: string): string {
    if (!rendered) return rendered;

    // Collapse consecutive separator units, keeping the first (preserves themed color).
    const consecutive = new RegExp(`(${SEP_UNIT_SRC})(?:${SEP_UNIT_SRC})+`, "g");
    let result = rendered.replace(consecutive, "$1");

    // Strip leading / trailing separator units.
    result = result.replace(new RegExp(`^(?:${SEP_UNIT_SRC})+`), "");
    result = result.replace(new RegExp(`(?:${SEP_UNIT_SRC})+$`), "");

    // Strip leading / trailing plain whitespace left by empty groups.
    result = result.replace(/^\s+/, "").replace(/\s+$/, "");

    // Pure ANSI (or empty) leftovers are not useful content.
    if (result.replace(new RegExp(ANSI_ONE_SRC, "g"), "").trim() === "") return "";

    return result;
}

/** Close retained links before joining/padding footer fragments, even when truncation drops the final closure. */
export function truncateFooterText(text: string, width: number, ellipsis: string): string {
    const truncated = truncateToWidth(text, width, ellipsis);
    let activeLink = false;
    for (const match of truncated.matchAll(
        /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g,
    )) {
        activeLink = Boolean(match[1]);
    }
    return truncated + (activeLink ? "\x1b]8;;\x07" : "");
}

export type FooterZones = {
    left: string;
    middle: string;
    right: string;
};

export function fullFooterFitsAligned(zones: FooterZones, innerWidth: number): boolean {
    const leftWidth = visibleWidth(zones.left);
    const middleWidth = visibleWidth(zones.middle);
    const rightWidth = visibleWidth(zones.right);
    if (middleWidth === 0) {
        return leftWidth + rightWidth + (leftWidth > 0 && rightWidth > 0 ? 1 : 0) <= innerWidth;
    }

    const gapWidth = innerWidth - leftWidth - rightWidth;
    if (gapWidth < middleWidth) return false;
    const leftPadding = Math.floor((gapWidth - middleWidth) / 2);
    const rightPadding = gapWidth - middleWidth - leftPadding;
    return (leftWidth === 0 || leftPadding >= 1) && (rightWidth === 0 || rightPadding >= 1);
}

function joinZones(parts: string[]): string {
    return parts.filter(Boolean).join(" ");
}

function validRows(rows: string[], innerWidth: number): string[] | undefined {
    const nonEmpty = rows.filter(Boolean);
    if (nonEmpty.length === 0 || nonEmpty.length > 2) return undefined;
    return nonEmpty.every((row) => visibleWidth(row) <= innerWidth) ? nonEmpty : undefined;
}

/** Prefer project identity alone, with middle/right status on the second row. */
export function reflowFullFooter(
    zones: FooterZones,
    innerWidth: number,
    alignRight = false,
): string[] | undefined {
    const align = (row: string) =>
        alignRight && zones.right && visibleWidth(row) <= innerWidth
            ? " ".repeat(innerWidth - visibleWidth(row)) + row
            : row;
    const preferred = validRows(
        [zones.left, align(joinZones([zones.middle, zones.right]))],
        innerWidth,
    );
    if (preferred) return preferred;
    return validRows([joinZones([zones.left, zones.middle]), align(zones.right)], innerWidth);
}

export function compactChunkBudget(innerWidth: number): number {
    return Math.max(8, Math.floor((innerWidth - 1) / 2));
}

export type CompactLayoutChunk = {
    text: string;
    boundary: CompactBoundaryKind;
};

type PackedRow = {
    text: string;
    endsWithRendererEllipsis: boolean;
};

function fitChunk(chunk: string, innerWidth: number): PackedRow {
    if (visibleWidth(chunk) <= innerWidth) {
        return { text: chunk, endsWithRendererEllipsis: false };
    }
    return {
        text: truncateFooterText(chunk, innerWidth, "…"),
        endsWithRendererEllipsis: true,
    };
}

function appendOmissionMarker(row: PackedRow, innerWidth: number): PackedRow {
    if (row.endsWithRendererEllipsis) return row;
    if (innerWidth <= 1) return { text: "…", endsWithRendererEllipsis: true };
    return {
        text: `${truncateFooterText(row.text, innerWidth - 1, "")}…`,
        endsWithRendererEllipsis: true,
    };
}

export function packCompactChunks(
    chunks: CompactLayoutChunk[],
    innerWidth: number,
    maxLines: CompactFooterMaxLines,
    separator: string,
): string[] {
    if (innerWidth <= 0) return [""];
    const content = chunks
        .map((chunk) => ({ ...chunk, text: chunk.text.trim() }))
        .filter((chunk) => chunk.text.length > 0);
    if (content.length === 0) return [""];

    const finiteLimit = maxLines === "unlimited" ? Number.POSITIVE_INFINITY : maxLines;
    const rows: PackedRow[] = [];
    let current: PackedRow | undefined;
    let omitted = false;

    for (const chunk of content) {
        const fitted = fitChunk(chunk.text, innerWidth);
        if (!current) {
            current = fitted;
            continue;
        }

        const join = chunk.boundary === "separator" ? separator : " ";
        const candidate = `${current.text}${join}${fitted.text}`;
        if (visibleWidth(candidate) <= innerWidth) {
            current = {
                text: candidate,
                endsWithRendererEllipsis: fitted.endsWithRendererEllipsis,
            };
            continue;
        }

        if (rows.length + 1 < finiteLimit) {
            rows.push(current);
            current = fitted;
            continue;
        }

        omitted = true;
        break;
    }

    if (current) rows.push(omitted ? appendOmissionMarker(current, innerWidth) : current);
    return rows.map((row) => truncateFooterText(row.text, innerWidth, ""));
}

/** Reserve right chunks in template order, then use each row's remaining left budget. */
export function packCompactZones(
    left: CompactLayoutChunk[],
    right: CompactLayoutChunk[],
    innerWidth: number,
    maxLines: CompactFooterMaxLines,
    separator: string,
): string[] {
    if (innerWidth <= 0) return [""];
    const rightRows = packCompactChunks(right, innerWidth, maxLines, separator);
    if (!rightRows.some(Boolean)) return packCompactChunks(left, innerWidth, maxLines, separator);
    const content = left
        .map((chunk) => ({ ...chunk, text: chunk.text.trim() }))
        .filter((chunk) => chunk.text);
    const leftRows: PackedRow[] = [];
    const budgets: number[] = [];
    const limit = maxLines === "unlimited" ? rightRows.length + content.length : maxLines;
    let next = 0;
    for (let row = 0; row < limit && (next < content.length || row < rightRows.length); row++) {
        const rightText = rightRows[row] ?? "";
        const budget = Math.max(0, innerWidth - visibleWidth(rightText) - (rightText ? 1 : 0));
        budgets.push(budget);
        let current: PackedRow = { text: "", endsWithRendererEllipsis: false };
        while (budget > 0 && next < content.length) {
            const chunk = content[next];
            if (!chunk) break;
            const join = current.text ? (chunk.boundary === "separator" ? separator : " ") : "";
            if (current.text && visibleWidth(current.text + join + chunk.text) > budget) break;
            const fitted = fitChunk(chunk.text, budget);
            current = {
                text: current.text + join + truncateFooterText(fitted.text, budget, ""),
                endsWithRendererEllipsis:
                    fitted.endsWithRendererEllipsis ||
                    stripVTControlCharacters(fitted.text).endsWith("…"),
            };
            next++;
        }
        leftRows.push(current);
    }
    if (next < content.length) {
        const last = leftRows.findLastIndex((row) => Boolean(row.text));
        const lastRow = leftRows[last];
        const lastBudget = budgets[last];
        if (lastRow && lastBudget !== undefined) {
            leftRows[last] = appendOmissionMarker(lastRow, lastBudget);
        } else {
            const lastRight = rightRows.length - 1;
            const text = rightRows[lastRight] ?? "";
            rightRows[lastRight] = appendOmissionMarker(
                { text, endsWithRendererEllipsis: stripVTControlCharacters(text).endsWith("…") },
                innerWidth,
            ).text;
        }
    }
    return leftRows
        .map((row, index) => {
            const rightText = rightRows[index] ?? "";
            return rightText
                ? row.text +
                      " ".repeat(innerWidth - visibleWidth(row.text) - visibleWidth(rightText)) +
                      rightText
                : row.text;
        })
        .filter(Boolean);
}

/**
 * Classify a prompt input as normal (`""`), a `!`-prefixed shell command
 * (`"shell"`), or the `!!` no-context variant. Mirrors Pi's `isBashMode` check.
 */
export function bashModeLabel(text: string): "" | "shell" | "no-context" {
    const trimmed = text.trimStart();
    return trimmed.startsWith("!!") ? "no-context" : trimmed.startsWith("!") ? "shell" : "";
}

/**
 * Starship `git_commit` style — render a short hash, optionally with an
 * exact-match tag. See https://starship.rs/config/#git-commit
 *
 * Visibility is decided by the caller; this helper only formats the data.
 * `hashLength` is clamped to [4, 40] upstream.
 */
export function formatGitCommitSegment(
    theme: Pick<Theme, "fg">,
    commit: GitCommitInfo | undefined,
    config: { hashLength: number; onlyDetached: boolean; showTag: boolean },
    colorSource: ColorSource,
    style: ColorSpec,
): string {
    if (!commit?.oid) return "";
    // Starship's only_detached hides the whole module when attached.
    if (config.onlyDetached && !commit.detached) return "";
    const hash = commit.oid.slice(0, config.hashLength);
    const tag = config.showTag && commit.tag ? commit.tag : "";
    if (!hash && !tag) return "";
    const label = [hash, tag].filter(Boolean).join(" ");
    return renderStyleForSource(theme, colorSource, style, label);
}

/**
 * Starship `git_metrics` style — render `+added −deleted` line counts.
 * See https://starship.rs/config/#git-metrics
 *
 * When `onlyNonzero` is true, each zero component is omitted independently
 * and the whole segment hides at 0/0.
 */
export function formatGitMetricsSegment(
    theme: Pick<Theme, "fg">,
    metrics: GitMetricsInfo | null | undefined,
    config: { onlyNonzero: boolean },
    colorSource: ColorSource,
    addedStyle: ColorSpec,
    deletedStyle: ColorSpec,
): string {
    if (!metrics) return "";
    const showAdded = !config.onlyNonzero || metrics.added > 0;
    const showDeleted = !config.onlyNonzero || metrics.deleted > 0;
    if (!showAdded && !showDeleted) return "";
    const parts: string[] = [];
    if (showAdded) {
        parts.push(renderStyleForSource(theme, colorSource, addedStyle, `+${metrics.added}`));
    }
    if (showDeleted) {
        parts.push(renderStyleForSource(theme, colorSource, deletedStyle, `−${metrics.deleted}`));
    }
    return parts.join(" ");
}

export type UsageTotals = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    latestCacheHitRate?: number;
    cost: number;
};

export type ContextColorTier = "normal" | "warning" | "error";

type SessionUsage = {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: unknown;
};

type SessionEntry = {
    type?: string;
    id?: string | number;
    timestamp?: string | number;
    usage?: SessionUsage;
    message?: {
        role?: string;
        usage?: SessionUsage;
    };
};

type SelectedUsage = {
    usage: SessionUsage | undefined;
    location: "message" | "entry";
    isAssistant: boolean;
};

type UsageCacheEntry = {
    key: string;
    totals: UsageTotals;
};

const MAX_USAGE_TOTAL = Number.MAX_VALUE;

let usageTotalsCache: UsageCacheEntry | undefined;

let usageTotalsAggregationPassCount = 0;

export function formatCount(value: number): string {
    if (value < 1000) return value.toString();
    if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
    if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
    if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    return `${Math.round(value / 1_000_000)}M`;
}

export function formatProviderLabel(provider: string | undefined): string {
    if (!provider) return "Unknown";

    const known: Record<string, string> = {
        anthropic: "Anthropic",
        gemini: "Google",
        google: "Google",
        ollama: "Ollama",
        openai: "OpenAI",
        "openai-codex": "OpenAI",
    };

    return (
        known[provider] ??
        provider.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
    );
}

function calculateCacheHitRate(
    input: number,
    cacheRead: number,
    cacheWrite: number,
): number | undefined {
    const promptTokens = input + cacheRead + cacheWrite;
    if (promptTokens === 0) return undefined;
    if (Number.isFinite(promptTokens)) return (cacheRead / promptTokens) * 100;

    const scale = Math.max(input, cacheRead, cacheWrite);
    const scaledPromptTokens = input / scale + cacheRead / scale + cacheWrite / scale;
    return (cacheRead / scale / scaledPromptTokens) * 100;
}

function normalizeUsageNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageCostTotal(usage: SessionUsage | undefined): number {
    if (typeof usage?.cost !== "object" || usage.cost === null) return 0;
    return normalizeUsageNumber((usage.cost as { total?: unknown }).total);
}

function addUsageTotal(total: number, value: number): number {
    const sum = total + value;
    return Number.isFinite(sum) ? sum : MAX_USAGE_TOTAL;
}

function usageForEntry(entry: SessionEntry): SelectedUsage | undefined {
    if (entry.type === "message") {
        const role = entry.message?.role;
        if (role !== "assistant" && role !== "toolResult") return undefined;
        return {
            usage: entry.message?.usage,
            location: "message",
            isAssistant: role === "assistant",
        };
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
        return { usage: entry.usage, location: "entry", isAssistant: false };
    }
    return undefined;
}

function normalizedUsage(usage: SessionUsage | undefined) {
    return {
        input: normalizeUsageNumber(usage?.input),
        output: normalizeUsageNumber(usage?.output),
        cacheRead: normalizeUsageNumber(usage?.cacheRead),
        cacheWrite: normalizeUsageNumber(usage?.cacheWrite),
        cost: usageCostTotal(usage),
    };
}

function entryIdentity(entry: SessionEntry): string {
    const selected = usageForEntry(entry);
    if (!selected) return "unsupported";
    const usage = normalizedUsage(selected.usage);
    return JSON.stringify([
        entry.id ?? null,
        entry.timestamp ?? null,
        entry.type ?? null,
        entry.message?.role ?? null,
        selected.location,
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.cost,
    ]);
}

function buildUsageFingerprint(entries: readonly SessionEntry[]): string {
    return entries.map(entryIdentity).join("\0");
}

function computeUsageTotals(entries: readonly SessionEntry[]): UsageTotals {
    usageTotalsAggregationPassCount += 1;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let latestCacheHitRate: number | undefined;
    let cost = 0;

    for (const entry of entries) {
        const selected = usageForEntry(entry);
        if (!selected) continue;
        const usage = normalizedUsage(selected.usage);

        input = addUsageTotal(input, usage.input);
        output = addUsageTotal(output, usage.output);
        cacheRead = addUsageTotal(cacheRead, usage.cacheRead);
        cacheWrite = addUsageTotal(cacheWrite, usage.cacheWrite);
        cost = addUsageTotal(cost, usage.cost);
        if (selected.isAssistant) {
            latestCacheHitRate = calculateCacheHitRate(
                usage.input,
                usage.cacheRead,
                usage.cacheWrite,
            );
        }
    }

    return Object.freeze({ input, output, cacheRead, cacheWrite, latestCacheHitRate, cost });
}

export function invalidateUsageTotalsCache(): void {
    usageTotalsCache = undefined;
}

/** Test helper: counts aggregation passes only; every cache lookup still fingerprints all entries. */
export function __usageTotalsAggregationPassCount(): number {
    return usageTotalsAggregationPassCount;
}

/** Test helper: reset the aggregation-pass counter and cached totals. */
export function __resetUsageTotalsCacheForTests(): void {
    usageTotalsCache = undefined;
    usageTotalsAggregationPassCount = 0;
}

export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
    const sessionManager = ctx.sessionManager as {
        getEntries?: () => readonly SessionEntry[];
        getBranch: () => readonly SessionEntry[];
    };
    const entries =
        typeof sessionManager.getEntries === "function"
            ? sessionManager.getEntries()
            : sessionManager.getBranch();
    const key = buildUsageFingerprint(entries);
    if (usageTotalsCache?.key === key) return usageTotalsCache.totals;

    const totals = computeUsageTotals(entries);
    usageTotalsCache = { key, totals };
    return totals;
}

const EMPTY_USAGE_TOTALS: UsageTotals = Object.freeze({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
});

/**
 * Production-only snapshot for Pi's append-only session contract. The owner must invalidate
 * at message/agent completion, settlement, tree/compaction and session boundaries. Leaf IDs
 * supplement those events; they are NOT a full-history revision. Silent same-leaf in-place
 * edits outside those boundaries require the generic mutation-safe getUsageTotals instead.
 */
export class EventUsageTotalsController {
    private snapshot?: {
        manager: ExtensionContext["sessionManager"];
        sessionId: string;
        leafId: string | null;
        totals: UsageTotals;
    };

    invalidate(): void {
        this.snapshot = undefined;
    }

    resolve(ctx: ExtensionContext, demanded: boolean): UsageTotals {
        if (!demanded) {
            this.invalidate();
            return EMPTY_USAGE_TOTALS;
        }
        const manager = ctx.sessionManager;
        let identity: { sessionId: string; leafId: string | null } | undefined;
        try {
            if (
                typeof manager.getEntries === "function" &&
                typeof manager.getSessionId === "function" &&
                typeof manager.getLeafId === "function"
            ) {
                const sessionId = manager.getSessionId();
                const leafId = manager.getLeafId();
                if (
                    typeof sessionId === "string" &&
                    sessionId.length > 0 &&
                    (leafId === null || (typeof leafId === "string" && leafId.length > 0))
                )
                    identity = { sessionId, leafId };
            }
        } catch {
            // Older or unsupported hosts retain the generic mutation-safe path.
        }
        if (!identity) {
            this.invalidate();
            return getUsageTotals(ctx);
        }
        if (
            this.snapshot?.manager === manager &&
            this.snapshot.sessionId === identity.sessionId &&
            this.snapshot.leafId === identity.leafId
        )
            return this.snapshot.totals;
        this.invalidate();
        const totals = computeUsageTotals(manager.getEntries() as readonly SessionEntry[]);
        this.snapshot = { manager, ...identity, totals };
        return totals;
    }
}

export function buildCacheReadLabel(cacheRead: number): string {
    return cacheRead > 0 ? `R${formatCount(cacheRead)}` : "";
}

export function buildCacheWriteLabel(cacheWrite: number): string {
    return cacheWrite > 0 ? `W${formatCount(cacheWrite)}` : "";
}

export function buildSessionTokenLabel(totals: Pick<UsageTotals, "input" | "output">): string {
    const parts: string[] = [];
    if (totals.input) parts.push(`↑${formatCount(totals.input)}`);
    if (totals.output) parts.push(`↓${formatCount(totals.output)}`);
    return parts.length > 0 ? parts.join(" ") : "↑0 ↓0";
}

export function formatCacheHitRate(rate: number | undefined): string {
    return `${rate !== undefined && Number.isFinite(rate) ? rate.toFixed(1) : "0.0"}%`;
}

export function buildTokenLabel(totals: UsageTotals, cacheHitIcon = "󰆼"): string {
    const tokenLabel = buildSessionTokenLabel(totals);
    const hasCacheTokens = totals.cacheRead > 0 || totals.cacheWrite > 0;
    if (!hasCacheTokens || totals.latestCacheHitRate === undefined) return tokenLabel;

    const cacheHitRate = formatCacheHitRate(totals.latestCacheHitRate);
    return `${tokenLabel} ${cacheHitIcon ? `${cacheHitIcon} ` : ""}${cacheHitRate}`;
}

export function buildCostLabel(totals: UsageTotals): string {
    return `$${totals.cost.toFixed(3)}`;
}

export function buildSessionDurationLabel(startEpoch: number): string {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startEpoch) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

export function contextColorTier(
    percent: number | null | undefined,
    thresholds: ContextThresholds = { warning: 70, error: 90 },
): ContextColorTier {
    if (percent === null || percent === undefined || !Number.isFinite(percent)) return "normal";
    if (percent >= thresholds.error) return "error";
    if (percent >= thresholds.warning) return "warning";
    return "normal";
}

export function buildContextGauge(percent: number, width = 10, ascii = false): string {
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round((clamped / 100) * width);
    const on = ascii ? "#" : "█";
    const off = ascii ? "-" : "░";
    return `${on.repeat(filled)}${off.repeat(Math.max(0, width - filled))}`;
}

export function formatContextPercentLabel(
    percent: number | null | undefined,
    contextWindow: number | undefined,
): string {
    if (!contextWindow || contextWindow <= 0) return "--";
    const percentLabel =
        percent === null || percent === undefined || !Number.isFinite(percent)
            ? "?"
            : `${Math.max(0, Math.min(999, percent)).toFixed(1)}%`;
    return `${percentLabel}/${formatCount(contextWindow)}`;
}

export function buildContextDisplayLabel(options: {
    percent: number | null | undefined;
    contextWindow: number | undefined;
    style?: ContextStyle;
    asciiGauge?: boolean;
}): string {
    const { percent, contextWindow, style = "text", asciiGauge = false } = options;
    if (!contextWindow || contextWindow <= 0) return "--";

    const text = formatContextPercentLabel(percent, contextWindow);
    const numericPercent =
        percent === null || percent === undefined || !Number.isFinite(percent)
            ? 0
            : Math.max(0, Math.min(100, percent));
    const gauge = buildContextGauge(numericPercent, 10, asciiGauge);

    if (style === "gauge") return `[${gauge}]`;
    if (style === "text+gauge") return `[${gauge}] ${text}`;
    return text;
}

export type ContextUsageSnapshot = {
    percent: number | undefined;
    contextWindow: number | undefined;
};

export function resolveContextUsage(
    ctx: Pick<ExtensionContext, "model" | "getContextUsage">,
    live?: { tokens: number },
): ContextUsageSnapshot {
    const liveTokens =
        live && Number.isFinite(live.tokens) && live.tokens >= 0 ? live.tokens : undefined;
    const modelWindow = ctx.model?.contextWindow;
    // Live provider usage is authoritative; avoid rebuilding the host session projection.
    if (
        liveTokens !== undefined &&
        modelWindow &&
        Number.isFinite(modelWindow) &&
        modelWindow > 0
    ) {
        return { percent: (liveTokens / modelWindow) * 100, contextWindow: modelWindow };
    }
    const usage = ctx.getContextUsage();
    const contextWindow = modelWindow ?? usage?.contextWindow;
    return {
        percent:
            liveTokens !== undefined &&
            contextWindow &&
            Number.isFinite(contextWindow) &&
            contextWindow > 0
                ? (liveTokens / contextWindow) * 100
                : (usage?.percent ?? undefined),
        contextWindow,
    };
}

export function buildContextLabel(ctx: ExtensionContext): string {
    const { percent, contextWindow } = resolveContextUsage(ctx);
    return formatContextPercentLabel(percent, contextWindow);
}

export type FormatCwdOptions = {
    mode?: PathDisplayMode;
    /** Final path components to keep in full/repository mode. 0 = unlimited. */
    depth?: number;
    home?: string;
    repositoryRoot?: string;
};

function normalizeDisplayPath(cwd: string): string {
    const withSlashes = cwd.replace(/\\/g, "/");
    if (withSlashes === "/" || /^\/+$/.test(withSlashes)) return "/";
    const stripped = withSlashes.replace(/\/+$/, "");
    return stripped === "" ? withSlashes : stripped;
}

function toHomePath(path: string, home: string): string {
    if (!home) return path;
    const homeNorm = home.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!homeNorm) return path;
    if (path === homeNorm) return "~";
    if (path.startsWith(`${homeNorm}/`)) return `~${path.slice(homeNorm.length)}`;
    return path;
}

/** Starship-style: keep last `depth` components; prefix with `…/` when parents were dropped. */
function applyPathDepth(path: string, depth: number): string {
    if (!Number.isFinite(depth) || depth <= 0) return path;
    const limit = Math.floor(depth);
    if (path === "~" || path === "/") return path;

    let components: string[];
    if (path.startsWith("~/")) {
        components = path.slice(2).split("/").filter(Boolean);
    } else if (/^[A-Za-z]:\//.test(path)) {
        components = path.slice(3).split("/").filter(Boolean);
    } else if (path.startsWith("/")) {
        components = path.slice(1).split("/").filter(Boolean);
    } else {
        components = path.split("/").filter(Boolean);
    }

    if (components.length <= limit) return path;
    return `…/${components.slice(-limit).join("/")}`;
}

export function formatCwdLabel(cwd: string, cwdIcon: string, options?: FormatCwdOptions): string {
    const mode = options?.mode ?? "basename";
    const normalized = normalizeDisplayPath(cwd);
    const fullPath = (depth = options?.depth ?? 0) => {
        const home =
            options?.home ??
            (() => {
                try {
                    return homedir();
                } catch {
                    return "";
                }
            })();
        return applyPathDepth(toHomePath(normalized, home), depth);
    };
    let pathText: string;
    if (mode === "full") {
        pathText = fullPath();
    } else if (mode === "repository") {
        const root = options?.repositoryRoot
            ? normalizeDisplayPath(options.repositoryRoot)
            : undefined;
        if (!root) {
            pathText = fullPath(0);
        } else {
            const rootPrefix = root === "/" ? "/" : `${root}/`;
            if (normalized !== root && !normalized.startsWith(rootPrefix)) {
                // Unsafe roots fail open to the existing unlimited full path.
                pathText = fullPath(0);
            } else {
                const relative = normalized === root ? "." : normalized.slice(rootPrefix.length);
                pathText =
                    relative === "." ? relative : applyPathDepth(relative, options?.depth ?? 0);
            }
        }
    } else if (normalized === "/") {
        pathText = "/";
    } else {
        const parts = normalized.split("/").filter(Boolean);
        pathText = parts[parts.length - 1] ?? cwd;
    }
    return cwdIcon ? `${cwdIcon} ${pathText}` : pathText;
}

export function formatGitBranchText(
    branch: string,
    maxLength: GitBranchMaxLength = "full",
): string {
    if (maxLength === "full" || visibleWidth(branch) <= maxLength) return branch;
    return stripAnsi(truncateToWidth(branch, maxLength, "…"));
}

export function formatUsernameHostLabel(icon: string): string {
    try {
        const user = userInfo().username;
        const host = hostname();
        if (!user || !host) return "";
        const label = `${user}@${host}`;
        return icon ? `${icon} ${label}` : label;
    } catch {
        return "";
    }
}

export function formatTimeLabel(icon: string): string {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const label = `${hours}:${minutes}`;
    return icon ? `${icon} ${label}` : label;
}

export function formatOsLabel(
    configuredIcon: string,
    mode: IconMode = "auto",
    platform: string = process.platform,
    osOverridden = false,
): string {
    return resolveOsIcon(configuredIcon, mode, platform, process.env, osOverridden);
}

export type EditorMetadataValues = {
    model: string;
    modelId: string;
    modelName: string;
    provider: string;
    thinking: string;
    sessionName: string;
    fastMode?: string;
    contextPercent?: number;
    contextWindow?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheHitRate?: number;
    customVariables?: ReadonlyMap<string, string>;
    hostTemplateValues?: HostTemplateValues;
};

type RenderedTokens = {
    styled: string;
    hasDynamic: boolean;
    hasNonEmptyDynamic: boolean;
};

export type EditorMetadataZones = {
    left: string;
    middle: string;
    right: string;
};

const ESC = 0x1b;

const BEL = 0x07;

const CAN = 0x18;

const SUB = 0x1a;

const C1_DCS = 0x90;

const C1_CSI = 0x9b;

const C1_ST = 0x9c;

const C1_OSC = 0x9d;

const C1_SOS = 0x98;

const C1_PM = 0x9e;

const C1_APC = 0x9f;

function consumeCsi(value: string, start: number): number {
    for (let index = start; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === CAN || code === SUB) return index + 1;
        if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return value.length;
}

function consumeControlString(value: string, start: number, allowBel: boolean): number {
    for (let index = start; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === CAN || code === SUB) return index + 1;
        if (allowBel && code === BEL) return index + 1;
        if (code === C1_ST) return index + 1;
        if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    }
    return value.length;
}

function consumeEscape(value: string, start: number): number {
    if (start + 1 >= value.length) return value.length;
    const next = value.charCodeAt(start + 1);
    if (next === 0x5b) return consumeCsi(value, start + 2);
    if (next === 0x5d) return consumeControlString(value, start + 2, true);
    if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        return consumeControlString(value, start + 2, false);
    }

    let index = start + 1;
    while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x20 && code <= 0x2f) {
            index += 1;
            continue;
        }
        return code >= 0x30 && code <= 0x7e ? index + 1 : index;
    }
    return value.length;
}

function isNormalizedWhitespace(code: number): boolean {
    return (
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0b ||
        code === 0x0c ||
        code === 0x0d ||
        code === 0x85 ||
        code === 0x2028 ||
        code === 0x2029
    );
}

export function sanitizeEditorMetadataText(value: string): string {
    let sanitized = "";
    for (let index = 0; index < value.length;) {
        const code = value.charCodeAt(index);
        if (code === ESC) {
            index = consumeEscape(value, index);
            continue;
        }
        if (code === C1_CSI) {
            index = consumeCsi(value, index + 1);
            continue;
        }
        if (code === C1_OSC) {
            index = consumeControlString(value, index + 1, true);
            continue;
        }
        if (code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC) {
            index = consumeControlString(value, index + 1, false);
            continue;
        }
        if (isNormalizedWhitespace(code)) {
            sanitized += " ";
            do index += 1;
            while (index < value.length && isNormalizedWhitespace(value.charCodeAt(index)));
            continue;
        }
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
            index += 1;
            continue;
        }
        sanitized += value[index];
        index += 1;
    }
    return sanitized;
}

function editorThinkingStyle(config: ZentuiConfig, level: string): string | undefined {
    switch (level.toLowerCase()) {
        case "minimal":
            return (
                componentColor(config, "editor", "thinkingMinimal") ??
                componentColor(config, "editor", "thinking")
            );
        case "low":
            return (
                componentColor(config, "editor", "thinkingLow") ??
                componentColor(config, "editor", "thinking")
            );
        case "medium":
            return (
                componentColor(config, "editor", "thinkingMedium") ??
                componentColor(config, "editor", "thinking")
            );
        case "high":
            return (
                componentColor(config, "editor", "thinkingHigh") ??
                componentColor(config, "editor", "thinking")
            );
        case "xhigh":
            return (
                componentColor(config, "editor", "thinkingXhigh") ??
                componentColor(config, "editor", "thinking")
            );
        case "max":
            return (
                componentColor(config, "editor", "thinkingMax") ??
                componentColor(config, "editor", "thinkingXhigh") ??
                componentColor(config, "editor", "thinking")
            );
        default:
            return componentColor(config, "editor", "thinking");
    }
}

function renderVariable(
    name: string,
    values: EditorMetadataValues,
    uiTheme: Theme,
    config: ZentuiConfig,
    shellMode = false,
): { plain: string; styled: string } {
    const editor = config.components.editor;
    const style =
        editor.style === "opencode-copy-friendly"
            ? editor.styles[editor.style]
            : editor.styles.opencode;
    const aliases = normalizeTemplateVariables(style.variables, OPENCODE_FORMAT_VARIABLES);
    if (isHostTemplateVariable(name) && !Object.hasOwn(aliases, name)) {
        const plain = sanitizeEditorMetadataText(values.hostTemplateValues?.[name] ?? "");
        return {
            plain,
            styled: plain
                ? renderStyleForSourceOrFallback(
                      uiTheme,
                      editor.colorSource,
                      liveMetadataColor(config, "editor", name) ??
                          componentColor(config, "editor", "border"),
                      "border",
                      plain,
                  )
                : "",
        };
    }
    if (Object.hasOwn(aliases, name)) {
        const raw = values.customVariables?.get(aliases[name]) ?? "";
        const text = renderCustomValue({
            key: aliases[name],
            raw,
            colors: editor.customValueColors,
            mode: style.extensionColorMode ?? "original",
            theme: uiTheme,
            source: editor.colorSource,
            fallbackStyle: config.colors.extensionStatus,
        });
        const plain = sanitizeEditorMetadataText(text);
        return {
            plain,
            styled: plain ? text : "",
        };
    }
    if (name === "fast_mode") {
        const plain = sanitizeEditorMetadataText(values.fastMode ?? "");
        return { plain, styled: plain ? safeThemeFg(uiTheme, "accent", plain) : "" };
    }
    const colorSource = config.components.editor.colorSource;
    const thinking = values.thinking.toLowerCase() === "off" ? "" : values.thinking;
    const raw =
        name === "model"
            ? values.model
            : name === "model_id"
              ? values.modelId
              : name === "model_name"
                ? values.modelName
                : name === "provider"
                  ? values.provider
                  : name === "thinking"
                    ? thinking
                    : name === "session_name"
                      ? values.sessionName
                      : name === "context"
                        ? formatContextPercentLabel(values.contextPercent, values.contextWindow)
                        : name === "tokens"
                          ? buildSessionTokenLabel({
                                input: values.inputTokens ?? 0,
                                output: values.outputTokens ?? 0,
                            })
                          : name === "cache_hit"
                            ? formatCacheHitRate(values.cacheHitRate)
                            : "";
    const plain = sanitizeEditorMetadataText(raw);
    if (!plain) return { plain: "", styled: "" };

    if (name === "model" || name === "model_id" || name === "model_name") {
        const chrome = shellMode
            ? editorShellColor(config)
            : {
                  color: componentColor(config, "editor", "model"),
                  fallback: EDITOR_ACCENT_FALLBACK,
              };
        return {
            plain,
            styled: renderStyleForSourceOrFallback(
                uiTheme,
                colorSource,
                chrome.color,
                chrome.fallback,
                plain,
            ),
        };
    }
    if (name === "provider") {
        return {
            plain,
            styled: renderStyleForSourceOrFallback(
                uiTheme,
                colorSource,
                componentColor(config, "editor", "provider"),
                "text",
                plain,
            ),
        };
    }
    if (name === "thinking") {
        return {
            plain,
            styled: renderStyleForSourceOrFallback(
                uiTheme,
                colorSource,
                editorThinkingStyle(config, plain),
                "muted",
                plain,
            ),
        };
    }
    if (
        name === "session_name" ||
        name === "context" ||
        name === "tokens" ||
        name === "cache_hit"
    ) {
        return { plain, styled: safeThemeFg(uiTheme, "border", plain) };
    }
    return { plain: "", styled: "" };
}

function renderTokens(
    tokens: readonly ReadonlyFormatToken[],
    values: EditorMetadataValues,
    uiTheme: Theme,
    config: ZentuiConfig,
    shellMode = false,
): RenderedTokens {
    const hasJoin = tokens.some((token) => token.kind === "var" && token.name === "join_sep");
    let hasDynamic = false;
    let hasNonEmptyDynamic = false;
    const styled = renderJoinedTokenFields(
        tokens,
        (field) => {
            const rendered = renderTokenField(field, values, uiTheme, config, shellMode);
            hasDynamic ||= rendered.hasDynamic;
            if (!hasJoin || stripVTControlCharacters(rendered.styled).trim())
                hasNonEmptyDynamic ||= rendered.hasNonEmptyDynamic;
            return rendered.styled;
        },
        () => safeThemeFg(uiTheme, "border", " · "),
    );
    // An empty join cannot keep an enclosing optional group alive.
    if (hasJoin && !stripVTControlCharacters(styled).trim()) hasDynamic = true;
    return { styled, hasDynamic, hasNonEmptyDynamic };
}

function renderTokenField(
    tokens: readonly ReadonlyFormatToken[],
    values: EditorMetadataValues,
    uiTheme: Theme,
    config: ZentuiConfig,
    shellMode = false,
): RenderedTokens {
    let styled = "";
    let hasDynamic = false;
    let hasNonEmptyDynamic = false;

    for (const token of tokens) {
        if (token.kind === "text") {
            const plain = sanitizeEditorMetadataText(token.value);
            if (plain) styled += safeThemeFg(uiTheme, "border", plain);
            continue;
        }
        if (token.kind === "fill") {
            hasDynamic = true;
            continue;
        }
        if (token.kind === "var") {
            hasDynamic = true;
            const rendered = renderVariable(token.name, values, uiTheme, config, shellMode);
            styled += rendered.styled;
            if (rendered.plain) hasNonEmptyDynamic = true;
            continue;
        }

        const rendered = renderTokens(token.tokens, values, uiTheme, config, shellMode);
        const visible = !rendered.hasDynamic || rendered.hasNonEmptyDynamic;
        hasDynamic = true;
        if (visible) {
            styled += rendered.styled;
            hasNonEmptyDynamic = true;
        }
    }

    return { styled, hasDynamic, hasNonEmptyDynamic };
}

export function renderEditorMetadataFormatSplit(
    format: string,
    values: EditorMetadataValues,
    uiTheme: Theme,
    config: ZentuiConfig,
    shellMode = false,
): EditorMetadataZones {
    const tokens = parseFooterFormat(sanitizeEditorMetadataText(format));
    const fillIndices: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index]?.kind === "fill") fillIndices.push(index);
    }

    const first = fillIndices[0];
    const second = fillIndices[1];
    if (first === undefined) {
        return {
            left: renderTokens(tokens, values, uiTheme, config, shellMode).styled,
            middle: "",
            right: "",
        };
    }
    if (second === undefined) {
        return {
            left: renderTokens(tokens.slice(0, first), values, uiTheme, config, shellMode).styled,
            middle: "",
            right: renderTokens(tokens.slice(first + 1), values, uiTheme, config, shellMode).styled,
        };
    }
    return {
        left: renderTokens(tokens.slice(0, first), values, uiTheme, config, shellMode).styled,
        middle: renderTokens(tokens.slice(first + 1, second), values, uiTheme, config, shellMode)
            .styled,
        right: renderTokens(tokens.slice(second + 1), values, uiTheme, config, shellMode).styled,
    };
}

export function renderEditorMetadataFormat(
    format: string,
    values: EditorMetadataValues,
    uiTheme: Theme,
    config: ZentuiConfig,
    shellMode = false,
): string {
    return renderTokens(
        parseFooterFormat(sanitizeEditorMetadataText(format)),
        values,
        uiTheme,
        config,
        shellMode,
    ).styled;
}

/** Nerd-mode fallback used when a configured rail is missing or unusable. */
export const DEFAULT_RAIL_GLYPH = "│";

/** ASCII-mode fallback used when a configured rail is missing or unusable. */
export const DEFAULT_ASCII_RAIL_GLYPH = "|";

/** Rail glyphs offered by the Editor and User messages settings panels. */
export const RAIL_GLYPH_CHOICES = ["│", "┃", "▎", "▌", "|"] as const;

/** Settings label for "inherit the shared/default glyph". */
export const RAIL_GLYPH_INHERIT = "Default";

/** Keep the first terminal cell of a sanitized value without adding escape codes. */
function firstCell(value: string): string {
    let result = "";
    for (const character of value) {
        const candidate = result + character;
        if (visibleWidth(candidate) > 1) break;
        result = candidate;
    }
    return result;
}

/**
 * Normalize a configured glyph to exactly one terminal cell.
 *
 * Returns undefined when the value cannot be used as a rail: control
 * sequences, empty strings, and wide characters all fail closed. Surrounding
 * whitespace is dropped so a padded value still selects its glyph instead of
 * degrading into an invisible blank rail cell.
 */
export function normalizeRailGlyph(value: string | undefined): string | undefined {
    if (typeof value !== "string") return undefined;
    const sanitized = sanitizeEditorMetadataText(value).trim();
    if (!sanitized) return undefined;
    const glyph = firstCell(sanitized);
    return visibleWidth(glyph) === 1 ? glyph : undefined;
}

function asciiIconMode(config: ZentuiConfig): boolean {
    return config.icons.effectiveMode === "ascii";
}

/**
 * The canonical owner glyph.
 *
 * `asciiRail` is the ASCII-icon-mode override of the same rail, so a
 * hand-written `rail` keeps working while the effective icon mode is `ascii`.
 * This mirrors `icons.rail`, where an explicit override wins in every mode and
 * only the built-in defaults are mode-specific.
 */
function canonicalEditorRail(config: ZentuiConfig): string | undefined {
    const editor = config.components.editor;
    return asciiIconMode(config) ? (editor.asciiRail ?? editor.rail) : editor.rail;
}

function canonicalUserMessageRail(config: ZentuiConfig): string | undefined {
    const messages = config.components.userMessages;
    return asciiIconMode(config) ? (messages.asciiRail ?? messages.rail) : messages.rail;
}

/**
 * The rail glyph of the Opencode editor frame.
 *
 * The canonical `components.editor.rail` choice wins; otherwise the shared
 * `icons.rail` stays the historical fallback. Frame provenance uses the same
 * glyph the Opencode frame renders, so ownership checks stay consistent.
 */
export function resolveEditorFrameRailGlyph(config: ZentuiConfig): string {
    const canonical = normalizeRailGlyph(canonicalEditorRail(config));
    if (canonical) return canonical;
    return config.icons.rail;
}

/**
 * The user-message rail glyph.
 *
 * The canonical `components.userMessages.rail` choice wins; otherwise the
 * shared `icons.rail` stays the historical fallback.
 */
export function resolveUserMessageRailGlyph(config: ZentuiConfig): string {
    const canonical = normalizeRailGlyph(canonicalUserMessageRail(config));
    if (canonical) return canonical;
    return config.icons.rail;
}
