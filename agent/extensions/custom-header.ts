import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

function centerLine(line: string, width: number): string {
    const padding = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(line)) / 2)));
    return `${padding}${line}`;
}

function fitLineToWidth(line: string, width: number): string {
    return visibleWidth(line) <= width ? line : truncateToWidth(line, width);
}

function renderLogoLines(width: number): string[] {
    const padding = " ".repeat(Math.max(0, Math.floor((width - LOGO_BLOCK_WIDTH) / 2)));
    return LOGO_LINES.map((line) => `${padding}${line}`);
}

const WHIMSICAL_WORDS = ["yours", "mine", "ours"] as const;
const WHIMSICAL_INTERVAL_MS = 1500;
const TAGLINE_HEAD = applyTruecolor(BRAND_BLUE, "There are many agent harnesses,");
const TAGLINE_PREFIX = applyTruecolor(BRAND_AMBER, "but this one is ");
const TAGLINE_SUFFIX = applyTruecolor(BRAND_AMBER, ".");

let whimsicalWordIndex = 0;
let whimsicalTimer: ReturnType<typeof setInterval> | undefined;

function stopWhimsicalTimer(): void {
    if (whimsicalTimer !== undefined) {
        clearInterval(whimsicalTimer);
        whimsicalTimer = undefined;
    }
}

function renderTaglineLines(width: number, theme: HeaderTheme): string[] {
    const word = WHIMSICAL_WORDS[whimsicalWordIndex] ?? "yours";
    const line2 = `${TAGLINE_PREFIX}${theme.underline(
        theme.bold(applyTruecolor(BRAND_CORAL, word)),
    )}${TAGLINE_SUFFIX}`;
    return [centerLine(TAGLINE_HEAD, width), centerLine(line2, width)];
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

type EasterEggRunner = (tui: TUI, column: number, row: number) => Promise<void> | void;

let cachedRunner: EasterEggRunner | null | undefined = undefined;

const CHUNK_PREFIXES = ["easter-egg-3d", "pi-logo-animation"] as const;

const DIRECT_TARGETS = [
    "modes/interactive/components/easter-egg-3d.js",
    "modes/interactive/components/easter-egg-3d.lazy.js",
    "modes/interactive/components/pi-logo-animation.lazy.js",
] as const;

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
        // Bundled chunks are checked first so we connect to the active host bundle graph.
        for (const chunksDir of [path.join(dir, "chunks"), path.join(dir, "bundle/chunks")]) {
            if (!fs.existsSync(chunksDir)) continue;
            for (const prefix of CHUNK_PREFIXES) {
                const chunk = fs
                    .readdirSync(chunksDir)
                    .find((f) => f.startsWith(prefix) && f.endsWith(".js"));
                if (chunk) return path.join(chunksDir, chunk);
            }
        }

        for (const target of DIRECT_TARGETS) {
            const file = path.join(dir, target);
            if (fs.existsSync(file)) return file;
        }
    }
    return null;
}

function getScreenLines(tui: TUI): readonly string[] {
    return "getScreenLines" in tui && typeof tui.getScreenLines === "function"
        ? (tui.getScreenLines() as string[])
        : [];
}

async function loadAnimationRunner(): Promise<EasterEggRunner | null> {
    if (cachedRunner !== undefined) {
        return cachedRunner;
    }

    const file = findAnimationFile();
    if (!file) {
        cachedRunner = null;
        return null;
    }

    try {
        const mod = (await import(pathToFileURL(file).href)) as {
            playEasterEgg3d?: (
                tui: unknown,
                screen: readonly string[],
                egg: { kind: "pi-logo"; column: number; row: number },
            ) => Promise<void>;
            playPiLogo3d?: (tui: unknown, column: number, row: number) => void;
            playPiLogoAnimation?: (
                tui: unknown,
                arg2: number | { screen: readonly string[]; logoColumn: number; logoRow: number },
                arg3?: number,
            ) => void;
        };

        if (typeof mod.playEasterEgg3d === "function") {
            const playFn = mod.playEasterEgg3d;
            cachedRunner = (tui, col, row) =>
                playFn(tui, getScreenLines(tui), { kind: "pi-logo", column: col, row: row });
        } else if (typeof mod.playPiLogo3d === "function") {
            const playFn = mod.playPiLogo3d;
            cachedRunner = (tui, col, row) => playFn(tui, col, row);
        } else if (typeof mod.playPiLogoAnimation === "function") {
            const playFn = mod.playPiLogoAnimation;
            cachedRunner = (tui, col, row) =>
                playFn.length >= 3
                    ? playFn(tui, col, row)
                    : playFn(tui, {
                          screen: getScreenLines(tui),
                          logoColumn: col,
                          logoRow: row,
                      });
        } else {
            cachedRunner = null;
        }
    } catch {
        cachedRunner = null;
    }

    return cachedRunner;
}

function playEasterEggAnimation(tui: TUI, logoColumn: number, logoRow: number): void {
    void (async () => {
        try {
            if (tui.hasOverlay()) return;

            const runner = await loadAnimationRunner();
            if (!runner) return;

            await runner(tui, logoColumn, logoRow);
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

        void loadAnimationRunner();

        ctx.ui.setHeader((tui, theme) => {
            stopWhimsicalTimer();
            whimsicalTimer = setInterval(() => {
                whimsicalWordIndex = (whimsicalWordIndex + 1) % WHIMSICAL_WORDS.length;
                tui.requestRender();
            }, WHIMSICAL_INTERVAL_MS);

            return {
                render(width: number): string[] {
                    return renderHeaderLines(width, theme);
                },
                invalidate() {},
                dispose() {
                    stopWhimsicalTimer();
                },
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
            };
        });
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        stopWhimsicalTimer();
        if (!ctx.hasUI) return;

        ctx.ui.setHeader(undefined);
    });
}
