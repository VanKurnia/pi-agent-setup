import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "./shared/strip-ansi.js";

type Rgb = [number, number, number];
type StyledPart = {
    raw: string;
    styled: string;
};

type HeaderTheme = {
    fg(name: string, text: string): string;
    bold(text: string): string;
    underline(text: string): string;
};

const ANSI_RESET = "\x1b[0m";

const LOGO_LINES = [
    "████████████╗",
    "████████████║",
    "████╔═══████║",
    "████║   ████║",
    "████████╬═══████╗",
    "████████║   ████║ ",
    "████╔═══╝   ████║",
    "████║       ████║",
    "╚═══╝       ╚═══╝",
];

const TAGLINE_LINE_1 = "There are many agent harnesses,";
const TAGLINE_LINE_2_PREFIX = "but this one is ";
const TAGLINE_LINE_2_HIGHLIGHT = "yours";
const TAGLINE_LINE_2_SUFFIX = ".";

const LOGO_BLOCK_WIDTH = Math.max(...LOGO_LINES.map((line) => [...line].length));

// Official pi brand sections (pi.dev/logo-auto.svg): coral top bar,
// blue body + middle bar, amber right pillar. Fixed hex — same on any theme.
const BRAND_CORAL: Rgb = [240, 144, 130];
const BRAND_BLUE: Rgb = [77, 154, 191];
const BRAND_AMBER: Rgb = [241, 190, 88];

function brandColorForCell(row: number, col: number): Rgb {
    if (row <= 1) return BRAND_CORAL;
    if (row <= 3) return col < 5 ? BRAND_BLUE : BRAND_CORAL;
    return col < 12 ? BRAND_BLUE : BRAND_AMBER;
}

function getVisibleLength(text: string): number {
    return [...stripAnsi(text)].length;
}

function applyTruecolor(rgb: Rgb, text: string): string {
    const [red, green, blue] = rgb;
    return `\x1b[38;2;${red};${green};${blue}m${text}${ANSI_RESET}`;
}

function createCenteredBlockLine(text: string, width: number): string {
    const leftPadding = Math.max(0, Math.floor((width - LOGO_BLOCK_WIDTH) / 2));
    return `${" ".repeat(leftPadding)}${text}`;
}

function createCenteredStyledLine(parts: StyledPart[], width: number): string {
    const rawText = parts.map((part) => part.raw).join("");
    const leftPadding = Math.max(0, Math.floor((width - [...rawText].length) / 2));
    const styledText = parts.map((part) => part.styled).join("");
    return `${" ".repeat(leftPadding)}${styledText}`;
}

function fitLineToWidth(line: string, width: number): string {
    if (getVisibleLength(line) <= width) {
        return line;
    }

    return stripAnsi(line).slice(0, width);
}

function renderLogoLines(width: number): string[] {
    return LOGO_LINES.map((line, rowIndex) => {
        const colored = [...line]
            .map((ch, col) =>
                ch === " " ? ch : applyTruecolor(brandColorForCell(rowIndex, col), ch),
            )
            .join("");
        return createCenteredBlockLine(colored, width);
    });
}

function renderTaglineLines(width: number, theme: HeaderTheme): string[] {
    const line1 = createCenteredStyledLine(
        [{ raw: TAGLINE_LINE_1, styled: theme.fg("text", TAGLINE_LINE_1) }],
        width,
    );

    const line2 = createCenteredStyledLine(
        [
            {
                raw: TAGLINE_LINE_2_PREFIX,
                styled: theme.fg("text", TAGLINE_LINE_2_PREFIX),
            },
            {
                raw: TAGLINE_LINE_2_HIGHLIGHT,
                styled: theme.underline(theme.bold(theme.fg("text", TAGLINE_LINE_2_HIGHLIGHT))),
            },
            {
                raw: TAGLINE_LINE_2_SUFFIX,
                styled: theme.fg("text", TAGLINE_LINE_2_SUFFIX),
            },
        ],
        width,
    );

    return [line1, line2];
}

// Memoized logo lines keyed by width; avoids per-render rebuilds on
// message-hot paths. Logo colors are fixed brand hex (theme-independent).
const logoLinesCache = new Map<string, string[]>();

let promptKind: string | null = null;
let compactFailedReason: string | null = null;

function getCachedLogoLines(width: number): string[] {
    const key = String(width);
    const hit = logoLinesCache.get(key);
    if (hit) return hit;
    const lines = renderLogoLines(width);
    if (logoLinesCache.size >= 20) logoLinesCache.clear();
    logoLinesCache.set(key, lines);
    return lines;
}

function renderHeaderLines(width: number, theme: HeaderTheme): string[] {
    const logoLines = getCachedLogoLines(width);
    const taglineLines = renderTaglineLines(width, theme);

    const baseLines = ["", ...logoLines, "", ...taglineLines, ""].map((line) =>
        fitLineToWidth(line, width),
    );
    const statusLine = (text: string): string =>
        fitLineToWidth(
            createCenteredStyledLine([{ raw: text, styled: theme.fg("warning", text) }], width),
            width,
        );
    const statusLines: string[] = [];
    if (promptKind !== null) {
        statusLines.push(statusLine(`waiting for input: ${promptKind}`));
    }
    if (compactFailedReason !== null) {
        statusLines.push(statusLine(`compaction failed: ${compactFailedReason}`));
    }
    return [...statusLines, ...baseLines];
}

export default function piStartupHeader(pi: ExtensionAPI) {
    pi.on("ui_prompt_start", (e) => {
        promptKind = e.kind;
    });

    pi.on("ui_prompt_end", () => {
        promptKind = null;
    });

    pi.on("session_compact_failed", (event) => {
        compactFailedReason = event.reason;
    });

    pi.on("session_compact", () => {
        compactFailedReason = null;
    });

    pi.on("session_start", async (_event, ctx) => {
        compactFailedReason = null;
        if (!ctx.hasUI) return;

        ctx.ui.setHeader((_tui, theme) => ({
            render(width: number): string[] {
                return renderHeaderLines(width, theme);
            },
            // Drop cached logo lines so a width change renders fresh.
            // (Logo colors are fixed brand hex, theme-independent.)
            invalidate() {
                logoLinesCache.clear();
            },
        }));
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (!ctx.hasUI) return;

        ctx.ui.setHeader(undefined);
    });
}
