// Boxed tool-call/result rendering primitives.
//
// Two deliberate design points:
//
// 1. Background: every tool card is filled with the theme's base background
//    (TOOL_CARD_BG_HEX, fork delta) instead of pi's status-driven fill
//    (toolPendingBg / toolErrorBg / toolSuccessBg) — see applyCardBackground. The
//    native container fill is always neutralized so the fill comes only from
//    the component that draws the frame. Boxless surfaces (quiet tool
//    rows/tree panels, git/gh semantic cards, turn summaries) stay
//    transparent as in pi-style.
//
// 2. Theme functions are accessed through a minimal structural interface
//    (BoxTheme) instead of `any`.

import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { bgHex, fgHex, isHexColor, stripAnsi } from "./ansi.js";
import {
    formatElapsedMs,
    formatToolMetrics,
    getElapsedMs,
    type MetricResultLike,
} from "./elapsed.js";
import {
    boxedResultRenderBudget,
    clampRenderLine,
    DEFAULT_COLLAPSED_RENDER_LINES,
    fastBoxLineContent,
    safeTruncateToWidth,
    safeVisibleWidth,
    safeWrapTextWithAnsi,
} from "./render-budget.js";
import { getThemeExtra } from "./theme-extras.js";

/** Nerd Font glyphs for the running state: the title marker and the live footer
 *  label. Same font requirement as pi-style's `batchOpenGlyph`. The title glyph
 *  is also the running marker in batch panels and gh status rows. */
export const RUNNING_TITLE_GLYPH = "󱦟";
const RUNNING_STATUS_GLYPH = "󰐊";

/** Minimal structural view of Pi's Theme as used by the boxed renderers. */
export interface BoxTheme {
    fg(color: string, text: string): string;
    bg?(color: string, text: string): string;
    bold?(text: string): string;
    italic?(text: string): string;
    inverse?(text: string): string;
    getColorMode?(): string;
}

/** Card background fill (fork delta): the tokyo-night base background (theme
 *  var "bg"). Pi's theme schema exposes no base-background token, so the hex
 *  is pinned here; the diff renderer reuses it so diff rows blend from the
 *  same base. */
export const TOOL_CARD_BG_HEX = "#1a1b26";

/** Fill every line with the card background. Replaces pi-style's status-driven
 *  fill (toolPendingBg / toolErrorBg / toolSuccessBg) — status stays conveyed
 *  by the title glyph and frame colors. */
function applyCardBackground(theme: BoxTheme, lines: string[]): string[] {
    return lines.map((line) => bgHex(theme, TOOL_CARD_BG_HEX, line));
}

const THEME_CACHE_KEYS = new WeakMap<object, number>();
let nextThemeCacheKey = 1;

export function themeCacheKey(theme: object): number {
    const cached = THEME_CACHE_KEYS.get(theme);
    if (cached !== undefined) return cached;
    const created = nextThemeCacheKey++;
    THEME_CACHE_KEYS.set(theme, created);
    return created;
}

export interface BoxedRenderOptions {
    widthKey?: string;
    /** Detail embedded in the top-border title after the tool name (e.g. the
     *  path). A function form is resolved lazily at render time so the header can
     *  pick up state a result renderer published in the same updateDisplay pass
     *  (e.g. diff stats: `path · +3 -0`). */
    headerDetail?: string | (() => string);
    isError?: boolean;
    isPartial?: boolean;
    isPending?: boolean;
    /** Execution has started but the tool is still running (title `󱦟` instead of `✓`). */
    running?: boolean;
    /** A result renderer already produced a continuation for this call, so the call
     *  leaves the box open instead of closing it with a pending label. */
    resultSeen?: boolean;
    pendingText?: string;
    /** Verbatim bottom-border label for the pending/running card (overrides the
     *  `… ${pendingText}` default, e.g. a live `󰐊 Running · 12.4s` status). */
    pendingLabel?: string;
    state?: Record<string, unknown>;
    /** Wall-clock elapsed override (used when metrics are not in result.details). */
    elapsedMs?: number;
    /** Width-dependent content lines rendered between the top border and the
     *  footer border of a compact box (replaces the blank breathing line).
     *  Each returned line is truncated to the box inner width by the renderer.
     *  Returns an empty array for no body (blank line preserved). */
    bodyLines?: (contentWidth: number) => string[];
    /** Right-side label embedded in the compact box bottom border before the
     *  corner (e.g. an expand hint such as `Ctrl+O for more`). */
    bottomRightLabel?: string;
    /** Tint the compact box with the semantic status background. Only framed
     *  compact surfaces (e.g. the write preview box) opt in — boxless compact
     *  surfaces (quiet-tool rows, tree panels) stay transparent. */
    tint?: boolean;
}

export function isExpanded(options: { expanded?: boolean } | undefined): boolean {
    return typeof options?.expanded === "boolean" ? options.expanded : false;
}

export function shortenPath(path: string): string {
    const home = homedir();
    if (path.startsWith(home)) return `~${path.slice(home.length)}`;
    return path;
}

export function resolveAbsolutePath(rawPath: string, cwd: string): string {
    const path = rawPath.trim();
    if (!path) return "";

    const home = process.env.HOME;
    if (home && (path === "~" || path.startsWith("~/"))) {
        return path === "~" ? home : resolve(home, path.slice(2));
    }

    return resolve(cwd, path);
}

export function resolveRelativePath(rawPath: string, cwd: string): string {
    const absPath = resolveAbsolutePath(rawPath, cwd);
    if (!absPath) return "(unknown)";
    const relPath = relative(cwd, absPath).replace(/\\/g, "/");
    return relPath || ".";
}

export function replaceTabs(text: string): string {
    return text.replace(/\t/g, "   ");
}

export function getTextOutput(result: MetricResultLike | undefined): string {
    if (!result?.content) return "";
    const textBlocks = result.content.filter((contentBlock) => {
        if (!contentBlock || typeof contentBlock !== "object") return false;
        return (contentBlock as { type?: unknown }).type === "text";
    });
    return textBlocks
        .map((contentBlock) => String((contentBlock as { text?: unknown }).text ?? ""))
        .join("\n")
        .replace(/\r/g, "");
}

export function stripTrailingNotice(text: string): string {
    const normalized = (text ?? "").replace(/\r/g, "").trimEnd();
    if (!normalized) return "";
    if (normalized.startsWith("[") && normalized.endsWith("]")) return "";
    const noticeStart = normalized.lastIndexOf("\n\n[");
    if (noticeStart >= 0 && normalized.endsWith("]")) {
        return normalized.slice(0, noticeStart).trimEnd();
    }
    return normalized;
}

export function extractTrailingNotice(text: string): string | null {
    const normalized = (text ?? "").replace(/\r/g, "").trimEnd();
    if (!normalized) return null;
    if (normalized.startsWith("[") && normalized.endsWith("]")) return normalized;
    const noticeStart = normalized.lastIndexOf("\n\n[");
    if (noticeStart >= 0 && normalized.endsWith("]")) {
        return normalized.slice(noticeStart + 2).trimEnd();
    }
    return null;
}

export function countLines(text: string): number {
    const normalized = (text ?? "").replace(/\r/g, "").replace(/\n+$/g, "");
    if (!normalized) return 0;
    return normalized.split("\n").length;
}

// Word-character membership table powering countWords. ASCII and the UTF-16
// surrogate range are initialized eagerly; every other BMP code point is
// resolved through the Unicode letter/digit class on first sight and memoized,
// so repeat scans are pure table lookups. The per-code-point regex dispatch
// this replaces measured ~1.9ms per 90KB output on every boxed footer render;
// note that String.match with a \p{L}\p{N} class is no faster on V8 — the
// memoized scan is the only variant that hit the <0.2ms budget.
const WORD_CP_UNKNOWN = 255;
const WORD_CP_SURROGATE = 254;
const WORD_CP_CLASS = new Uint8Array(0x10000).fill(WORD_CP_UNKNOWN);
for (let code = 0x30; code <= 0x39; code++) WORD_CP_CLASS[code] = 1; // 0-9
for (let code = 0x41; code <= 0x5a; code++) WORD_CP_CLASS[code] = 1; // A-Z
for (let code = 0x61; code <= 0x7a; code++) WORD_CP_CLASS[code] = 1; // a-z
WORD_CP_CLASS[0x27] = 1; // '
WORD_CP_CLASS[0x2d] = 1; // -
WORD_CP_CLASS[0x5f] = 1; // _
WORD_CP_CLASS.fill(WORD_CP_SURROGATE, 0xd800, 0xe000);
const NON_ASCII_WORD_RE = /[\p{L}\p{N}]/u;
const ASTRAL_WORD_CP = new Map<number, 0 | 1>();

function astralWordMembership(codePoint: number): 0 | 1 {
    const cached = ASTRAL_WORD_CP.get(codePoint);
    if (cached !== undefined) return cached;
    const membership: 0 | 1 = NON_ASCII_WORD_RE.test(String.fromCodePoint(codePoint)) ? 1 : 0;
    ASTRAL_WORD_CP.set(codePoint, membership);
    return membership;
}

/** Counts words as maximal runs of word characters (letters, digits,
 *  underscore, apostrophe, hyphen) — identical counts to a per-code-point
 *  `\p{L}\p{N}_'-` class test, in one table-driven pass with no allocations. */
export function countWords(text: string): number {
    const len = text.length;
    let count = 0;
    let inWord: number = 0;
    for (let i = 0; i < len; i++) {
        const code = text.charCodeAt(i);
        const membership = WORD_CP_CLASS[code] ?? 0;
        let isWord: number;
        if (membership <= 1) {
            isWord = membership;
        } else if (membership === WORD_CP_SURROGATE) {
            const next = i + 1 < len ? text.charCodeAt(i + 1) : 0;
            if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
                // Astral word characters (e.g. mathematical alphanumerics) count as
                // one code point, exactly like the previous code-point iteration.
                isWord = astralWordMembership(0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00));
                i++; // consumed the pair's low surrogate half
            } else {
                isWord = 0; // lone surrogate half: never a word character
            }
        } else {
            // First sight of this non-ASCII BMP code point: resolve once, memoize.
            isWord = NON_ASCII_WORD_RE.test(String.fromCharCode(code)) ? 1 : 0;
            WORD_CP_CLASS[code] = isWord;
        }
        count += isWord & (inWord ^ 1);
        inWord = isWord;
    }
    return count;
}

export function formatCompactCount(value: number): string {
    if (value < 1000) return `${Math.round(value)}`;
    if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
    if (value < 1000000) return `${Math.round(value / 1000)}k`;
    if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
    return `${Math.round(value / 1000000)}M`;
}

/** Measured-value identity colors: value in yellow, unit in blue. */
export function formatMetricParts(theme: BoxTheme, value: string, unit: string): string {
    return `${theme.fg("warning", value)}${theme.fg("accent", unit)}`;
}

/** Number/unit pairs of a promoted elapsed metric (`812ms`, `15.28s`, `2m5s`,
 *  `1h2m`); `ms` is listed before `s` so it wins the alternation. */
const ELAPSED_METRIC_PAIR_RE = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;

/** Elapsed metric with every value in yellow and every unit in blue. The
 *  promoted form splits into one value/unit pair per unit, so a compound
 *  duration carries its earlier unit inside the plain value (`2m5` + `s`,
 *  `1h2` + `m`) — coloring that pair alone leaves the leading unit yellow.
 *  Recolor the promoted plain form pair by pair instead; the text is the same
 *  one `formatElapsedParts` builds. */
export function formatElapsedMetric(theme: BoxTheme, elapsedMs: number | undefined): string {
    return formatElapsedMs(elapsedMs).replace(
        ELAPSED_METRIC_PAIR_RE,
        (_match, value: string, unit: string) => formatMetricParts(theme, value, unit),
    );
}

export function formatBoxedWords(theme: BoxTheme, text: string): string {
    return formatMetricParts(theme, `~${formatCompactCount(countWords(text))}`, " words");
}

export function badge(theme: BoxTheme, label: string): string {
    const tagBg = getThemeExtra(theme, "tagBgColor");
    if (tagBg && isHexColor(tagBg)) {
        return theme.inverse
            ? theme.inverse(
                  fgHex(theme, tagBg, theme.bold ? theme.bold(` ${label} `) : ` ${label} `),
              )
            : fgHex(theme, tagBg, theme.bold ? theme.bold(` ${label} `) : ` ${label} `);
    }
    return theme.inverse
        ? theme.inverse(theme.bold ? theme.bold(` ${label} `) : ` ${label} `)
        : ` ${label} `;
}

export function parens(theme: BoxTheme, text: string, skipTextColor?: boolean): string {
    const bracketColor = getThemeExtra(theme, "parensBracketColor");
    const openParen =
        bracketColor && isHexColor(bracketColor) ? fgHex(theme, bracketColor, "(") : "(";
    const closeParen =
        bracketColor && isHexColor(bracketColor) ? fgHex(theme, bracketColor, ")") : ")";
    let innerBase: string;
    if (skipTextColor) {
        innerBase = text;
    } else {
        const textColor = getThemeExtra(theme, "parensTextColor");
        innerBase = textColor && isHexColor(textColor) ? fgHex(theme, textColor, text) : text;
    }
    const inner =
        typeof theme?.bold === "function" ? theme.bold(innerBase) : `\x1b[1m${innerBase}\x1b[22m`;
    return `${openParen}${inner}${closeParen}`;
}

const BOX_HORIZONTAL = "─";
const BOX_VERTICAL = "│";
const BOX_SIDE_PADDING = 2;
const BOX_MIN_WIDTH = 12;
const BOX_ROUND_TOP_LEFT = "╭";
const BOX_ROUND_TOP_RIGHT = "╮";
const BOX_ROUND_BOTTOM_LEFT = "╰";
const BOX_ROUND_BOTTOM_RIGHT = "╯";
const BOX_DIVIDER_LEFT = "├";
const BOX_DIVIDER_RIGHT = "┤";
/** Dash run before the right corner when a right-side border label is present. */
const BOX_LABELED_RIGHT_DASH_MIN = 3;
const BOX_WIDTH_CACHE = new Map<string, number>();

export function boxWidth(width: number): number {
    return Math.max(BOX_MIN_WIDTH, width);
}

export function boxInnerWidth(width: number): number {
    return Math.max(1, boxWidth(width) - 2 - BOX_SIDE_PADDING * 2);
}

export function boxedToolWidthKey(toolName: string, detail: string): string {
    return `${toolName}:${detail}`;
}

/** Test-only debug view of the bounded box width cache. */
export function __getBoxWidthCacheDebugState(): { size: number } {
    return { size: BOX_WIDTH_CACHE.size };
}

export function formatToolName(toolName: string): string {
    const spaced = toolName
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .trim();
    return spaced.replace(/\b\w/g, (char) => char.toUpperCase()) || toolName;
}

function formatToolParamName(name: string): string {
    const spaced = name
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .trim();
    return spaced ? spaced[0]?.toUpperCase() + spaced.slice(1) : name;
}

const MAX_PARAM_VALUE_LENGTH = 120;

function formatOperationSummary(value: unknown): string | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (!value.every((item) => item && typeof item === "object" && !Array.isArray(item)))
        return undefined;
    const types = Array.from(
        new Set(value.map((item) => String((item as { type?: unknown }).type ?? "operation"))),
    );
    const typeSummary =
        types.length === 1
            ? ` (${types[0]})`
            : types.length > 1
              ? ` (${types.slice(0, 3).join(", ")}${types.length > 3 ? ", …" : ""})`
              : "";
    return `${value.length} ${value.length === 1 ? "operation" : "operations"}${typeSummary}`;
}

function formatToolParamValue(value: unknown): string {
    if (value === undefined) return "";
    if (value === null) return "null";
    if (typeof value === "string") {
        if (value.length <= MAX_PARAM_VALUE_LENGTH) return value;
        return `${value.slice(0, MAX_PARAM_VALUE_LENGTH)}…`;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
        return String(value);
    if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        return (
            formatOperationSummary(value) ??
            `${value.length} ${value.length === 1 ? "item" : "items"}`
        );
    }
    if (typeof value === "object" && value !== null) {
        const keys = Object.keys(value);
        if (keys.length === 0) return "{}";
        return `{${keys.length} ${keys.length === 1 ? "key" : "keys"}}`;
    }
    try {
        const json = JSON.stringify(value);
        if (json.length <= MAX_PARAM_VALUE_LENGTH) return json;
        return `${json.slice(0, MAX_PARAM_VALUE_LENGTH)}…`;
    } catch {
        return String(value);
    }
}

export function formatToolParamLines(args: unknown, theme?: BoxTheme): string[] {
    if (args === undefined || args === null) return [];
    if (typeof args !== "object" || Array.isArray(args)) {
        const value = formatToolParamValue(args);
        return value ? [`Params: ${value}`] : [];
    }

    const entries = Object.entries(args as Record<string, unknown>).filter(
        ([, value]) => value !== undefined,
    );
    if (entries.length === 0) return [];

    const lines: string[] = [];
    for (const [key, value] of entries) {
        const formattedValue = formatToolParamValue(value);
        if (!formattedValue) continue;
        const [firstLine = "", ...restLines] = formattedValue.replace(/\r/g, "").split("\n");
        const keyLabel = formatToolParamName(key);
        if (theme) {
            lines.push(`${theme.fg("dim", `${keyLabel}:`)} ${theme.fg("text", firstLine)}`);
            lines.push(...restLines.map((line) => `  ${theme.fg("text", line)}`));
        } else {
            lines.push(`${keyLabel}: ${firstLine}`);
            lines.push(...restLines.map((line) => `  ${line}`));
        }
    }
    return lines;
}

function colorFromExtra(
    theme: BoxTheme,
    extraKey: string,
    fallbackColor: string,
    text: string,
): string {
    const color = getThemeExtra(theme, extraKey);
    if (color) {
        if (isHexColor(color)) return fgHex(theme, color, text);
        try {
            return theme.fg(color, text);
        } catch {
            // Fall back to semantic theme color below.
        }
    }
    return theme.fg(fallbackColor, text);
}

function formatBoxedStatusIcon(theme: BoxTheme, isError?: boolean): string {
    const icon = isError ? "✗" : "✓";
    return theme.fg(isError ? "error" : "success", icon);
}

/**
 * Colored `➔ Name` prefix for tool titles: the arrow keeps the identity color,
 * the tool name uses the accent blue. The status glyph (✓/󱦟/✗) is appended
 * separately by formatBoxedToolTitle.
 */
export function formatToolTitlePrefix(theme: BoxTheme, name: string): string {
    const arrow = colorFromExtra(theme, "bashPromptColor", "bashMode", "➔");
    return `${arrow} ${theme.fg("accent", name)}`;
}

export type BoxedTitleStatus = "running" | "pending";

/**
 * Boxed tool title: `➔ Name ✓` when settled, `➔ Name 󱦟` while running, plain
 * `➔ Name` while pending, and a fully error-colored `➔ Name ✗` on failure.
 * The ✓/󱦟 glyphs are never shown before the tool settles, so a card that is
 * still executing never reads as finished.
 */
export function formatBoxedToolTitle(
    theme: BoxTheme,
    name: string,
    isError?: boolean,
    status?: BoxedTitleStatus,
): string {
    // On failure the whole title turns error-colored (not just the ✗) so a failed
    // tool reads instantly; on success the tool keeps its identity color and only
    // the ✓ carries the success color.
    const coloredTitle = isError
        ? theme.fg("error", `➔ ${name} ✗`)
        : status === "running"
          ? `${formatToolTitlePrefix(theme, name)} ${theme.fg("text", RUNNING_TITLE_GLYPH)}`
          : status === "pending"
            ? formatToolTitlePrefix(theme, name)
            : `${formatToolTitlePrefix(theme, name)} ${formatBoxedStatusIcon(theme, false)}`;
    return typeof theme?.bold === "function" ? theme.bold(coloredTitle) : coloredTitle;
}

/** Live running status label for pending/running cards and streaming footers. */
export function formatBoxedRunningStatus(theme: BoxTheme, elapsedMs: number | undefined): string {
    const label = theme.fg("success", `${RUNNING_STATUS_GLYPH} Running`);
    if (elapsedMs === undefined) return label;
    return `${label}${theme.fg("dim", " · ")}${formatElapsedMetric(theme, elapsedMs)}`;
}

/** Structural line — box frame, tree branch, divider, gutter — wrapped in
 * dim terminal-default intensity. Visible in every theme; matches omp. */
export function dimLine(text: string): string {
    return `\x1b[2m${text}\x1b[22m`;
}

/** Frame chrome (borders, side bars, dividers). Dim by default; error boxes
 *  pass a theme color name so the whole frame reads as failed at a glance. */
function boxText(_theme: BoxTheme, text: string, color?: string): string {
    return color ? _theme.fg(color, text) : dimLine(text);
}
function boxFrameText(_theme: BoxTheme, text: string, color?: string): string {
    return color ? _theme.fg(color, text) : dimLine(text);
}

/** Frame identity for one tool block: red once the block failed, green once it
 *  settled successfully, dim while it is still pending, running or streaming.
 *  Settling is reported by `isPartial`/`isPending` — `running` stays true after
 *  a call settles, so it must never gate this. Positional on purpose: the frame
 *  paths must not allocate per render. */
export function boxFrameColor(
    isError?: boolean,
    isPartial?: boolean,
    isPending?: boolean,
): string | undefined {
    if (isError) return "error";
    if (isPartial || isPending) return undefined;
    return "success";
}

export function boxBorder(theme: BoxTheme, left: string, right: string, width: number): string {
    const renderedWidth = boxWidth(width);
    const innerWidth = renderedWidth - 2;
    return boxFrameText(theme, `${left}${BOX_HORIZONTAL.repeat(innerWidth)}${right}`);
}

/**
 * Border line with an optional label embedded after the left corner and an
 * optional right-side label before the right corner, e.g.:
 *
 *   ╭─ ➔ Bash ✓ ────────────╮
 *   ├─ Response ────────────┤
 *   ╰─ 0.00s · ~45 words ──── Ctrl+O for more ───╯
 */
export function boxLabeledBorder(
    theme: BoxTheme,
    start: string,
    end: string,
    leftLabel: string,
    rightLabel: string | undefined,
    width: number,
    frameColor?: string,
): string {
    const renderedWidth = boxWidth(width);
    let left = leftLabel ?? "";
    const right = rightLabel ?? "";
    let leftWidth = safeVisibleWidth(left);
    const rightWidth = safeVisibleWidth(right);
    const leftOverhead = left ? 3 : 0; // "─ " prefix + " " suffix
    const rightOverhead = right ? 2 : 0; // " " prefix + " " suffix
    let rightFill = right ? BOX_LABELED_RIGHT_DASH_MIN : 0;
    let fill =
        renderedWidth -
        start.length -
        end.length -
        leftOverhead -
        leftWidth -
        rightOverhead -
        rightWidth -
        rightFill;

    if (right && fill < 0) {
        rightFill = 1;
        fill =
            renderedWidth -
            start.length -
            end.length -
            leftOverhead -
            leftWidth -
            rightOverhead -
            rightWidth -
            rightFill;
    }

    if (fill < 0) {
        // Too narrow for the labels: truncate the left label, keeping at least one
        // filler dash so the border stays closed.
        const reserved =
            start.length +
            end.length +
            leftOverhead +
            (right ? rightOverhead + rightWidth + rightFill : 0) +
            1;
        const maxLeft = renderedWidth - reserved;
        left = maxLeft > 0 ? safeTruncateToWidth(left, maxLeft, "…") : "";
        leftWidth = safeVisibleWidth(left);
        fill =
            renderedWidth -
            start.length -
            end.length -
            (left ? leftWidth + leftOverhead : 0) -
            (right ? rightOverhead + rightWidth + rightFill : 0);
    }

    // Style each border segment separately. Embedded labels carry their own
    // foreground escapes that end in \x1b[39m (reset to the terminal default);
    // applying the border color to the whole line in one wrap would leave every
    // dash after a label in the default color, making one border render with
    // mixed brightness.
    const parts: string[] = [boxFrameText(theme, `${start}${left ? "─ " : ""}`, frameColor)];
    if (left) parts.push(left);
    parts.push(
        boxFrameText(
            theme,
            `${left ? " " : ""}${BOX_HORIZONTAL.repeat(Math.max(0, fill))}`,
            frameColor,
        ),
    );
    if (right) {
        parts.push(
            boxFrameText(theme, " ", frameColor),
            right,
            boxFrameText(theme, ` ${BOX_HORIZONTAL.repeat(rightFill)}`, frameColor),
        );
    }
    parts.push(boxFrameText(theme, end, frameColor));
    return parts.join("");
}

/** Empty content line used for breathing room inside a box. */
export function boxBlankLine(theme: BoxTheme, width: number, frameColor?: string): string {
    const renderedWidth = boxWidth(width);
    const contentWidth = boxInnerWidth(renderedWidth);
    const sidePad = " ".repeat(BOX_SIDE_PADDING);
    return `${boxFrameText(theme, BOX_VERTICAL, frameColor)}${sidePad}${" ".repeat(contentWidth)}${sidePad}${boxFrameText(theme, BOX_VERTICAL, frameColor)}`;
}

export function boxLineAligned(
    theme: BoxTheme,
    left: string,
    right: string,
    width: number,
): string {
    const renderedWidth = boxWidth(width);
    const contentWidth = boxInnerWidth(renderedWidth);
    const rightWidth = safeVisibleWidth(right);
    const sidePad = " ".repeat(BOX_SIDE_PADDING);

    if (!right || rightWidth >= contentWidth) {
        return boxLine(theme, right || left, renderedWidth);
    }

    const maxLeftWidth = Math.max(1, contentWidth - rightWidth - 1);
    const truncatedLeft = safeTruncateToWidth(left, maxLeftWidth, "…");
    const gap = " ".repeat(
        Math.max(1, contentWidth - safeVisibleWidth(truncatedLeft) - rightWidth),
    );
    return `${boxFrameText(theme, BOX_VERTICAL)}${sidePad}${truncatedLeft}${gap}${right}${sidePad}${boxFrameText(theme, BOX_VERTICAL)}`;
}

export function boxLineWithRight(
    theme: BoxTheme,
    left: string,
    right: string,
    width: number,
): string {
    const renderedWidth = boxWidth(width);
    const contentWidth = boxInnerWidth(renderedWidth);
    const divider = ` ${boxText(theme, "|")} `;
    const dividerWidth = safeVisibleWidth(divider);
    const rightWidth = safeVisibleWidth(right);
    const sidePad = " ".repeat(BOX_SIDE_PADDING);

    if (!right || rightWidth + dividerWidth >= contentWidth) {
        return boxLine(theme, right || left, renderedWidth);
    }

    const maxLeftWidth = Math.max(1, contentWidth - dividerWidth - rightWidth - 1);
    const truncatedLeft = safeTruncateToWidth(left, maxLeftWidth, "…");
    const gap = " ".repeat(
        Math.max(1, contentWidth - safeVisibleWidth(truncatedLeft) - dividerWidth - rightWidth),
    );
    return `${boxFrameText(theme, BOX_VERTICAL)}${sidePad}${truncatedLeft}${gap}${divider}${right}${sidePad}${boxFrameText(theme, BOX_VERTICAL)}`;
}

export function boxLine(
    theme: BoxTheme,
    content: string,
    width: number,
    frameColor?: string,
): string {
    const renderedWidth = boxWidth(width);
    const contentWidth = boxInnerWidth(renderedWidth);
    const fastContent = fastBoxLineContent(content, contentWidth);
    const sidePad = " ".repeat(BOX_SIDE_PADDING);
    if (fastContent) {
        const fill = " ".repeat(Math.max(0, contentWidth - fastContent.visibleWidth));
        return `${boxFrameText(theme, BOX_VERTICAL, frameColor)}${sidePad}${fastContent.text}${fill}${sidePad}${boxFrameText(theme, BOX_VERTICAL, frameColor)}`;
    }

    const truncated = safeTruncateToWidth(content, contentWidth, "…");
    const fill = " ".repeat(Math.max(0, contentWidth - safeVisibleWidth(truncated)));
    return `${boxFrameText(theme, BOX_VERTICAL, frameColor)}${sidePad}${truncated}${fill}${sidePad}${boxFrameText(theme, BOX_VERTICAL, frameColor)}`;
}

export function boxInsetDivider(theme: BoxTheme, width: number): string {
    const renderedWidth = boxWidth(width);
    const lineWidth = boxInnerWidth(renderedWidth);
    const sidePad = " ".repeat(BOX_SIDE_PADDING);
    return `${boxFrameText(theme, BOX_VERTICAL)}${sidePad}${boxText(theme, BOX_HORIZONTAL.repeat(lineWidth))}${sidePad}${boxFrameText(theme, BOX_VERTICAL)}`;
}

export function boxedWrappedLines(
    theme: BoxTheme,
    content: string,
    width: number,
    frameColor?: string,
): string[] {
    return safeWrapTextWithAnsi(content, boxInnerWidth(width)).map((line) =>
        boxLine(theme, line, width, frameColor),
    );
}

function boxedTruncatedLine(
    theme: BoxTheme,
    content: string,
    width: number,
    frameColor?: string,
): string {
    return boxLine(
        theme,
        safeTruncateToWidth(content, boxInnerWidth(width), "…"),
        width,
        frameColor,
    );
}

type RenderLinesCache = {
    width: number;
    lines: string[];
};

function pushBoundedLines(target: string[], lines: string[], maxLines: number): boolean {
    const slots = maxLines - target.length;
    if (slots <= 0) return false;
    if (lines.length > slots) {
        target.push(...lines.slice(0, slots));
        return false;
    }
    target.push(...lines);
    return true;
}

function renderBoxedOutputLines(
    theme: BoxTheme,
    outputLines: string[],
    width: number,
    rawLineBudget = DEFAULT_COLLAPSED_RENDER_LINES,
    frameColor?: string,
): string[] {
    const budget = boxedResultRenderBudget(rawLineBudget);
    const headLimit = Math.max(0, Math.min(budget.headLines, budget.maxRenderedLines));
    const tailLimit = Math.max(
        0,
        Math.min(budget.tailLines, Math.max(0, budget.maxRenderedLines - headLimit - 1)),
    );
    const head: string[] = [];
    let nextInputIndex = 0;
    let truncated = false;

    for (; nextInputIndex < outputLines.length; nextInputIndex++) {
        // An output "line" may carry embedded newlines (raw tool error messages,
        // JSON payloads). Split before boxing so every fragment gets its own
        // border and truncation — otherwise the box frame visually breaks on the
        // embedded rows.
        const fragments = (outputLines[nextInputIndex] ?? "").split("\n");
        let headExceeded = false;
        for (const fragment of fragments) {
            const line = boxedTruncatedLine(theme, fragment, width, frameColor);
            if (!pushBoundedLines(head, [line], headLimit)) {
                headExceeded = true;
                break;
            }
        }
        if (headExceeded) {
            truncated = true;
            nextInputIndex++;
            break;
        }
    }

    if (!truncated && nextInputIndex >= outputLines.length) return head;

    const tail: string[] = [];
    const tailStart = Math.max(nextInputIndex, outputLines.length - tailLimit);
    for (let i = tailStart; i < outputLines.length; i++) {
        const fragments = (outputLines[i] ?? "").split("\n");
        for (const fragment of fragments) {
            const line = boxedTruncatedLine(theme, fragment, width, frameColor);
            tail.push(line);
            if (tail.length > tailLimit) tail.splice(0, tail.length - tailLimit);
        }
    }

    const skippedInputLines = Math.max(0, tailStart - nextInputIndex);
    const skippedText =
        skippedInputLines > 0
            ? `… rendered output truncated; ${skippedInputLines} input lines skipped before tail`
            : "… rendered output truncated";
    return [...head, boxLine(theme, theme.fg("muted", skippedText), width, frameColor), ...tail];
}

export function renderBoxedToolCall(
    theme: BoxTheme,
    toolName: string,
    detailLines: string[],
    options: BoxedRenderOptions = {},
): Component {
    let cache: RenderLinesCache | null = null;
    return {
        invalidate() {
            cache = null;
        },
        render(width: number): string[] {
            if (cache?.width === width) return cache.lines;
            const title = formatBoxedToolTitle(
                theme,
                toolName,
                options.isError,
                options.isPending ? (options.running ? "running" : "pending") : undefined,
            );
            const headerDetail =
                typeof options.headerDetail === "function"
                    ? options.headerDetail()
                    : options.headerDetail;
            const headerLabel = headerDetail ? `${title} · ${headerDetail}` : title;
            const renderedWidth = boxWidth(width);
            // A settled call renders its whole frame in the status color.
            const frameColor = boxFrameColor(options.isError, options.isPartial, options.isPending);
            const lines = [
                boxLabeledBorder(
                    theme,
                    BOX_ROUND_TOP_LEFT,
                    BOX_ROUND_TOP_RIGHT,
                    headerLabel,
                    undefined,
                    renderedWidth,
                    frameColor,
                ),
                boxBlankLine(theme, renderedWidth, frameColor),
                ...detailLines.flatMap((line) =>
                    boxedWrappedLines(theme, line, renderedWidth, frameColor),
                ),
            ];
            if (options.isPending && !options.resultSeen) {
                // Pending/running card: close the box with the status label. Once a
                // result renderer has produced a continuation, the box stays open and
                // that continuation closes it.
                const pendingLabel =
                    options.pendingLabel ??
                    theme.fg("dim", `… ${options.pendingText ?? "Waiting for output…"}`);
                lines.push(
                    boxBlankLine(theme, renderedWidth, frameColor),
                    boxLabeledBorder(
                        theme,
                        BOX_ROUND_BOTTOM_LEFT,
                        BOX_ROUND_BOTTOM_RIGHT,
                        pendingLabel,
                        undefined,
                        renderedWidth,
                        frameColor,
                    ),
                );
            } else {
                // Leave the box open with trailing breathing room; the result renderer
                // continues it with the result divider.
                lines.push(boxBlankLine(theme, renderedWidth, frameColor));
            }
            // A rendered call box owns its background (the container fill is
            // neutralized — see tighten/neutralize in features/tools).
            const tinted = applyCardBackground(theme, lines);
            cache = { width, lines: tinted };
            return tinted;
        },
    };
}

const COMPACT_FOOTER_KEY = "__piStyleCompactFooter";
const COMPACT_FOOTER_ERROR_KEY = "__piStyleCompactFooterError";
const COMPACT_FOOTER_PARTIAL_KEY = "__piStyleCompactFooterPartial";

export function clearCompactBoxedFooter(state: Record<string, unknown> | undefined): void {
    if (!state || typeof state !== "object") return;
    delete state[COMPACT_FOOTER_KEY];
    delete state[COMPACT_FOOTER_ERROR_KEY];
    delete state[COMPACT_FOOTER_PARTIAL_KEY];
}

export function renderCompactBoxedToolCall(
    theme: BoxTheme,
    toolName: string,
    detailLine: string,
    options: BoxedRenderOptions = {},
): Component {
    return {
        invalidate() {},
        render(width: number): string[] {
            const renderedWidth = boxWidth(width);
            const title = formatBoxedToolTitle(
                theme,
                toolName,
                options.isError,
                options.isPending ? (options.running ? "running" : "pending") : undefined,
            );
            const headerLabel = detailLine ? `${title} · ${detailLine}` : title;
            const compactFooter =
                typeof options.state?.[COMPACT_FOOTER_KEY] === "string"
                    ? options.state[COMPACT_FOOTER_KEY]
                    : "";
            const bodyLines = options.bodyLines
                ? options.bodyLines(boxInnerWidth(renderedWidth))
                : [];
            const frameColor = boxFrameColor(options.isError, options.isPartial, options.isPending);
            const lines = [
                boxLabeledBorder(
                    theme,
                    BOX_ROUND_TOP_LEFT,
                    BOX_ROUND_TOP_RIGHT,
                    headerLabel,
                    undefined,
                    renderedWidth,
                    frameColor,
                ),
                ...(bodyLines.length > 0
                    ? bodyLines.map((line) => boxLine(theme, line, renderedWidth, frameColor))
                    : [boxBlankLine(theme, renderedWidth, frameColor)]),
            ];
            if (compactFooter) {
                lines.push(
                    boxLabeledBorder(
                        theme,
                        BOX_ROUND_BOTTOM_LEFT,
                        BOX_ROUND_BOTTOM_RIGHT,
                        compactFooter,
                        options.bottomRightLabel,
                        renderedWidth,
                        frameColor,
                    ),
                );
            } else if (options.isPending) {
                const pendingLabel =
                    options.pendingLabel ??
                    (options.running
                        ? formatBoxedRunningStatus(theme, undefined)
                        : theme.fg("dim", `… ${options.pendingText ?? "Waiting for output…"}`));
                lines.push(
                    boxLabeledBorder(
                        theme,
                        BOX_ROUND_BOTTOM_LEFT,
                        BOX_ROUND_BOTTOM_RIGHT,
                        pendingLabel,
                        options.bottomRightLabel,
                        renderedWidth,
                        frameColor,
                    ),
                );
            } else {
                // No footer yet (transient, or the result opens the result divider):
                // leave the box open so the result renderer continues the same box.
            }
            // Compact boxes fill only when the surface is a real framed box (e.g.
            // the write preview) — boxless compact surfaces (quiet-tool rows,
            // tree panels) stay transparent.
            return options.tint ? applyCardBackground(theme, lines) : lines;
        },
    };
}

type BoxedResultBody = Component | ((contentWidth: number) => string[]);

export function renderBoxedToolResult(
    theme: BoxTheme,
    body: BoxedResultBody,
    options: {
        outputLabel?: string;
        footerLines?: string[];
        emptyText?: string;
        widthKey?: string;
        referenceLines?: string[];
        renderLineBudget?: number;
        /** Left-side label embedded in the divider between the call and the result. May be a function of the box width (e.g. for width-dependent layout labels). */
        dividerLabel?: string | ((width: number) => string);
        /** Right-side label embedded in the divider between the call and the result. */
        dividerRightLabel?: string;
        /** Skip the blank line between the divider (or box top) and the body — used
         *  when the enclosing call box already left breathing room, e.g. the
         *  divider-less diff results whose stats live in the box header. */
        skipLeadingBlank?: boolean;
        /** Right-side label embedded in the bottom border (e.g. the expand hint). */
        expandHint?: string;
        isError?: boolean;
        isPartial?: boolean;
        /** Skip the result divider entirely (streaming continuation into an open call box). */
        showDivider?: boolean;
        /** Error state marker prepended to the body (default `✗ Error`). */
        errorLabel?: string;
        /** Tint the result box with the semantic status background. Default on —
         *  every current caller draws a framed box; pass false for a boxless
         *  continuation. */
        tint?: boolean;
    } = {},
): Component {
    let cache: RenderLinesCache | null = null;
    return {
        invalidate() {
            cache = null;
            if (typeof body !== "function") body.invalidate();
        },
        render(width: number): string[] {
            if (cache?.width === width) return cache.lines;
            const renderedWidth = boxWidth(width);
            const maxContentWidth = boxInnerWidth(renderedWidth);
            const bodyLines =
                typeof body === "function" ? body(maxContentWidth) : body.render(maxContentWidth);
            const errorPrefix = options.isError
                ? [theme.fg("error", options.errorLabel ?? "✗ Error")]
                : [];
            const outputLines =
                bodyLines.length > 0
                    ? [...errorPrefix, ...bodyLines]
                    : [theme.fg("muted", `∅ ${options.emptyText ?? "(no output)"}`)];
            // Split embedded newlines before budgeting so raw multi-line messages
            // (tool validation errors, JSON payloads) render as proper bordered
            // rows instead of one "line" whose embedded rows break the frame.
            const outputFragments = outputLines.flatMap((line) => line.split("\n"));
            const footerText = (options.footerLines ?? []).join(" · ");
            // A settled result renders its whole frame in the status color.
            const frameColor = boxFrameColor(options.isError, options.isPartial);
            const dividerText =
                typeof options.dividerLabel === "function"
                    ? options.dividerLabel(renderedWidth)
                    : (options.dividerLabel ?? "Response");
            const rendered = [
                ...(options.showDivider === false
                    ? []
                    : [
                          boxLabeledBorder(
                              theme,
                              BOX_DIVIDER_LEFT,
                              BOX_DIVIDER_RIGHT,
                              theme.fg("warning", dividerText),
                              options.dividerRightLabel
                                  ? theme.fg("dim", options.dividerRightLabel)
                                  : undefined,
                              renderedWidth,
                              frameColor,
                          ),
                      ]),
                ...(options.skipLeadingBlank
                    ? []
                    : [boxBlankLine(theme, renderedWidth, frameColor)]),
                ...renderBoxedOutputLines(
                    theme,
                    outputFragments,
                    renderedWidth,
                    options.renderLineBudget ?? outputFragments.length,
                    frameColor,
                ),
                boxBlankLine(theme, renderedWidth, frameColor),
                boxLabeledBorder(
                    theme,
                    BOX_ROUND_BOTTOM_LEFT,
                    BOX_ROUND_BOTTOM_RIGHT,
                    footerText,
                    options.expandHint ? theme.fg("dim", options.expandHint) : undefined,
                    renderedWidth,
                    frameColor,
                ),
            ];
            // The result box owns its background (the container fill is neutralized).
            const tinted = options.tint === false ? rendered : applyCardBackground(theme, rendered);
            cache = { width, lines: tinted };
            return tinted;
        },
    };
}

export function formatBoxedWallTime(result: MetricResultLike | undefined): string {
    const elapsedMs = getElapsedMs(result);
    return elapsedMs === undefined ? "--" : formatElapsedMs(elapsedMs);
}

export function formatBoxedFooterFromValues(
    theme: BoxTheme,
    elapsedMs: number | undefined,
    output: string,
    extraParts: string[] = [],
): string {
    const elapsedPart =
        elapsedMs === undefined ? theme.fg("dim", "--") : formatElapsedMetric(theme, elapsedMs);
    const extraPartList = extraParts.filter(Boolean).map((part) => theme.fg("dim", part));
    const wordsPart = formatBoxedWords(theme, output);
    return [elapsedPart, ...extraPartList, wordsPart].join(theme.fg("dim", " · "));
}

function formatBoxedFooterParts(
    theme: BoxTheme,
    result: MetricResultLike | undefined,
    extraParts: string[] = [],
    elapsedMs?: number,
): string {
    return formatBoxedFooterFromValues(
        theme,
        elapsedMs ?? getElapsedMs(result),
        getTextOutput(result),
        extraParts,
    );
}

export function formatBoxedFooter(
    theme: BoxTheme,
    result: MetricResultLike | undefined,
    extraParts: string[] = [],
    elapsedMs?: number,
): string {
    return formatBoxedFooterParts(theme, result, extraParts, elapsedMs);
}

export function renderCompactBoxedFooter(
    theme: BoxTheme,
    result: MetricResultLike | undefined,
    options: BoxedRenderOptions = {},
): Component {
    if (options.state && typeof options.state === "object") {
        options.state[COMPACT_FOOTER_KEY] = formatBoxedFooterParts(
            theme,
            result,
            [],
            options.elapsedMs,
        );
        options.state[COMPACT_FOOTER_ERROR_KEY] = Boolean(options.isError);
        options.state[COMPACT_FOOTER_PARTIAL_KEY] = Boolean(options.isPartial);
        return { invalidate() {}, render: () => [] };
    }

    return {
        invalidate() {},
        render(width: number): string[] {
            const renderedWidth = boxWidth(width);
            return [
                boxLabeledBorder(
                    theme,
                    BOX_ROUND_BOTTOM_LEFT,
                    BOX_ROUND_BOTTOM_RIGHT,
                    formatBoxedFooterParts(theme, result, [], options.elapsedMs),
                    undefined,
                    renderedWidth,
                ),
            ];
        },
    };
}

const TOOL_BODY_INDENT = 2;
const TOOL_RIGHT_MARGIN = 1;

export function renderToolCallHeader(
    theme: BoxTheme,
    label: string,
    detail: string,
    skipTextColor?: boolean,
): Component {
    return renderToolCallHeaderLines(theme, label, [parens(theme, detail, skipTextColor)]);
}

export function getToolBodyWidth(width: number, spaces = TOOL_BODY_INDENT): number {
    return Math.max(1, width - spaces - TOOL_RIGHT_MARGIN);
}

export function renderToolCallHeaderLines(
    theme: BoxTheme,
    label: string,
    detailLines: string[],
): Component {
    const prefix = `${badge(theme, label)} `;
    const indent = " ".repeat(safeVisibleWidth(prefix));
    return {
        invalidate() {},
        render(width: number): string[] {
            const bodyWidth = Math.max(1, width - safeVisibleWidth(prefix) - TOOL_RIGHT_MARGIN);
            const output: string[] = [];
            for (let i = 0; i < detailLines.length; i++) {
                const wrapped = safeWrapTextWithAnsi(detailLines[i] ?? "", bodyWidth);
                if (i === 0) {
                    output.push(`${prefix}${wrapped[0] ?? ""}`);
                    output.push(...wrapped.slice(1).map((line) => `${indent}${line}`));
                } else {
                    output.push(...wrapped.map((line) => `${indent}${line}`));
                }
            }
            return output.length > 0 ? output : [prefix.trimEnd()];
        },
    };
}

export function indentToolBody(text: string, spaces = TOOL_BODY_INDENT): string {
    const indent = " ".repeat(spaces);
    return text
        .split("\n")
        .map((line) => (line.length === 0 ? line : `${indent}${line}`))
        .join("\n");
}

export function indentToolBodyLines(lines: string[], spaces = TOOL_BODY_INDENT): string[] {
    const indent = " ".repeat(spaces);
    return lines.map((line) => (line.length === 0 ? line : `${indent}${line}`));
}

export function formatToolOutputLine(
    theme: BoxTheme,
    line: string,
    color: "toolOutput" | "error" | "text" = "toolOutput",
): string {
    if (color === "error") return theme.fg("error", line);

    const clean = stripAnsi(line);
    if (/^##\s/.test(clean)) return theme.fg("muted", line);
    if (/^\?\?\s/.test(clean))
        return theme.bold
            ? theme.bold(theme.fg("syntaxVariable", line))
            : theme.fg("syntaxVariable", line);

    return theme.fg(color, line);
}

export function selectRenderLines(
    text: string,
    maxLines: number,
    tail = false,
): { lines: string[]; omitted: number } {
    const source = text ?? "";
    if (!source) return { lines: [], omitted: 0 };
    const limit = Math.max(0, maxLines);
    const selected: string[] = [];
    let lineCount = 0;
    let lineStart = 0;

    for (let i = 0; i <= source.length; i++) {
        if (i < source.length && source[i] !== "\n") continue;
        const rawLine = source.slice(lineStart, i).replace(/\r/g, "");
        lineCount++;
        if (limit > 0) {
            const line = clampRenderLine(rawLine);
            if (tail) {
                selected.push(line);
                if (selected.length > limit) selected.shift();
            } else if (selected.length < limit) {
                selected.push(line);
            }
        }
        lineStart = i + 1;
    }

    if (selected.length === 1 && selected[0] === "") return { lines: [], omitted: 0 };
    return { lines: selected, omitted: Math.max(0, lineCount - selected.length) };
}

export function renderLines(
    theme: BoxTheme,
    text: string,
    options: { expanded?: boolean },
    cfg: { maxLines: number; tail?: boolean; color?: "toolOutput" | "error"; width?: number } = {
        maxLines: 10,
    },
): string {
    const color = cfg.color ?? "toolOutput";
    const { lines, omitted } = selectRenderLines(text, cfg.maxLines, cfg.tail);
    const renderWidth = cfg.width ? getToolBodyWidth(cfg.width) : undefined;
    const renderLine = (line: string) => {
        const rendered = renderWidth ? safeTruncateToWidth(line, renderWidth, "…") : line;
        return formatToolOutputLine(theme, rendered, color);
    };

    if (lines.length === 0) return "";

    let output = lines.map(renderLine).join("\n");
    if (omitted <= 0) return output;

    const hintText = isExpanded(options)
        ? `... ${omitted} more lines omitted by render budget`
        : `... ${omitted} more lines, press Ctrl+o to expand`;
    const hint = cfg.width
        ? safeTruncateToWidth(hintText, Math.max(1, cfg.width - 1), "…")
        : hintText;
    output += theme.fg("muted", `\n\n${hint}`);

    return output;
}

export function dimWithElapsed(
    theme: BoxTheme,
    summary: string,
    result: MetricResultLike | undefined,
): string {
    const metrics = formatToolMetrics(result);
    return metrics
        ? `${theme.fg("dim", summary)} ${theme.fg("dim", "–")} ${theme.italic ? theme.italic(theme.fg("muted", metrics)) : theme.fg("muted", metrics)}`
        : theme.fg("dim", summary);
}

export function renderToolMetricsFooter(
    theme: BoxTheme,
    _width: number,
    metrics: string,
): string[] {
    return metrics
        ? [
              theme.italic
                  ? theme.italic(theme.fg("muted", `↳ ${metrics}`))
                  : theme.fg("muted", `↳ ${metrics}`),
          ]
        : [];
}

export type { MetricResultLike };
// Re-exported metric helpers so renderers import from a single box module.
export { getElapsedMs };
