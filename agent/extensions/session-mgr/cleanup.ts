/** Session cleanup: candidate scan + age display (pure helpers, no UI). */

import {
    closeSync,
    fstatSync,
    openSync,
    readSync,
    readdirSync,
    rmdirSync,
    statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeDir, shortenHome } from "./helpers/paths.js";
import { loadCleanupSettings, saveCleanupSettings } from "./helpers/cleanup-settings.js";
import { showPicker } from "./helpers/picker.js";
import {
    listSessionFiles,
    parseSessionHeader,
    readFileHead,
    readSessionCwd,
} from "./helpers/sessions.js";
import { trashSessionFile } from "./helpers/trash.js";

export interface CleanupCandidate {
    file: string;
    folder: string;
    cwd: string;
    name: string;
    mtimeMs: number;
    ageDays: number;
    sizeBytes: number;
}

const TAIL_SCAN_BYTES = 32768;

/** Last `session_info` name in the file tail; falls back to header id / basename. */
function readSessionName(filePath: string): string {
    const fallback =
        parseSessionHeader(readFileHead(filePath)?.split("\n")[0])?.id.slice(0, 8) ??
        basename(filePath);
    let fd = -1;
    try {
        fd = openSync(filePath, "r");
        const size = fstatSync(fd).size;
        const length = Math.min(size, TAIL_SCAN_BYTES);
        if (length <= 0) return fallback;
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, Math.max(0, size - length));
        const lines = buf.toString("utf-8").split("\n");
        // Drop the first chunk line: it may be a partial mid-line read.
        const rest = lines.slice(1).reverse();
        for (const line of rest) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
                const entry = JSON.parse(trimmed) as Record<string, unknown>;
                if (entry["type"] === "session_info" && typeof entry["name"] === "string") {
                    return entry["name"];
                }
            } catch {
                continue;
            }
        }
        return fallback;
    } catch {
        return fallback;
    } finally {
        if (fd !== -1) {
            try {
                closeSync(fd);
            } catch {
                // Ignore close errors; the read result (or fallback) stands.
            }
        }
    }
}

/**
 * Sessions older than `thresholdDays` (by file mtime), newest-first.
 * Skips `sessions/.trash/` and the excluded (current session) file.
 * Never throws — unreadable roots/folders/files are skipped.
 */
export function collectCleanupCandidates(
    agentDir: string,
    thresholdDays: number,
    excludeFile?: string,
): CleanupCandidate[] {
    if (!(thresholdDays > 0)) return [];
    const candidates: CleanupCandidate[] = [];
    let entries;
    try {
        entries = readdirSync(join(agentDir, "sessions"), { withFileTypes: true });
    } catch {
        return [];
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".trash") continue;
        const dir = join(agentDir, "sessions", entry.name);
        for (const fileName of listSessionFiles(dir)) {
            try {
                const file = join(dir, fileName);
                if (excludeFile && normalizeDir(file) === normalizeDir(excludeFile)) continue;
                const stat = statSync(file);
                const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
                if (!(ageDays > thresholdDays)) continue;
                candidates.push({
                    file,
                    folder: dir,
                    cwd: readSessionCwd(file) ?? "(unknown)",
                    name: readSessionName(file),
                    mtimeMs: stat.mtimeMs,
                    ageDays,
                    sizeBytes: stat.size,
                });
            } catch {
                continue;
            }
        }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates;
}

/** Compact age display: 45.2 → "45d", 0.5 → "12h", 0.01 → "14m" (min 1m). */
export function formatAge(days: number): string {
    if (days >= 1) return `${Math.floor(days)}d`;
    if (days >= 1 / 24) return `${Math.floor(days * 24)}h`;
    return `${Math.max(1, Math.floor(days * 1440))}m`;
}

/**
 * Remove session subfolders left with zero `*.jsonl` files. Never recursive,
 * never touches `.trash/`. Per-folder try/catch: ignores ENOTEMPTY/EPERM and
 * races with other pi instances. Never throws.
 */
export function sweepEmptySessionFolders(agentDir: string): void {
    let entries;
    try {
        entries = readdirSync(join(agentDir, "sessions"), { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".trash") continue;
        const dir = join(agentDir, "sessions", entry.name);
        try {
            if (listSessionFiles(dir).length === 0) rmdirSync(dir);
        } catch {
            continue;
        }
    }
}

/** Trash a file list with no UI access (callers own all notify calls). */
async function trashCandidates(
    agentDir: string,
    files: string[],
): Promise<{ os: number; local: number; failed: { file: string; error: string }[] }> {
    const result: {
        os: number;
        local: number;
        failed: { file: string; error: string }[];
    } = { os: 0, local: 0, failed: [] };
    for (const file of files) {
        const trashed = trashSessionFile(agentDir, file);
        if (trashed.kind === "os") result.os += 1;
        else if (trashed.kind === "local") result.local += 1;
        else result.failed.push({ file, error: trashed.error });
    }
    return result;
}

function parseThresholdInput(raw: string): number | undefined {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0 || n > 3650) return undefined;
    return n;
}

async function editThreshold(ctx: ExtensionCommandContext, current: number): Promise<void> {
    const prompt = "Auto clean threshold (days, 0 = off)";
    let raw = await ctx.ui.input(prompt, String(current));
    if (raw === undefined) return;
    let n = parseThresholdInput(raw);
    if (n === undefined) {
        ctx.ui.notify("Enter a whole number 0–3650", "warning");
        raw = await ctx.ui.input(prompt, String(current));
        if (raw === undefined) return;
        n = parseThresholdInput(raw);
        if (n === undefined) return;
    }
    const prev = loadCleanupSettings();
    saveCleanupSettings({ ...prev, autoCleanThresholdDays: n });
    ctx.ui.notify(`Auto clean threshold set to ${n}d`, "info");
}

async function cleanNow(
    agentDir: string,
    ctx: ExtensionCommandContext,
    thresholdDays: number,
): Promise<void> {
    const list = collectCleanupCandidates(
        agentDir,
        thresholdDays,
        ctx.sessionManager.getSessionFile(),
    );
    if (list.length === 0) {
        ctx.ui.notify(`No sessions older than ${thresholdDays}d`, "info");
        return;
    }
    const oldest = Math.max(...list.map((c) => c.ageDays));
    const mb = (list.reduce((sum, c) => sum + c.sizeBytes, 0) / 1048576).toFixed(1);
    const lines = [
        `Oldest ${formatAge(oldest)} · total ${mb} MB · goes to OS Recycle Bin (fallback sessions/.trash). Current session excluded.`,
        ...list
            .slice(0, 8)
            .map((c) => `• ${c.name} · ${formatAge(c.ageDays)} · ${shortenHome(c.cwd)}`),
    ];
    if (list.length > 8) lines.push(`…and ${list.length - 8} more`);
    if (!(await ctx.ui.confirm(`Delete ${list.length} old sessions?`, lines.join("\n")))) return;
    const r = await trashCandidates(
        agentDir,
        list.map((c) => c.file),
    );
    sweepEmptySessionFolders(agentDir);
    ctx.ui.notify(
        `Cleaned ${list.length - r.failed.length} (${r.os} recycle bin, ${r.local} local trash${r.failed.length ? `, ${r.failed.length} failed` : ""})`,
        r.failed.length > 0 ? "warning" : "info",
    );
    for (const f of r.failed) console.warn(`[session-mgr] failed to trash ${f.file}: ${f.error}`);
}

async function handleSessionMgr(agentDir: string, ctx: ExtensionCommandContext): Promise<void> {
    let thresholdDays = loadCleanupSettings().autoCleanThresholdDays;
    let level1Desc: string;
    try {
        const count = collectCleanupCandidates(
            agentDir,
            thresholdDays,
            ctx.sessionManager.getSessionFile(),
        ).length;
        level1Desc = `${thresholdDays}d auto-clean · ${count} candidates`;
    } catch {
        level1Desc = "threshold unknown";
    }
    const level1 = await showPicker(
        ctx,
        "Session manager:",
        "type to filter • ↑↓ navigate • enter select • esc close",
        () => [{ value: "cleanup", label: "Session cleanup…", description: level1Desc }],
    );
    if (level1 !== "cleanup") return;
    for (;;) {
        thresholdDays = loadCleanupSettings().autoCleanThresholdDays;
        const level2Count = collectCleanupCandidates(
            agentDir,
            thresholdDays,
            ctx.sessionManager.getSessionFile(),
        ).length;
        const level2 = await showPicker(
            ctx,
            "Session cleanup:",
            "type to filter • ↑↓ navigate • enter select • esc close",
            () => [
                {
                    value: "threshold",
                    label: "Auto clean threshold…",
                    description: `current: ${thresholdDays}d (0 = off)`,
                },
                {
                    value: "clean-now",
                    label: "Clean now",
                    description: `delete ${level2Count} sessions older than ${thresholdDays}d`,
                },
            ],
        );
        if (level2 === "threshold") {
            await editThreshold(ctx, thresholdDays);
            continue;
        }
        if (level2 === "clean-now") {
            await cleanNow(agentDir, ctx, loadCleanupSettings().autoCleanThresholdDays);
            continue;
        }
        return;
    }
}

export function registerSessionMgr(pi: ExtensionAPI): void {
    pi.registerCommand("session-mgr", {
        description: "Session manager settings (cleanup…)",
        handler: async (_args: string, ctx: ExtensionCommandContext) => {
            const agentDir = getAgentDir();
            if (!ctx.hasUI) {
                ctx.ui.notify(
                    "Session manager: no dialog available in headless mode — use /session-mgr from interactive TUI.",
                    "error",
                );
                return;
            }
            await handleSessionMgr(agentDir, ctx);
        },
    });
    pi.on("session_start", async (event, ctx) => {
        try {
            if (event.reason !== "startup") return;
            if (!ctx.hasUI) return;
            const settings = loadCleanupSettings();
            if (settings.autoCleanThresholdDays <= 0) return;
            const last = Date.parse(settings.lastAutoCleanAt);
            if (!Number.isNaN(last) && Date.now() - last < 24 * 3600 * 1000) return;
            const agentDir = getAgentDir();
            const exclude = ctx.sessionManager.getSessionFile();
            const cands = collectCleanupCandidates(
                agentDir,
                settings.autoCleanThresholdDays,
                exclude,
            );
            if (cands.length === 0) return;
            saveCleanupSettings({ ...settings, lastAutoCleanAt: new Date().toISOString() });
            const oldest = Math.max(...cands.map((c) => c.ageDays));
            const mb = (cands.reduce((a, c) => a + c.sizeBytes, 0) / 1048576).toFixed(1);
            const lines = [
                `Oldest ${formatAge(oldest)} · total ${mb} MB · goes to OS Recycle Bin (fallback sessions/.trash). Current session excluded.`,
                ...cands
                    .slice(0, 8)
                    .map((c) => `• ${c.name} · ${formatAge(c.ageDays)} · ${shortenHome(c.cwd)}`),
            ];
            if (cands.length > 8) lines.push(`…and ${cands.length - 8} more`);
            if (!(await ctx.ui.confirm(`Delete ${cands.length} old sessions?`, lines.join("\n"))))
                return;
            const r = await trashCandidates(
                agentDir,
                cands.map((c) => c.file),
            );
            sweepEmptySessionFolders(agentDir);
            ctx.ui.notify(
                `Cleaned ${cands.length - r.failed.length} (${r.os} recycle bin, ${r.local} local trash${r.failed.length ? `, ${r.failed.length} failed` : ""})`,
                r.failed.length > 0 ? "warning" : "info",
            );
        } catch (e) {
            console.warn(
                "[session-mgr] auto-clean skipped:",
                e instanceof Error ? e.message : String(e),
            );
        }
    });
}
