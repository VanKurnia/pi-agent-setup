/** Shared path helpers for session-mgr commands. */

import { homedir } from "node:os";

/** Case-insensitive, slash-normalized — for comparing cwds across platforms. */
export function normalizeDir(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
}

/** Collapse the home directory to ~/ for display. */
export function shortenHome(p: string): string {
    const home = homedir().replace(/\\/g, "/");
    const normalized = p.replace(/\\/g, "/");
    return normalized.startsWith(home) ? `~${normalized.slice(home.length)}` : p;
}
