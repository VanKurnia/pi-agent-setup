/**
 * Workdir — jump back to previous working directories.
 *
 * Registers:
 *   /workdir — bottom-docked, searchable list of distinct cwds seen in
 *              <agentDir>/sessions (+ trusted projects from trust.json).
 *              Selecting one starts a FRESH session there (like /new): the
 *              newest abandoned header-only file is reused when present,
 *              else a header-only session file is created and switched to.
 *
 * Session folders are cwd-encoded but lossy, so the true cwd is read from
 * each session file's first line (SessionHeader.cwd) instead of decoding
 * the folder name.
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
    fileStamp,
    listSessionFiles,
    parseSessionHeader,
    readFileHead,
    readSessionCwd,
    sessionFolder,
} from "./helpers/sessions.js";
import { normalizeDir, shortenHome } from "./helpers/paths.js";
import { showPicker } from "./helpers/picker.js";

interface WorkdirEntry {
    cwd: string;
    sessions: number;
    lastActive: number;
    trustedOnly: boolean;
}

function collectWorkdirs(agentDir: string): WorkdirEntry[] {
    const byCwd = new Map<string, WorkdirEntry>();
    const sessionsRoot = join(agentDir, "sessions");
    let folders: string[] = [];
    try {
        folders = readdirSync(sessionsRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    } catch {
        /* first run — no sessions directory yet */
    }
    for (const folder of folders) {
        const dir = join(sessionsRoot, folder);
        const files = listSessionFiles(dir);
        if (files.length === 0) continue;
        const newest = join(dir, files[0]);
        const cwd = readSessionCwd(newest);
        if (!cwd) continue;
        let lastActive = 0;
        try {
            lastActive = statSync(newest).mtimeMs;
        } catch {
            /* keep 0 — unsortable entries sink to the bottom */
        }
        byCwd.set(cwd, { cwd, sessions: files.length, lastActive, trustedOnly: false });
    }
    try {
        const trust = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8")) as Record<
            string,
            unknown
        >;
        for (const [cwd, allowed] of Object.entries(trust)) {
            if (allowed && !byCwd.has(cwd)) {
                byCwd.set(cwd, { cwd, sessions: 0, lastActive: 0, trustedOnly: true });
            }
        }
    } catch {
        /* trust.json missing or unreadable — sessions alone are enough */
    }
    return [...byCwd.values()].sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * A pending-fresh file: exactly one non-empty line, a session header for
 * this cwd, nothing else. Reusing it is identical to creating one, so at
 * most one abandoned fresh file accumulates per directory no matter how
 * often /workdir targets it without a prompt. Newest first.
 */
function findPendingFreshFile(agentDir: string, cwd: string): string | undefined {
    const wanted = normalizeDir(resolve(cwd));
    const dir = sessionFolder(agentDir, cwd);
    for (const f of listSessionFiles(dir)) {
        const filePath = join(dir, f);
        const lines = (readFileHead(filePath) ?? "").split("\n").filter((l) => l.trim());
        if (lines.length !== 1) continue;
        const header = parseSessionHeader(lines[0]);
        if (header && normalizeDir(header.cwd) === wanted) return filePath;
    }
    return undefined;
}

/**
 * Create a fresh (history-empty) session file rooted at cwd and return its
 * path. Switching to it behaves exactly like /new, but in that directory:
 * SessionManager.open reads the cwd from this header.
 */
function freshSessionFile(agentDir: string, cwd: string): string {
    const resolved = resolve(cwd);
    const dir = sessionFolder(agentDir, resolved);
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id,
        timestamp,
        cwd: resolved,
    };
    const filePath = join(dir, `${fileStamp(timestamp)}_${id}.jsonl`);
    writeFileSync(filePath, `${JSON.stringify(header)}\n`, "utf-8");
    return filePath;
}

function describe(entry: WorkdirEntry): string {
    if (entry.trustedOnly) return "trusted · no sessions yet";
    const date = entry.lastActive ? new Date(entry.lastActive).toLocaleDateString() : "unknown";
    return `${entry.sessions} session${entry.sessions === 1 ? "" : "s"} · ${date}`;
}

interface WorkdirNode {
    entry: WorkdirEntry;
    children: WorkdirNode[];
}

/** Longest listed ancestor of cwd — drives nesting. Roots have none. */
function findParent(cwd: string, candidates: WorkdirEntry[]): WorkdirEntry | undefined {
    const norm = normalizeDir(cwd);
    let best: WorkdirEntry | undefined;
    let bestLen = -1;
    for (const c of candidates) {
        if (c.cwd === cwd) continue;
        const n = normalizeDir(c.cwd);
        if (n.length < norm.length && norm.startsWith(`${n}/`) && n.length > bestLen) {
            best = c;
            bestLen = n.length;
        }
    }
    return best;
}

function subtreeLatest(node: WorkdirNode): number {
    let latest = node.entry.lastActive;
    for (const child of node.children) latest = Math.max(latest, subtreeLatest(child));
    return latest;
}

function buildForest(entries: WorkdirEntry[]): WorkdirNode[] {
    const nodes = new Map<string, WorkdirNode>();
    for (const e of entries) nodes.set(e.cwd, { entry: e, children: [] });
    const roots: WorkdirNode[] = [];
    for (const node of nodes.values()) {
        const parent = findParent(node.entry.cwd, entries);
        const parentNode = parent && nodes.get(parent.cwd);
        if (parentNode) parentNode.children.push(node);
        else roots.push(node);
    }
    const byRecent = (a: WorkdirNode, b: WorkdirNode) => subtreeLatest(b) - subtreeLatest(a);
    roots.sort(byRecent);
    for (const n of nodes.values()) n.children.sort(byRecent);
    return roots;
}

/** Remainder of cwd below its parent. Roots render the full path instead. */
function displayName(cwd: string, parentCwd: string): string {
    return cwd.slice(normalizeDir(parentCwd).length + 1);
}

/** Guides are pre-colored: SelectList renders labels verbatim, so structural
 * chrome is styled here while names keep the default text color. */
function flattenForest(
    roots: WorkdirNode[],
    guide: (text: string) => string,
): { entry: WorkdirEntry; label: string }[] {
    const rows: { entry: WorkdirEntry; label: string }[] = [];
    const walkChildren = (node: WorkdirNode, base: string) => {
        node.children.forEach((child, i) => {
            const last = i === node.children.length - 1;
            rows.push({
                entry: child.entry,
                label: `${base}${guide(last ? "└─ " : "├─ ")}${displayName(child.entry.cwd, node.entry.cwd)}`,
            });
            walkChildren(child, base + (last ? "  " : guide("│ ")));
        });
    };
    for (const r of roots) {
        rows.push({ entry: r.entry, label: shortenHome(r.entry.cwd) });
        walkChildren(r, "");
    }
    return rows;
}

export function registerWorkdir(pi: ExtensionAPI): void {
    pi.registerCommand("workdir", {
        description: "Jump back to a previous working directory (searchable)",
        handler: async (_args: string, ctx: ExtensionCommandContext) => {
            const agentDir = getAgentDir();
            const entries = collectWorkdirs(agentDir).filter((e) => e.cwd !== ctx.cwd);
            if (entries.length === 0) {
                ctx.ui.notify("No previous workdirs found", "info");
                return;
            }
            const dirPicked = await showPicker(
                ctx,
                "Back to workdir:",
                "type to filter • ↑↓ navigate • enter select • esc close",
                (theme) => {
                    const guide = (s: string) => theme.fg("dim", s);
                    return flattenForest(buildForest(entries), guide).map((r) => ({
                        value: r.entry.cwd,
                        label: r.label,
                        description: describe(r.entry),
                    }));
                },
            );
            if (!dirPicked) return;
            const entry = entries.find((e) => e.cwd === dirPicked);
            if (!entry) return;
            if (!existsSync(entry.cwd)) {
                ctx.ui.notify(`${dirPicked} no longer exists on disk`, "warning");
                return;
            }
            const target =
                findPendingFreshFile(agentDir, entry.cwd) ?? freshSessionFile(agentDir, entry.cwd);
            // Post-switch work must use the replacement ctx, not this stale one.
            await ctx.switchSession(target, {
                withSession: async (newCtx) => {
                    newCtx.ui.notify(`✓ New session started in ${shortenHome(entry.cwd)}`, "info");
                },
            });
        },
    });
}
