import type { ThemeColor, EventBus } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type ThemeLike = {
    fg(color: string, text: string): string;
    bold?: (text: string) => string;
    italic?: (text: string) => string;
    underline?: (text: string) => string;
};
export type { ThemeLike };

export const EDITOR_ACCENT_STYLE = "blue";

export const EDITOR_BORDER_STYLE = "bright-black";

export const MAX_SAFE_SGR_PREFIX_CODE_UNITS = 96;

export const MAX_SAFE_SGR_PREFIX_SEQUENCES = 4;

export type SourceStyleFallback = {
    theme: ColorSpec;
    terminal: ColorSpec;
};

export const EDITOR_ACCENT_FALLBACK: SourceStyleFallback = {
    theme: "accent",
    terminal: EDITOR_ACCENT_STYLE,
};

export const EDITOR_BORDER_FALLBACK: SourceStyleFallback = {
    theme: "borderMuted",
    terminal: EDITOR_BORDER_STYLE,
};

export const EDITOR_SHELL_RAIL_STYLE = "bright-cyan";

export const EDITOR_SHELL_RAIL_FALLBACK: SourceStyleFallback = {
    theme: "bashMode",
    terminal: EDITOR_SHELL_RAIL_STYLE,
};

function isHexColor(value: string): boolean {
    return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function expandHexColor(hex: string): string {
    const body = hex.slice(1);
    if (body.length === 3) {
        return body
            .split("")
            .map((ch) => ch + ch)
            .join("");
    }
    return body;
}

function hexToAnsi(hex: string, isBackground = false): string {
    const normalized = expandHexColor(hex);
    const r = Number.parseInt(normalized.slice(0, 2), 16);
    const g = Number.parseInt(normalized.slice(2, 4), 16);
    const b = Number.parseInt(normalized.slice(4, 6), 16);
    return `\x1b[${isBackground ? 48 : 38};2;${r};${g};${b}m`;
}

const terminalColorCodes = new Map([
    ["black", 30],
    ["red", 31],
    ["green", 32],
    ["yellow", 33],
    ["blue", 34],
    ["purple", 35],
    ["cyan", 36],
    ["white", 37],
    ["bright-black", 90],
    ["bright-red", 91],
    ["bright-green", 92],
    ["bright-yellow", 93],
    ["bright-blue", 94],
    ["bright-purple", 95],
    ["bright-cyan", 96],
    ["bright-white", 97],
]);

const terminalStyleModifiers = new Map([
    ["bold", 1],
    ["dim", 2],
    ["dimmed", 2],
    ["italic", 3],
    ["underline", 4],
]);

const themeColorNameMap = new Map([
    ["red", "error"],
    ["bright-red", "error"],
    ["green", "success"],
    ["bright-green", "success"],
    ["yellow", "warning"],
    ["bright-yellow", "warning"],
    ["blue", "syntaxFunction"],
    ["bright-blue", "syntaxFunction"],
    ["cyan", "syntaxFunction"],
    ["bright-cyan", "syntaxFunction"],
    ["purple", "syntaxKeyword"],
    ["bright-purple", "syntaxKeyword"],
    ["black", "muted"],
    ["bright-black", "muted"],
    ["white", "text"],
    ["bright-white", "text"],
]);

const themeStyleModifiers = new Set(["bold", "italic", "underline"]);

const themeColorTokens = new Set<ThemeColor>([
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "userMessageText",
    "customMessageText",
    "customMessageLabel",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "thinkingMax",
    "bashMode",
]);

function terminalColorToAnsi(color: string, isBackground = false): string | undefined {
    const normalized = color.toLowerCase();
    const colorCode = terminalColorCodes.get(normalized);
    if (colorCode !== undefined) return `${isBackground ? colorCode + 10 : colorCode}`;

    if (/^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(normalized)) {
        return `${isBackground ? 48 : 38};5;${normalized}`;
    }

    if (isHexColor(normalized)) return hexToAnsi(normalized, isBackground).slice(2, -1);
    return undefined;
}

function isExplicitTerminalColorToken(token: string): boolean {
    const normalized = token.toLowerCase();
    if (normalized.startsWith("fg:") || normalized.startsWith("bg:")) return true;
    if (isHexColor(normalized)) return true;
    return /^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(normalized);
}

function isSupportedStyleToken(token: string): boolean {
    const normalized = token.toLowerCase();
    if (terminalStyleModifiers.has(normalized)) return true;
    if (terminalColorToAnsi(normalized) !== undefined) return true;

    const isForeground = normalized.startsWith("fg:");
    const isBackground = normalized.startsWith("bg:");
    if (isForeground || isBackground) {
        return terminalColorToAnsi(normalized.slice(3), isBackground) !== undefined;
    }

    return themeColorTokens.has(token as ThemeColor);
}

export function isSupportedColorSpec(style: ColorSpec): boolean {
    const trimmed = style.trim();
    if (trimmed === "") return true;
    return trimmed.split(/\s+/).every(isSupportedStyleToken);
}

function applyThemeModifiers(theme: ThemeLike, styleTokens: string[], text: string): string {
    let rendered = text;
    for (const token of styleTokens) {
        const normalized = token.toLowerCase();
        if (normalized === "bold") rendered = theme.bold?.(rendered) ?? rendered;
        if (normalized === "italic") rendered = theme.italic?.(rendered) ?? rendered;
        if (normalized === "underline") rendered = theme.underline?.(rendered) ?? rendered;
    }
    return rendered;
}

export function safeThemeFg(theme: ThemeLike, color: string, text: string): string {
    try {
        return theme.fg(color, text);
    } catch {
        return text;
    }
}

function mapThemeColor(styleTokens: string[]): string | undefined {
    let fallback: string | undefined;
    for (const token of styleTokens) {
        const normalized = token.toLowerCase();
        if (themeStyleModifiers.has(normalized)) continue;
        if (normalized === "dim" || normalized === "dimmed") {
            fallback = "muted";
            continue;
        }

        const mapped = themeColorNameMap.get(normalized);
        if (mapped) return mapped;
        return token;
    }
    return fallback;
}

/**
 * Colorize text using a theme color token or hex color.
 * Non-hex values are passed directly to `theme.fg()`; invalid tokens fall back
 * to unstyled text so a config typo does not break rendering.
 */
export function colorize(theme: ThemeLike, color: ColorSpec, text: string): string {
    if (isHexColor(color)) {
        return `${hexToAnsi(color)}${text}\x1b[39m`;
    }
    return safeThemeFg(theme, color, text);
}

/**
 * Render text with Starship-style terminal styling strings (e.g. "bold red", "fg:202",
 * "bg:blue", "underline bg:#bf5700").
 */
function isSafeSgrParameters(parameters: string): boolean {
    const tokens = parameters.split(";");
    if (tokens.some((token) => !/^\d+$/.test(token))) return false;
    const values = tokens.map(Number);
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (
            value === 1 ||
            value === 2 ||
            value === 3 ||
            value === 4 ||
            (value !== undefined && value >= 30 && value <= 37) ||
            (value !== undefined && value >= 40 && value <= 47) ||
            (value !== undefined && value >= 90 && value <= 97) ||
            (value !== undefined && value >= 100 && value <= 107)
        ) {
            continue;
        }
        if (value !== 38 && value !== 48) return false;
        const mode = values[index + 1];
        if (mode === 5) {
            const color = values[index + 2];
            if (color === undefined || color < 0 || color > 255) return false;
            index += 2;
            continue;
        }
        if (mode === 2) {
            const channels = values.slice(index + 2, index + 5);
            if (channels.length !== 3 || channels.some((channel) => channel < 0 || channel > 255)) {
                return false;
            }
            index += 4;
            continue;
        }
        return false;
    }
    return true;
}

/** Accept only the bounded SGR subset emitted by Zentui's supported style tokens. */
export function isSafeSgrStylePrefix(value: unknown): value is string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_SAFE_SGR_PREFIX_CODE_UNITS
    ) {
        return false;
    }
    const sequence = /\x1b\[([0-9]+(?:;[0-9]+)*)m/g;
    let offset = 0;
    let count = 0;
    for (const match of value.matchAll(sequence)) {
        if (match.index !== offset || !isSafeSgrParameters(match[1] ?? "")) return false;
        offset = match.index + match[0].length;
        count += 1;
        if (count > MAX_SAFE_SGR_PREFIX_SEQUENCES) return false;
    }
    return count > 0 && offset === value.length;
}

export function renderTerminalStyle(style: string, text: string): string {
    const codes: string[] = [];
    for (const token of style.trim().split(/\s+/)) {
        if (!token) continue;

        const normalized = token.toLowerCase();
        const modifier = terminalStyleModifiers.get(normalized);
        if (modifier !== undefined) {
            codes.push(`${modifier}`);
            continue;
        }

        const isForeground = normalized.startsWith("fg:");
        const isBackground = normalized.startsWith("bg:");
        const colorName = isForeground || isBackground ? normalized.slice(3) : normalized;
        const color = terminalColorToAnsi(colorName, isBackground);
        if (color) codes.push(color);
    }

    return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
}

/**
 * Apply Starship-style terminal styling first, falling back to Pi theme tokens for
 * legacy config values such as "accent" or "syntaxKeyword".
 */
export function renderStyle(theme: ThemeLike, style: ColorSpec, text: string): string {
    if (style.trim() === "") return text;
    const styled = renderTerminalStyle(style, text);
    return styled === text ? colorize(theme, style, text) : styled;
}

export function renderThemeStyle(theme: ThemeLike, style: ColorSpec, text: string): string {
    const trimmed = style.trim();
    if (trimmed === "") return text;

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.some(isExplicitTerminalColorToken)) return renderTerminalStyle(style, text);

    const color = mapThemeColor(tokens) ?? "text";
    return safeThemeFg(theme, color, applyThemeModifiers(theme, tokens, text));
}

function renderStyleStrict(theme: ThemeLike, style: ColorSpec, text: string): string {
    if (style.trim() === "") return text;
    const styled = renderTerminalStyle(style, text);
    return styled === text ? theme.fg(style, text) : styled;
}

function renderThemeStyleStrict(theme: ThemeLike, style: ColorSpec, text: string): string {
    const trimmed = style.trim();
    if (trimmed === "") return text;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.some(isExplicitTerminalColorToken)) return renderTerminalStyle(style, text);
    const color = mapThemeColor(tokens) ?? "text";
    return theme.fg(color, applyThemeModifiers(theme, tokens, text));
}

export function renderStyleForSource(
    theme: ThemeLike,
    source: ColorSource,
    style: ColorSpec,
    text: string,
): string {
    return source === "terminal"
        ? renderStyle(theme, style, text)
        : renderThemeStyle(theme, style, text);
}

export function renderStyleForSourceOrFallback(
    theme: ThemeLike,
    source: ColorSource,
    style: ColorSpec | undefined,
    fallback: ColorSpec | SourceStyleFallback,
    text: string,
): string {
    const fallbackStyle = typeof fallback === "string" ? fallback : fallback[source];
    return renderStyleForSource(theme, source, style ?? fallbackStyle, text);
}

export function renderStyleForSourceOrFallbackStrict(
    theme: ThemeLike,
    source: ColorSource,
    style: ColorSpec | undefined,
    fallback: ColorSpec | SourceStyleFallback,
    text: string,
): string {
    const fallbackStyle = typeof fallback === "string" ? fallback : fallback[source];
    const resolvedStyle = style ?? fallbackStyle;
    return source === "terminal"
        ? renderStyleStrict(theme, resolvedStyle, text)
        : renderThemeStyleStrict(theme, resolvedStyle, text);
}

export function renderEditorAccent(text: string): string {
    return renderTerminalStyle(EDITOR_ACCENT_STYLE, text);
}

export function renderEditorBorder(text: string): string {
    return renderTerminalStyle(EDITOR_BORDER_STYLE, text);
}

export function renderAccentLine(theme: ThemeLike, source: ColorSource, text: string): string {
    return renderStyleForSourceOrFallback(theme, source, undefined, EDITOR_ACCENT_FALLBACK, text);
}

export function renderChromeBorder(
    theme: ThemeLike,
    source: ColorSource,
    terminalFallbackStyle: ColorSpec,
    text: string,
): string {
    return renderStyleForSourceOrFallback(
        theme,
        source,
        undefined,
        { theme: "borderMuted", terminal: terminalFallbackStyle },
        text,
    );
}

export const componentColorKeys = {
    footer: [
        "prNumber",
        "prUrl",
        "ci",
        "tokenRate",
        "cwd",
        "sessionName",
        "gitBranch",
        "gitStatus",
        "contextNormal",
        "contextWarning",
        "contextError",
        "cost",
        "sessionDuration",
        "tokens",
        "separator",
        "extensionStatus",
        "gitCommit",
        "gitMetricsAdded",
        "gitMetricsDeleted",
        "username",
        "time",
        "os",
    ],
    editor: [
        "prNumber",
        "prUrl",
        "ci",
        "tokenRate",
        "cwd",
        "sessionName",
        "gitBranch",
        "gitStatus",
        "contextNormal",
        "contextWarning",
        "contextError",
        "cacheHit",
        "cost",
        "sessionDuration",
        "accent",
        "border",
        "prompt",
        "rail",
        "shellRail",
        "model",
        "provider",
        "thinking",
        "thinkingMinimal",
        "thinkingLow",
        "thinkingMedium",
        "thinkingHigh",
        "thinkingXhigh",
        "thinkingMax",
    ],
    userMessages: ["accent", "border"],
    selectorBorders: ["border"],
} as const;

export type ColorOwner = keyof typeof componentColorKeys;

export type ComponentColorKey<O extends ColorOwner> = (typeof componentColorKeys)[O][number];

export type ComponentColors<O extends ColorOwner> = Partial<
    Record<ComponentColorKey<O>, ColorSpec>
>;

export function normalizeComponentColors<O extends ColorOwner>(
    owner: O,
    raw: unknown,
): ComponentColors<O> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
        componentColorKeys[owner].flatMap((key) => {
            const value = (raw as Record<string, unknown>)[key];
            return typeof value === "string" && isSupportedColorSpec(value) ? [[key, value]] : [];
        }),
    ) as ComponentColors<O>;
}

const editorLegacyKeys = {
    accent: "editorAccent",
    border: "editorBorder",
    prompt: "editorPrompt",
    rail: "editorRail",
    shellRail: "editorShellRail",
    gitBranch: "editorGitBranch",
    model: "editorModel",
    provider: "editorProvider",
    thinking: "editorThinking",
    thinkingMinimal: "editorThinkingMinimal",
    thinkingLow: "editorThinkingLow",
    thinkingMedium: "editorThinkingMedium",
    thinkingHigh: "editorThinkingHigh",
    thinkingXhigh: "editorThinkingXhigh",
    thinkingMax: "editorThinkingMax",
} as const;

/** Resolve only raw styles. Role-specific chains and selected-source defaults stay with the renderer. */
export function componentColor(
    config: ZentuiConfig,
    owner: "footer",
    key: ComponentColorKey<"footer">,
): string;

export function componentColor(
    config: ZentuiConfig,
    owner: "editor",
    key: Exclude<ComponentColorKey<"editor">, keyof typeof editorLegacyKeys | "cacheHit">,
): string;

export function componentColor<O extends ColorOwner>(
    config: ZentuiConfig,
    owner: O,
    key: ComponentColorKey<O>,
): string | undefined;

export function componentColor<O extends ColorOwner>(
    config: ZentuiConfig,
    owner: O,
    key: ComponentColorKey<O>,
): string | undefined {
    const local = (
        config.components[owner].colors as Partial<Record<string, string>> | undefined
    )?.[key];
    if (typeof local === "string" && isSupportedColorSpec(local)) return local;
    if (owner === "selectorBorders" || ["prNumber", "prUrl", "ci", "tokenRate"].includes(key))
        return undefined;
    const legacy =
        owner === "editor"
            ? (editorLegacyKeys[key as keyof typeof editorLegacyKeys] ?? key)
            : owner === "userMessages"
              ? key === "accent"
                  ? "editorAccent"
                  : "editorBorder"
              : key;
    return config.colors[legacy as keyof PolishedTuiColors];
}

/** Opencode chrome style (rail + model label) while the input is in shell-command mode. */
export function editorShellColor(config: ZentuiConfig): {
    color: ColorSpec | undefined;
    fallback: SourceStyleFallback;
} {
    return {
        color:
            componentColor(config, "editor", "shellRail") ??
            componentColor(config, "editor", "accent"),
        fallback: EDITOR_SHELL_RAIL_FALLBACK,
    };
}

function normalizeStatusWhitespace(value: string): string {
    return value
        .replace(/[\r\n\t\f\v]+/g, " ")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function sanitizeExtensionStatusText(value: string): string {
    return normalizeStatusWhitespace(stripVTControlCharacters(value));
}

function sanitizeExtensionStatusOriginalText(value: string): string {
    // Preserve only SGR and HTTP(S) OSC 8 links. Never pass title/clipboard/cursor controls.
    const marker = `__ZENTUI_${randomUUID()}_`;
    const sequences: Array<{ sequence: string; url: string | undefined }> = [];
    const protectedValue = value.replace(
        /\x1b\[[0-9;:]*m|\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g,
        (sequence, url: string | undefined) =>
            `${marker}${sequences.push({ sequence, url }) - 1}__`,
    );
    const cleaned = normalizeStatusWhitespace(stripVTControlCharacters(protectedValue));
    let activeLink = false;
    const restored = cleaned.replace(new RegExp(`${marker}(\\d+)__`, "g"), (_match, index) => {
        const entry = sequences[Number(index)];
        if (!entry) return "";
        const { sequence, url } = entry;
        if (url === undefined) return sequence;
        const close = activeLink ? "\x1b]8;;\x07" : "";
        activeLink = false;
        if (!url || /[\s\x00-\x1f\x7f-\x9f]/.test(url)) return close;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return close;
            activeLink = true;
            return `${close}\x1b]8;;${parsed.href}\x07`;
        } catch {
            return close;
        }
    });
    const result = restored + (activeLink ? "\x1b]8;;\x07" : "");
    return sanitizeExtensionStatusText(result).length > 0 ? result : "";
}

export const ZENTUI_VARIABLE_CAPABILITY_EVENT = "zentui:variable-capability";

export const ZENTUI_VARIABLE_EVENT = "zentui:variable";

export const ZENTUI_VARIABLE_PROTOCOL_VERSION = 1;

export const MAX_CUSTOM_VARIABLES = 16;

export const MAX_CUSTOM_VARIABLE_KEY_CODE_UNITS = 64;

export const MAX_CUSTOM_VARIABLE_TEXT_CODE_UNITS = 256;

export type CustomVariableCapability = {
    supported: boolean;
    active: boolean;
    key?: string;
    version?: number;
};

export type CustomVariableUpdate = {
    key: string;
    text?: string;
};

export type CustomVariableColorMode = "original" | "zentui";

function isKey(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_CUSTOM_VARIABLE_KEY_CODE_UNITS
    );
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Read data only: publisher getters must not run as part of the protocol. */
function eventField(record: Record<string, unknown>, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor && !("value" in descriptor)) throw new TypeError("Accessor event field");
    return descriptor?.value;
}

function variableUpdate(value: unknown): CustomVariableUpdate | undefined {
    try {
        const record = eventRecord(value);
        if (!record) return undefined;
        const key = eventField(record, "key");
        const text = eventField(record, "text");
        if (!isKey(key)) return undefined;
        if (
            text !== undefined &&
            (typeof text !== "string" || text.length > MAX_CUSTOM_VARIABLE_TEXT_CODE_UNITS)
        )
            return undefined;
        return { key, text: text as string | undefined };
    } catch {
        return undefined;
    }
}

/** Session-scoped, surface-neutral values; keys are package-qualified by publisher convention. */
export class CustomVariables {
    private readonly values = new Map<string, string>();

    constructor(
        events: EventBus | undefined,
        private readonly isActive: (key?: string) => boolean,
        private readonly onChange: () => void,
    ) {
        if (!events) return;
        // Registration lasts for the extension runtime, not an editor factory's lifetime.
        events.on(ZENTUI_VARIABLE_CAPABILITY_EVENT, (value) => {
            try {
                const capability = eventRecord(value);
                if (!capability) return;
                const key = eventField(capability, "key");
                if (key !== undefined && !isKey(key)) return;
                const active = this.isActive(key);
                // Define data properties rather than invoking publisher setters.
                Object.defineProperties(capability, {
                    supported: {
                        value: true,
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    },
                    active: { value: active, writable: true, enumerable: true, configurable: true },
                    version: {
                        value: ZENTUI_VARIABLE_PROTOCOL_VERSION,
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    },
                });
            } catch {
                // Malformed or immutable probes must not break the publisher's event dispatch.
            }
        });
        events.on(ZENTUI_VARIABLE_EVENT, (value) => {
            const update = variableUpdate(value);
            if (!update) return;
            if (update.text === undefined || update.text.length === 0) {
                if (!this.values.delete(update.key)) return;
            } else {
                if (!this.isActive(update.key)) return;
                if (!this.values.has(update.key) && this.values.size >= MAX_CUSTOM_VARIABLES)
                    return;
                if (this.values.get(update.key) === update.text) return;
                this.values.set(update.key, update.text);
            }
            this.onChange();
        });
    }

    /** Detached raw snapshot in locale-independent key order; sanitize only at the consumer. */
    snapshot(): ReadonlyMap<string, string> {
        return new Map(
            [...this.values].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        );
    }

    clear(): void {
        if (this.values.size === 0) return;
        this.values.clear();
        this.onChange();
    }

    /** Evict only keys no longer demanded by any independently owned consumer. */
    reconcile(): void {
        let changed = false;
        for (const key of this.values.keys()) {
            if (!this.isActive(key)) {
                this.values.delete(key);
                changed = true;
            }
        }
        if (changed) this.onChange();
    }
}

/** A safe single-line value, closing publisher links and styles before adjacent frame content. */
export function sanitizeCustomVariableText(
    value: string,
    colorMode: CustomVariableColorMode = "original",
): string {
    if (colorMode === "zentui") return sanitizeExtensionStatusText(value);
    const text = sanitizeExtensionStatusOriginalText(value);
    let lastSgr: string | undefined;
    for (const match of text.matchAll(/\x1b\[[0-9;:]*m/g)) lastSgr = match[0];
    return lastSgr && lastSgr !== "\x1b[0m" && lastSgr !== "\x1b[m" ? `${text}\x1b[0m` : text;
}

export type CustomValueColors = Readonly<Record<string, ColorSpec>>;

// Persistent overrides are independent of the protocol's 16 active values. Reject
// oversized maps as a whole rather than silently retaining an arbitrary subset.
const MAX_CUSTOM_VALUE_COLOR_PROPERTIES = 1024;

const MAX_CUSTOM_VALUE_COLOR_STYLE_CODE_UNITS = 4096;

const excludedKeys = new Set(["__proto__", "constructor", "prototype"]);

function isPublisherKey(key: string): boolean {
    return (
        typeof key === "string" &&
        key.length > 0 &&
        key.length <= MAX_CUSTOM_VARIABLE_KEY_CODE_UNITS &&
        !excludedKeys.has(key) &&
        !/[\s\x00-\x20\x7f-\x9f]/.test(key)
    );
}

function isStyle(value: unknown): value is ColorSpec {
    return (
        typeof value === "string" &&
        value.length <= MAX_CUSTOM_VALUE_COLOR_STYLE_CODE_UNITS &&
        isSupportedColorSpec(value)
    );
}

function emptyColors(): Record<string, ColorSpec> {
    return Object.create(null) as Record<string, ColorSpec>;
}

/** Detached sparse data only; accessors and inherited properties never supply styles. */
export function normalizeCustomValueColors(raw: unknown): CustomValueColors {
    const colors = emptyColors();
    try {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Object.freeze(colors);
        const keys = Reflect.ownKeys(raw);
        if (keys.length > MAX_CUSTOM_VALUE_COLOR_PROPERTIES) return Object.freeze(colors);
        for (const key of keys) {
            if (typeof key !== "string" || !isPublisherKey(key)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(raw, key);
            if (descriptor?.enumerable && "value" in descriptor && isStyle(descriptor.value)) {
                colors[key] = descriptor.value;
            }
        }
        return Object.freeze(colors);
    } catch {
        // Failed reflection (e.g. a revoked Proxy) must not leave a partial palette.
        return Object.freeze(emptyColors());
    }
}

/** Resolve by stable publisher ID, never an alias or prototype lookup. Empty is an override. */
export function customValueColor(
    colors: CustomValueColors | undefined,
    key: string,
): ColorSpec | undefined {
    try {
        if (!colors || typeof colors !== "object" || Array.isArray(colors) || !isPublisherKey(key))
            return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(colors, key);
        return descriptor?.enumerable && "value" in descriptor && isStyle(descriptor.value)
            ? descriptor.value
            : undefined;
    } catch {
        return undefined;
    }
}

export function renderCustomValue(options: {
    key: string;
    raw: string;
    colors?: CustomValueColors;
    mode: CustomVariableColorMode;
    theme: ThemeLike;
    source: ColorSource;
    fallbackStyle: ColorSpec;
}): string {
    const { key, raw, colors, mode, theme, source, fallbackStyle } = options;
    const override = customValueColor(colors, key);
    // An explicit override replaces all publisher SGR and links, including resets.
    const text = sanitizeCustomVariableText(raw, override === undefined ? mode : "zentui");
    if (!text) return "";
    if (override !== undefined) return renderStyleForSource(theme, source, override, text);
    return mode === "zentui" ? renderStyleForSource(theme, source, fallbackStyle, text) : text;
}

/** Owner-local aliases reserve builtins, except the backward-compatible ci alias. */
export function normalizeTemplateVariables(
    value: unknown,
    reserved: readonly string[],
): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const excluded = new Set([
        ...reserved,
        "__proto__",
        "constructor",
        "prototype",
        "fill",
        "wrap",
        "wrap_sep",
        "join_sep",
        "extensions",
    ]);
    return Object.fromEntries(
        Object.entries(value)
            .filter(
                ([name, key]) =>
                    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) &&
                    (!excluded.has(name) || name === "ci") &&
                    typeof key === "string" &&
                    key.length > 0 &&
                    key.length <= MAX_CUSTOM_VARIABLE_KEY_CODE_UNITS &&
                    !/[\s\x00-\x20\x7f-\x9f]/.test(key),
            )
            .slice(0, MAX_CUSTOM_VARIABLES),
    );
}

/** Internal width-equivalent probes survive packing only when a complete value fits.
 * Probes are restored before any terminal output; publisher strings are never parsed as probes.
 */
export class AtomicTemplateValues {
    private readonly values = new Map<string, { marker: string; probe: string; text: string }>();

    constructor(values: ReadonlyMap<string, string>, source: readonly string[]) {
        let candidate = 0xe000;
        const reserved = [...source, ...values.values()].join("");
        for (const [key, text] of values) {
            const width = visibleWidth(text);
            if (!width) continue;
            while (candidate <= 0xf8ff && reserved.includes(String.fromCharCode(candidate)))
                candidate++;
            if (candidate > 0xf8ff) break;
            const marker = String.fromCharCode(candidate++);
            if (visibleWidth(marker) !== 1) continue;
            this.values.set(key, { marker, probe: marker.repeat(width), text });
        }
    }

    resolve(key: string): string {
        return this.values.get(key)?.probe ?? "";
    }

    omitted(source: readonly string[], rows: readonly string[]): string[] {
        const input = source.join("\n");
        const output = rows.join("\n");
        return [...this.values]
            .filter(([, { marker, probe }]) => {
                const expected = input.split(probe).length - 1;
                const actual = output.split(probe).length - 1;
                // Also detect partial values cropped before the final packer source was captured.
                const cells = output.split(marker).length - 1;
                return expected !== actual || cells !== actual * probe.length;
            })
            .map(([key]) => key);
    }

    restore(rows: readonly string[]): string[] {
        return rows.map((row) => {
            for (const { probe, text } of this.values.values()) row = row.replaceAll(probe, text);
            return row;
        });
    }
}
/**
 * Icon mode defaults and resolvers.
 *
 * Nerd defaults must stay byte-identical to historical `defaultConfig.icons`,
 * except where intentionally changed to match the Starship Nerd Font preset.
 * User string overrides always win over mode defaults.
 */

export type IconMode = "auto" | "nerd" | "ascii";

export type EffectiveIconMode = Exclude<IconMode, "auto">;

export type IconEnvironment = Readonly<Record<string, string | undefined>>;

export type IconGlyphs = {
    cwd: string;
    git: string;
    ahead: string;
    behind: string;
    diverged: string;
    conflicted: string;
    untracked: string;
    stashed: string;
    modified: string;
    staged: string;
    renamed: string;
    deleted: string;
    typechanged: string;
    cacheHit: string;
    editorPrompt: string;
    rail: string;
    username: string;
    time: string;
    os: string;
};

export type ResolvedIcons = IconGlyphs & {
    /** Canonical user choice; Auto is never replaced with an environment-specific value. */
    mode: IconMode;
    /** Runtime-only mode derived from the canonical choice and current environment. */
    effectiveMode: EffectiveIconMode;
    /** Runtime-only provenance needed when an override equals the active mode default. */
    osOverridden: boolean;
};

export const ICON_GLYPH_KEYS = [
    "cwd",
    "git",
    "ahead",
    "behind",
    "diverged",
    "conflicted",
    "untracked",
    "stashed",
    "modified",
    "staged",
    "renamed",
    "deleted",
    "typechanged",
    "cacheHit",
    "editorPrompt",
    "rail",
    "username",
    "time",
    "os",
] as const satisfies readonly (keyof IconGlyphs)[];

/**
 * Nerd Font defaults.
 *
 * The `cwd` icon is intentionally empty — Starship's `directory` module
 * has no default symbol. Other defaults match historical values; new
 * additions (e.g. `package`) come from the Starship Nerd Font preset
 * (https://starship.rs/presets/nerd-font).
 */
export const NERD_DEFAULT_ICONS: IconGlyphs = {
    cwd: "",
    git: "",
    ahead: "↑",
    behind: "↓",
    diverged: "⇕",
    conflicted: "=",
    untracked: "?",
    stashed: "$",
    modified: "!",
    staged: "+",
    renamed: "»",
    deleted: "✘",
    typechanged: "T",
    cacheHit: "󰆼",
    editorPrompt: "",
    rail: "│",
    username: "",
    time: "",
    os: "",
};

export const ASCII_DEFAULT_ICONS: IconGlyphs = {
    cwd: "",
    git: "*",
    ahead: "^",
    behind: "v",
    diverged: "^v",
    conflicted: "=",
    untracked: "?",
    stashed: "$",
    modified: "!",
    staged: "+",
    renamed: ">",
    deleted: "x",
    typechanged: "T",
    cacheHit: "c",
    editorPrompt: "",
    rail: "|",
    username: "@",
    time: "t",
    os: "o",
};

export const OS_PLATFORM_ICONS_NERD: Record<string, string> = {
    darwin: "\uf179",
    linux: "\uf17c",
    win32: "\uf17a",
};

export const OS_PLATFORM_ICONS_ASCII: Record<string, string> = {
    darwin: "mac",
    linux: "linux",
    win32: "win",
};

export function isIconMode(value: unknown): value is IconMode {
    return value === "auto" || value === "nerd" || value === "ascii";
}

export function normalizeIconMode(value: unknown): IconMode {
    return isIconMode(value) ? value : "auto";
}

export function detectAutoIconMode(env: IconEnvironment): EffectiveIconMode {
    if (env.ZENTUI_NERD_FONTS === "1") return "nerd";
    if (env.ZENTUI_NERD_FONTS === "0") return "ascii";

    const termProgram = env.TERM_PROGRAM?.toLowerCase();
    if (termProgram === "iterm.app" || termProgram === "wezterm" || termProgram === "ghostty") {
        return "nerd";
    }
    if (env.KITTY_WINDOW_ID?.trim() || env.ALACRITTY_SOCKET?.trim()) return "nerd";
    return "ascii";
}

export function resolveEffectiveIconMode(
    mode: IconMode,
    env: IconEnvironment = process.env,
): EffectiveIconMode {
    return mode === "auto" ? detectAutoIconMode(env) : mode;
}

export function modeDefaultIcons(mode: IconMode, env: IconEnvironment = process.env): IconGlyphs {
    return resolveEffectiveIconMode(mode, env) === "ascii"
        ? { ...ASCII_DEFAULT_ICONS }
        : { ...NERD_DEFAULT_ICONS };
}

export function resolveConfiguredIcons(
    mode: IconMode,
    overrides: Partial<IconGlyphs> = {},
    env: IconEnvironment = process.env,
): ResolvedIcons {
    const effectiveMode = resolveEffectiveIconMode(mode, env);
    const base = modeDefaultIcons(effectiveMode);
    const rail =
        typeof overrides.rail === "string" && overrides.rail.trim().length > 0
            ? overrides.rail
            : base.rail;
    return {
        mode,
        effectiveMode,
        ...base,
        ...overrides,
        rail,
        osOverridden: typeof overrides.os === "string",
    };
}

/** Map the active mode default by platform while preserving explicit `icons.os` overrides. */
export function resolveOsIcon(
    configuredOsIcon: string,
    mode: IconMode = "auto",
    platform: string = process.platform,
    env: IconEnvironment = process.env,
    osOverridden = false,
): string {
    if (osOverridden) return configuredOsIcon;
    const effectiveMode = resolveEffectiveIconMode(mode, env);
    const modeDefault = modeDefaultIcons(effectiveMode).os;
    if (configuredOsIcon !== modeDefault) return configuredOsIcon;
    const platformMap =
        effectiveMode === "ascii" ? OS_PLATFORM_ICONS_ASCII : OS_PLATFORM_ICONS_NERD;
    return platformMap[platform] ?? configuredOsIcon;
}
/** Explicit Zentui template names; host segment IDs are not template aliases. */
export const HOST_TEMPLATE_VARIABLES = [
    "session_id",
    "pr_number",
    "pr_url",
    "ci",
    "subagent_count",
    "token_rate",
    "active_time",
    "hostname",
    "usage_quota",
    "collaboration",
    "stream_state",
    "vim_mode",
    "plan_mode",
    "prewalk_mode",
    "goal_mode",
    "vibe_mode",
    "loop_mode",
] as const;

export type HostTemplateVariable = (typeof HOST_TEMPLATE_VARIABLES)[number];

export type HostTemplateValues = Readonly<Partial<Record<HostTemplateVariable, string>>>;

const names: ReadonlySet<string> = new Set(HOST_TEMPLATE_VARIABLES);

export function isHostTemplateVariable(name: string): name is HostTemplateVariable {
    return names.has(name);
}

/** New roles have no legacy shared-color key; consumers supply their existing safe fallback. */
export function liveMetadataColor(
    config: ZentuiConfig,
    owner: "editor" | "footer",
    name: string,
): string | undefined {
    const role =
        name === "pr_number"
            ? "prNumber"
            : name === "pr_url"
              ? "prUrl"
              : name === "ci"
                ? "ci"
                : name === "token_rate"
                  ? "tokenRate"
                  : undefined;
    return role ? componentColor(config, owner, role) : undefined;
}

export type ColorSpec = string;

export type ColorSource = "theme" | "terminal";

export type ContextStyle = "text" | "gauge" | "text+gauge";

export type SeparatorStyle = "pipe" | "dot" | "chevron" | "none";

export type ModelLabelSource = "id" | "name";

export type EditorStyle = "opencode" | "opencode-copy-friendly";

export type UserMessageStyle = "framed" | "framed-copy-friendly" | "compact" | "labeled";

export type SelectorBorderStyle = "zentui";

export type FooterStyle = "native" | "starship" | "hidden";

export type WorkingLineSpinner =
    | "braille"
    | "star-bloom"
    | "pinwheel"
    | "claude-inspired"
    | "pulse";

export type WorkingLineTextAnimation = "classic" | "kitt" | "disabled";

export type WorkingLinePlacement = "above" | "border";

export type EditorBorderColorMode = "static" | "adaptive";

export type CompletionMenuStyle = "native" | "palette";

export type CompactFooterMaxLines = 1 | 2 | 3 | "unlimited";

export type ExtensionStatusPlacement = "off" | "left" | "middle" | "right";

export type ExtensionStatusColorMode = "zentui" | "original";

export type ExtensionStatusVisibility = "show" | "hide";

export type HiddenExtensionStatusPlacement = "left" | "middle" | "right";

export const DEFAULT_COMPACT_FOOTER_FORMAT =
    "$cwd$wrap(in $session_name)$wrap(on $git_branch) $git_status$wrap$context$wrap_sep$tokens";

export const DEFAULT_EDITOR_METADATA_FORMAT = "$model  $provider(  $thinking)(  $fast_mode)";

export type ContextThresholds = { warning: number; error: number };

export type PathDisplayMode = "basename" | "full" | "repository";

export type PathDisplayConfig = { mode: PathDisplayMode; depth: number };

export type GitBranchMaxLength = "full" | number;

export type GitBranchConfig = { maxLength: GitBranchMaxLength };

export type GitCommitConfig = { hashLength: number; onlyDetached: boolean; showTag: boolean };

export type GitMetricsConfig = { onlyNonzero: boolean; ignoreSubmodules: boolean };

export type ColorSourcesConfig = {
    starship: ColorSource;
    editor: ColorSource;
    userMessages: ColorSource;
};

export type FooterSegmentsConfig = {
    cwd: boolean;
    sessionName: boolean;
    gitBranch: boolean;
    gitStatus: boolean;
    gitCounts: boolean;
    gitCommit: boolean;
    gitMetrics: boolean;
    modelInfo: boolean;
    context: boolean;
    tokens: boolean;
    cost: boolean;
    sessionDuration: boolean;
    username: boolean;
    time: boolean;
    os: boolean;
};

export type TemplateVariableConfig = {
    variables?: Record<string, string>;
    extensionColorMode?: ExtensionStatusColorMode;
};

export const OPENCODE_FORMAT_VARIABLES = [
    "model",
    "model_id",
    "model_name",
    "provider",
    "thinking",
    "fast_mode",
    "session_name",
    "context",
    "tokens",
    "cache_hit",
    "sep",
    "join_sep",
    "separator",
    ...HOST_TEMPLATE_VARIABLES,
] as const;

export type PolishedEditorStyleConfig = TemplateVariableConfig & {
    metadataFormat: string;
    completionMenu: CompletionMenuStyle;
};

export type PolishedCopyFriendlyEditorStyleConfig = PolishedEditorStyleConfig;

export type EditorComponentConfig = {
    colors?: ComponentColors<"editor">;
    customValueColors?: CustomValueColors;
    enabled: boolean;
    rail?: string;
    asciiRail?: string;
    style: EditorStyle;
    colorSource: ColorSource;
    borderColorMode: EditorBorderColorMode;
    modelLabel: ModelLabelSource;
    viewportIndicators: boolean;
    styles: {
        opencode: PolishedEditorStyleConfig;
        "opencode-copy-friendly": PolishedCopyFriendlyEditorStyleConfig;
    };
};

export type UserMessagesComponentConfig = {
    colors?: ComponentColors<"userMessages">;
    enabled: boolean;
    rail?: string;
    asciiRail?: string;
    style: UserMessageStyle;
    colorSource: ColorSource;
    styles: {
        framed: Record<string, never>;
        "framed-copy-friendly": Record<string, never>;
        compact: Record<string, never>;
        labeled: Record<string, never>;
    };
};

export type SelectorBordersComponentConfig = {
    colors?: ComponentColors<"selectorBorders">;
    enabled: boolean;
    style: SelectorBorderStyle;
    colorSource: ColorSource;
};

export type StarshipFooterStyleConfig = TemplateVariableConfig & {
    format: string;
    responsive: boolean;
    compactFormat: string;
    compactMaxLines: CompactFooterMaxLines;
    separator: SeparatorStyle;
    contextStyle: ContextStyle;
    contextThresholds: ContextThresholds;
    pathDisplay: PathDisplayConfig;
    segments: FooterSegmentsConfig;
    gitBranch: GitBranchConfig;
    gitCommit: GitCommitConfig;
    gitMetrics: GitMetricsConfig;
};

export type FooterComponentConfig = {
    colors?: ComponentColors<"footer">;
    customValueColors?: CustomValueColors;
    style: FooterStyle;
    colorSource: ColorSource;
    modelLabel: ModelLabelSource;
    styles: { starship: StarshipFooterStyleConfig };
};

export type ComponentsConfig = {
    editor: EditorComponentConfig;
    userMessages: UserMessagesComponentConfig;
    selectorBorders: SelectorBordersComponentConfig;
    footer: FooterComponentConfig;
};

export type PolishedTuiColors = {
    cwd: ColorSpec;
    sessionName: ColorSpec;
    gitBranch: ColorSpec;
    gitStatus: ColorSpec;
    contextNormal: ColorSpec;
    contextWarning: ColorSpec;
    contextError: ColorSpec;
    tokens: ColorSpec;
    cacheHit?: ColorSpec;
    cost: ColorSpec;
    separator: ColorSpec;
    extensionStatus: ColorSpec;
    sessionDuration: ColorSpec;
    gitCommit: ColorSpec;
    gitMetricsAdded: ColorSpec;
    gitMetricsDeleted: ColorSpec;
    username: ColorSpec;
    time: ColorSpec;
    os: ColorSpec;
    editorAccent?: ColorSpec;
    editorShellRail?: ColorSpec;
    editorRail?: ColorSpec;
    editorPrompt?: ColorSpec;
    editorBorder?: ColorSpec;
    editorGitBranch?: ColorSpec;
    editorModel?: ColorSpec;
    editorProvider?: ColorSpec;
    editorThinking?: ColorSpec;
    editorThinkingMinimal?: ColorSpec;
    editorThinkingLow?: ColorSpec;
    editorThinkingMedium?: ColorSpec;
    editorThinkingHigh?: ColorSpec;
    editorThinkingXhigh?: ColorSpec;
    editorThinkingMax?: ColorSpec;
    workingLineLow?: ColorSpec;
    workingLineMid?: ColorSpec;
    workingLineHigh?: ColorSpec;
};

export type ZentuiConfig = {
    projectRefreshIntervalMs: number;
    icons: ResolvedIcons;
    colors: PolishedTuiColors;
    components: ComponentsConfig;
};

export type PolishedTuiConfig = ZentuiConfig;

export const FOOTER_FORMAT_VARIABLES = [
    "cwd",
    "session_name",
    "git_branch",
    "git_status",
    "git_state",
    "model",
    "provider",
    "thinkingLevel",
    "fast_mode",
    "session_duration",
    "username",
    "os",
    "time",
    "context",
    "tokens",
    "cache_read",
    "cache_write",
    "cost",
    "subscription",
    "auto_compaction",
    "git_commit",
    "git_tag",
    "git_metrics",
    "git_added",
    "git_deleted",
    "sep",
    "join_sep",
    ...HOST_TEMPLATE_VARIABLES,
] as const;

export const FOOTER_FORMAT_ALIASES: Record<string, string> = {
    directory: "cwd",
    branch: "git_branch",
    status: "git_status",
    state: "git_state",
    commit: "git_commit",
    tag: "git_tag",
    duration: "session_duration",
    separator: "sep",
};

export const configPath = join(getAgentDir(), "zentui.json");

const defaultFooterSegments: FooterSegmentsConfig = {
    cwd: true,
    sessionName: true,
    gitBranch: true,
    gitStatus: true,
    gitCounts: false,
    gitCommit: false,
    gitMetrics: false,
    modelInfo: false,
    context: true,
    tokens: true,
    cost: true,
    sessionDuration: false,
    username: false,
    time: false,
    os: false,
};

const defaultStarshipStyle: StarshipFooterStyleConfig = {
    format: "",
    responsive: true,
    compactFormat: DEFAULT_COMPACT_FOOTER_FORMAT,
    compactMaxLines: 2,
    separator: "pipe",
    contextStyle: "text",
    contextThresholds: { warning: 70, error: 90 },
    pathDisplay: { mode: "basename", depth: 0 },
    segments: defaultFooterSegments,
    gitBranch: { maxLength: "full" },
    gitCommit: { hashLength: 7, onlyDetached: true, showTag: true },
    gitMetrics: { onlyNonzero: true, ignoreSubmodules: false },
};

const defaultComponents: ComponentsConfig = {
    editor: {
        enabled: true,
        style: "opencode",
        colorSource: "terminal",
        borderColorMode: "static",
        modelLabel: "id",
        viewportIndicators: true,
        styles: {
            opencode: {
                metadataFormat: DEFAULT_EDITOR_METADATA_FORMAT,
                completionMenu: "palette",
            },
            "opencode-copy-friendly": {
                metadataFormat: DEFAULT_EDITOR_METADATA_FORMAT,
                completionMenu: "palette",
            },
        },
    },
    userMessages: {
        enabled: true,
        style: "framed",
        colorSource: "terminal",
        styles: { framed: {}, "framed-copy-friendly": {}, compact: {}, labeled: {} },
    },
    selectorBorders: { enabled: true, style: "zentui", colorSource: "terminal" },
    footer: {
        style: "starship",
        colorSource: "terminal",
        modelLabel: "id",
        styles: { starship: defaultStarshipStyle },
    },
};

export const defaultConfig: PolishedTuiConfig = {
    projectRefreshIntervalMs: 30_000,
    icons: resolveConfiguredIcons("auto"),
    colors: {
        cwd: "bold cyan",
        sessionName: "bold green",
        gitBranch: "bold purple",
        gitStatus: "bold red",
        contextNormal: "bright-black",
        contextWarning: "bold yellow",
        contextError: "bold red",
        tokens: "bright-black",
        cost: "bold green",
        separator: "bright-black",
        extensionStatus: "bright-black",
        sessionDuration: "yellow",
        gitCommit: "bold green",
        gitMetricsAdded: "bold green",
        gitMetricsDeleted: "bold red",
        username: "bold yellow",
        time: "bold yellow",
        os: "bold white",
    },
    components: defaultComponents,
};

type ConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ConfigRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON values override defaults only where the default already declares that key with the same type. */
function mergeKnown(base: unknown, override: unknown): unknown {
    if (!isRecord(base)) {
        if (typeof base === "string") return typeof override === "string" ? override : base;
        if (typeof base === "boolean") return typeof override === "boolean" ? override : base;
        if (typeof base === "number") {
            return typeof override === "number" && Number.isFinite(override) ? override : base;
        }
        return base;
    }
    if (!isRecord(override)) return base;
    const merged: ConfigRecord = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (key in base) merged[key] = mergeKnown(base[key], value);
    }
    return merged;
}

function readConfig(): ConfigRecord {
    try {
        const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function loadConfig(): PolishedTuiConfig {
    const raw = readConfig();
    const merged = mergeKnown(structuredClone(defaultConfig), raw) as PolishedTuiConfig;
    const iconMode = normalizeIconMode(isRecord(raw.icons) ? raw.icons.mode : undefined);
    merged.icons = resolveConfiguredIcons(iconMode satisfies IconMode);
    return merged;
}

export function ensureConfigExists(): void {
    if (existsSync(configPath)) return;
    try {
        writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
    } catch {
        // A read-only agent directory keeps the in-memory defaults.
    }
}
