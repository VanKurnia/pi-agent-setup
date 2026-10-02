import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripAnsi } from "./shared/strip-ansi.js";

type Rgb = [number, number, number];

type HeaderTheme = {
    fg(name: string, text: string): string;
    bold(text: string): string;
    underline(text: string): string;
};

const ANSI_RESET = "\x1b[0m";

// Official Pi brand colors: coral top bar, blue left pillar, amber right pillar.
const BRAND_CORAL: Rgb = [228, 138, 122];
const BRAND_BLUE: Rgb = [79, 142, 179];
const BRAND_AMBER: Rgb = [234, 182, 93];

const LOGO_BLOCK_WIDTH = 16;

function applyTruecolor([r, g, b]: Rgb, text: string): string {
    return `\x1b[38;2;${r};${g};${b}m${text}${ANSI_RESET}`;
}

const C12 = applyTruecolor(BRAND_CORAL, "████████████");
const C4 = applyTruecolor(BRAND_CORAL, "████");
const B8 = applyTruecolor(BRAND_BLUE, "████████");
const B4 = applyTruecolor(BRAND_BLUE, "████");
const A4 = applyTruecolor(BRAND_AMBER, "████");

const ROW_LINES = [C12, `${B4}    ${C4}`, `${B8}    ${A4}`, `${B4}        ${A4}`];

// Precomputed 8-line logo (4 rows × 2 vertical scale).
const LOGO_LINES = ROW_LINES.flatMap((line) => [line, line]);

function getVisibleLength(text: string): number {
    return [...stripAnsi(text)].length;
}

function centerLine(line: string, width: number): string {
    const padding = " ".repeat(Math.max(0, Math.floor((width - getVisibleLength(line)) / 2)));
    return `${padding}${line}`;
}

function fitLineToWidth(line: string, width: number): string {
    return getVisibleLength(line) <= width ? line : stripAnsi(line).slice(0, width);
}

function renderLogoLines(width: number): string[] {
    const padding = " ".repeat(Math.max(0, Math.floor((width - LOGO_BLOCK_WIDTH) / 2)));
    return LOGO_LINES.map((line) => `${padding}${line}`);
}

function renderTaglineLines(width: number, theme: HeaderTheme): string[] {
    const line1 = theme.fg("text", "There are many agent harnesses,");
    const line2 = `${theme.fg("text", "but this one is ")}${theme.underline(
        theme.bold(theme.fg("text", "yours")),
    )}${theme.fg("text", ".")}`;
    return [centerLine(line1, width), centerLine(line2, width)];
}

let promptKind: string | null = null;
let compactFailedReason: string | null = null;

function createStatusLine(text: string, width: number, theme: HeaderTheme): string {
    return fitLineToWidth(centerLine(theme.fg("warning", text), width), width);
}

function renderHeaderLines(width: number, theme: HeaderTheme): string[] {
    const logoLines = renderLogoLines(width);
    const taglineLines = renderTaglineLines(width, theme);

    const baseLines = ["", ...logoLines, "", ...taglineLines, ""].map((line) =>
        fitLineToWidth(line, width),
    );

    const statusLines: string[] = [];
    if (promptKind !== null) {
        statusLines.push(createStatusLine(`waiting for input: ${promptKind}`, width, theme));
    }
    if (compactFailedReason !== null) {
        statusLines.push(
            createStatusLine(`compaction failed: ${compactFailedReason}`, width, theme),
        );
    }
    return [...statusLines, ...baseLines];
}

type PiAnimationFn = (
    tui: unknown,
    arg2: number | { screen: readonly string[]; logoColumn: number; logoRow: number },
    arg3?: number,
) => void;

let cachedAnimationFn: PiAnimationFn | null | undefined = undefined;

function findAnimationFile(): string | null {
    const searchDirs: string[] = [];
    if (process.argv[1]) {
        const cliDir = path.dirname(path.resolve(process.argv[1]));
        searchDirs.push(cliDir, path.resolve(cliDir, ".."));
    }
    try {
        const resolved = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
        searchDirs.push(path.dirname(resolved));
    } catch {
        /* ignore resolution failure */
    }

    for (const dir of searchDirs) {
        const lazy = path.join(dir, "modes/interactive/components/pi-logo-animation.lazy.js");
        if (fs.existsSync(lazy)) return lazy;

        const chunksDir = path.join(dir, "chunks");
        if (fs.existsSync(chunksDir)) {
            const chunk = fs
                .readdirSync(chunksDir)
                .find((f) => f.startsWith("pi-logo-animation") && f.endsWith(".js"));
            if (chunk) return path.join(chunksDir, chunk);
        }

        const bundleChunks = path.join(dir, "bundle/chunks");
        if (fs.existsSync(bundleChunks)) {
            const chunk = fs
                .readdirSync(bundleChunks)
                .find((f) => f.startsWith("pi-logo-animation") && f.endsWith(".js"));
            if (chunk) return path.join(bundleChunks, chunk);
        }
    }
    return null;
}

async function loadAnimationFn(): Promise<PiAnimationFn | null> {
    if (cachedAnimationFn !== undefined) {
        return cachedAnimationFn;
    }

    const file = findAnimationFile();
    if (!file) {
        cachedAnimationFn = null;
        return null;
    }

    try {
        const mod = (await import(pathToFileURL(file).href)) as {
            playPiLogoAnimation?: PiAnimationFn;
        };
        cachedAnimationFn = mod.playPiLogoAnimation ?? null;
    } catch {
        cachedAnimationFn = null;
    }

    return cachedAnimationFn;
}

function playEasterEggAnimation(tui: TUI, logoColumn: number, logoRow: number): void {
    void (async () => {
        try {
            const fn = await loadAnimationFn();
            if (!fn) return;

            const anyTui = tui as unknown as {
                hasOverlay?(): boolean;
                getScreenLines?(): string[];
            };
            if (anyTui.hasOverlay?.()) return;

            if (fn.length >= 3) {
                fn(tui, logoColumn, logoRow);
            } else {
                fn(tui, {
                    screen: anyTui.getScreenLines?.() ?? [],
                    logoColumn,
                    logoRow,
                });
            }
        } catch {
            // Silently ignore animation failures
        }
    })();
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

        void loadAnimationFn();

        ctx.ui.setHeader((tui, theme) => ({
            render(width: number): string[] {
                return renderHeaderLines(width, theme);
            },
            invalidate() {},
            handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
                if (
                    event.type !== "click" ||
                    (event.button !== "left" && event.button !== undefined)
                ) {
                    return undefined;
                }

                const statusCount =
                    (promptKind !== null ? 1 : 0) + (compactFailedReason !== null ? 1 : 0);
                const logoTop = statusCount + 1;
                const logoBottom = logoTop + LOGO_LINES.length;
                const logoLeft = Math.max(0, Math.floor((event.width - LOGO_BLOCK_WIDTH) / 2));
                const logoRight = logoLeft + LOGO_BLOCK_WIDTH;

                if (
                    event.y >= logoTop &&
                    event.y < logoBottom &&
                    event.x >= logoLeft &&
                    event.x < logoRight
                ) {
                    const compScreenX = event.screenX - event.x;
                    const compScreenY = event.screenY - event.y;
                    const logoScreenX = compScreenX + logoLeft;
                    const logoScreenY = compScreenY + logoTop;

                    // Center offset: (16/2 - 2 = 6, 8/2 - 1 = 3) to match built-in animation center.
                    const animCol = logoScreenX + 6;
                    const animRow = logoScreenY + 3;

                    playEasterEggAnimation(tui, animCol, animRow);
                    return { handled: true };
                }

                return undefined;
            },
        }));
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (!ctx.hasUI) return;

        ctx.ui.setHeader(undefined);
    });
}
