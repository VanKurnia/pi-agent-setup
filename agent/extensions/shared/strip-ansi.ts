import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * Remove ANSI, OSC and APC sequences while preserving visible text. C1 CSI is
 * re-encoded as ESC so pi-tui's parser sees it, and the sequence parser itself
 * stays in pi-tui instead of a local regex.
 */
export function stripAnsi(text: string): string {
    return stripTerminalSequences(text.replace(/\u009b/g, "\x1b["));
}
