/**
 * Shared row primitives used by the status widgets (palette, spinner, duration).
 */

import { formatDuration } from "./text-format.js";

/** Minimal ANSI palette — widget strings render verbatim, no theme access here. */
const ANSI = {
    reset: "\x1b[0m",
    bold: "1",
    dim: "2",
    cyan: "36",
    green: "32",
    red: "31",
    yellow: "33",
    blue: "34",
};
const styled = (code: string, text: string): string => `\x1b[${code}m${text}${ANSI.reset}`;
const DOT = styled(ANSI.dim, "·");

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Repaint cadence while runs are live — decoupled from progress events so the
// spinner and timers keep moving through long silent model streams.
const TICK_MS = 150;

/** Duration with yellow numbers and blue units (e.g. 16.9s, 42ms, 1m5s). */
function styledDuration(ms: number): string {
    return formatDuration(ms).replace(
        /(\d+(?:\.\d+)?)(ms|s|m)/g,
        (_, num, unit) => `${styled(ANSI.yellow, num)}${styled(ANSI.blue, unit)}`,
    );
}

export { ANSI, styled, DOT, SPINNER, TICK_MS, styledDuration };
