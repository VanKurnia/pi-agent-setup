/**
 * Shared text-formatting and path helpers used across extensions.
 */

import { homedir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Replace the user's home directory prefix with `~`, normalizing separators. */
export function shortenHome(p: string): string {
    const home = homedir().replace(/\\/g, "/");
    const normalized = p.replace(/\\/g, "/");
    return normalized.startsWith(home) ? `~${normalized.slice(home.length)}` : p;
}

/** Normalize a directory path for case-insensitive prefix comparison (Windows). */
export function normalizeDir(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export function truncLine(text: string, maxWidth: number): string {
    if (visibleWidth(text) <= maxWidth) return text;
    let result = "";
    let width = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        // Skip ANSI escape sequences — zero visible width
        if (ch === "\x1b") {
            const rest = text.slice(i);
            const match = rest.match(/^\x1b\[[0-9;]*m/);
            if (match) {
                result += match[0];
                i += match[0].length - 1;
                continue;
            }
        }
        if (width >= maxWidth - 1) {
            return result + "…";
        }
        result += ch;
        width++;
    }
    return result;
}
