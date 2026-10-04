/**
 * Session cleanup: candidate scan, trash handling, cleanup settings, and interactive UI.
 *
 * Loaded on-demand when `/session-mgr` is executed or during `session_start` auto-clean.
 */

import { spawnSync } from "node:child_process";
import {
    closeSync,
    copyFileSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showPicker } from "../shared/picker.js";
import { shortenHome } from "../shared/text-format.js";
import {
    fileStamp,
    listSessionFiles,
    normalizeDir,
    parseSessionHeader,
    readFileHead,
    readSessionCwd,
} from "./session-ops.js";

// =============================================================================
// Settings: Cleanup
// =============================================================================

const SETTINGS_FILE_NAME = "session-mgr-settings.json";

export interface CleanupSettings {
    autoCleanThresholdDays: number;
    lastAutoCleanAt: string;
}

const DEFAULT_SETTINGS: Required<CleanupSettings> = {
    autoCleanThresholdDays: 30,
    lastAutoCleanAt: "",
};

function getSettingsPath(): string {
    return join(getAgentDir(), SETTINGS_FILE_NAME);
}

const MAX_THRESHOLD_DAYS = 3650;

function normalizeThreshold(value: unknown): number {
    if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_THRESHOLD_DAYS
    ) {
        return value;
    }
    return DEFAULT_SETTINGS.autoCleanThresholdDays;
}

function normalizeStamp(value: unknown): string {
    if (typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value))) {
        return value;
    }
    return "";
}

export function loadCleanupSettings(): Required<CleanupSettings> {
    try {
        const settingsPath = getSettingsPath();
        if (!existsSync(settingsPath)) return { ...DEFAULT_SETTINGS };
        const raw = readFileSync(settingsPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<CleanupSettings>;
        return {
            autoCleanThresholdDays: normalizeThreshold(parsed.autoCleanThresholdDays),
            lastAutoCleanAt: normalizeStamp(parsed.lastAutoCleanAt),
        };
    } catch (error) {
        console.error("Failed to load session-mgr settings:", error);
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveCleanupSettings(settings: Required<CleanupSettings>): void {
    try {
        const settingsPath = getSettingsPath();
        const dir = dirname(settingsPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    } catch (error) {
        console.error("Failed to save session-mgr settings:", error);
    }
}

// =============================================================================
// Trash Handling
// =============================================================================

export type TrashResult =
    { kind: "os" } | { kind: "local"; dest: string } | { kind: "failed"; error: string };

const OS_TRASH_TIMEOUT_MS = 15000;

function osTrashSucceeded(status: number | null, filePath: string): boolean {
    return status === 0 && !existsSync(filePath);
}

function tryOsTrash(filePath: string): boolean {
    try {
        if (process.platform === "win32") {
            const script =
                "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:PI_TRASH_TARGET,'OnlyErrorDialogs','SendToRecycleBin')";
            const result = spawnSync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", script],
                {
                    timeout: OS_TRASH_TIMEOUT_MS,
                    env: { ...process.env, PI_TRASH_TARGET: filePath },
                },
            );
            if (result.error) return false;
            return osTrashSucceeded(result.status, filePath);
        }
        if (process.platform === "darwin") {
            const escaped = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            const expr = `tell application "Finder" to delete POSIX file "${escaped}"`;
            const result = spawnSync("osascript", ["-e", expr], {
                timeout: OS_TRASH_TIMEOUT_MS,
            });
            if (result.error) return false;
            return osTrashSucceeded(result.status, filePath);
        }
        if (process.platform === "linux") {
            const gio = spawnSync("gio", ["trash", "--", filePath], {
                timeout: OS_TRASH_TIMEOUT_MS,
            });
            if (!gio.error && osTrashSucceeded(gio.status, filePath)) return true;
            const gioCode = (gio.error as NodeJS.ErrnoException | undefined)?.code;
            if (gio.error && gioCode !== "ENOENT") return false;
            if (!gio.error) return false;
            const fallback = spawnSync("trash-put", ["--", filePath], {
                timeout: OS_TRASH_TIMEOUT_MS,
            });
            if (fallback.error) return false;
            return osTrashSucceeded(fallback.status, filePath);
        }
        return false;
    } catch {
        return false;
    }
}

function stampBeforeExtension(base: string): string {
    const stamp = fileStamp(new Date().toISOString());
    const dot = base.lastIndexOf(".");
    if (dot > 0) return `${base.slice(0, dot)}_${stamp}${base.slice(dot)}`;
    return `${base}_${stamp}`;
}

function localTrash(agentDir: string, filePath: string): TrashResult {
    try {
        const parentName = basename(dirname(filePath));
        let dest = join(agentDir, "sessions", ".trash", parentName, basename(filePath));
        mkdirSync(dirname(dest), { recursive: true });
        if (existsSync(dest)) {
            dest = join(dirname(dest), stampBeforeExtension(basename(filePath)));
        }
        try {
            renameSync(filePath, dest);
            return { kind: "local", dest };
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") {
                return {
                    kind: "failed",
                    error: error instanceof Error ? error.message : String(error),
                };
            }
            try {
                copyFileSync(filePath, dest);
                unlinkSync(filePath);
                return { kind: "local", dest };
            } catch (copyError) {
                try {
                    if (existsSync(dest)) unlinkSync(dest);
                } catch {}
                return {
                    kind: "failed",
                    error: copyError instanceof Error ? copyError.message : String(copyError),
                };
            }
        }
    } catch (error) {
        return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
}

export function trashSessionFile(agentDir: string, filePath: string): TrashResult {
    try {
        if (tryOsTrash(filePath)) return { kind: "os" };
        if (!existsSync(filePath)) {
            return { kind: "failed", error: `Source file not found: ${filePath}` };
        }
        return localTrash(agentDir, filePath);
    } catch (error) {
        return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
}

// =============================================================================
// Candidate Scanning & Age Calculation
// =============================================================================

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
            } catch {}
        }
    }
}

function calculateAgeDays(mtimeMs: number, nowMs: number = Date.now()): number {
    return Math.max(0, Math.floor((nowMs - mtimeMs) / (24 * 3600 * 1000)));
}

function isSessionFolder(entryName: string): boolean {
    return entryName.startsWith("--") && entryName.endsWith("--");
}

export function collectCleanupCandidates(
    agentDir: string,
    thresholdDays: number,
    excludeFile?: string,
): CleanupCandidate[] {
    const sessionsRoot = join(agentDir, "sessions");
    let folders: string[] = [];
    try {
        folders = readdirSync(sessionsRoot).filter(isSessionFolder);
    } catch {
        return [];
    }
    const normalizedExclude = excludeFile ? normalizeDir(excludeFile) : undefined;
    const now = Date.now();
    const candidates: CleanupCandidate[] = [];

    for (const folder of folders) {
        const folderPath = join(sessionsRoot, folder);
        const files = listSessionFiles(folderPath);
        if (files.length === 0) continue;

        for (const f of files) {
            const filePath = join(folderPath, f);
            if (normalizedExclude && normalizeDir(filePath) === normalizedExclude) continue;

            let mtimeMs = 0;
            let sizeBytes = 0;
            try {
                const st = statSync(filePath);
                mtimeMs = st.mtimeMs;
                sizeBytes = st.size;
            } catch {
                continue;
            }

            const ageDays = calculateAgeDays(mtimeMs, now);
            if (thresholdDays > 0 && ageDays < thresholdDays) continue;

            const cwd = readSessionCwd(filePath) ?? "unknown";
            const name = readSessionName(filePath);
            candidates.push({
                file: filePath,
                folder,
                cwd,
                name,
                mtimeMs,
                ageDays,
                sizeBytes,
            });
        }
    }

    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function sweepEmptySessionFolders(agentDir: string): number {
    const sessionsRoot = join(agentDir, "sessions");
    let removed = 0;
    try {
        for (const folder of readdirSync(sessionsRoot)) {
            if (!isSessionFolder(folder)) continue;
            const folderPath = join(sessionsRoot, folder);
            try {
                if (readdirSync(folderPath).length === 0) {
                    rmdirSync(folderPath);
                    removed++;
                }
            } catch {}
        }
    } catch {}
    return removed;
}

/** Trash session files, reporting how many went to the OS recycle bin vs the local fallback. */
export function trashCandidates(
    agentDir: string,
    files: string[],
): { os: number; local: number; failed: string[] } {
    let os = 0;
    let local = 0;
    const failed: string[] = [];

    for (const f of files) {
        const r = trashSessionFile(agentDir, f);
        if (r.kind === "os") os++;
        else if (r.kind === "local") local++;
        else failed.push(`${basename(f)}: ${r.error}`);
    }

    return { os, local, failed };
}

function formatAge(ageDays: number): string {
    if (ageDays === 0) return "today";
    if (ageDays === 1) return "yesterday";
    if (ageDays < 30) return `${ageDays}d ago`;
    const m = Math.floor(ageDays / 30);
    return `${m}mo ago`;
}

// =============================================================================
// UI: Cleanup & Settings
// =============================================================================

async function editThreshold(ctx: ExtensionCommandContext, current: number): Promise<void> {
    const input = await ctx.ui.input(
        "Auto clean threshold in days (0 to disable auto-clean):",
        String(current),
    );
    if (input === undefined) return;
    const parsed = Number.parseInt(input.trim(), 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_THRESHOLD_DAYS) {
        ctx.ui.notify(
            `Invalid threshold: must be an integer between 0 and ${MAX_THRESHOLD_DAYS}.`,
            "error",
        );
        return;
    }
    saveCleanupSettings({ ...loadCleanupSettings(), autoCleanThresholdDays: parsed });
    ctx.ui.notify(
        parsed === 0
            ? "Auto-clean disabled. (Run /session-mgr to clean manually anytime)"
            : `Auto-clean threshold set to ${parsed} days.`,
        "info",
    );
}

/**
 * Sessions eligible for trashing, current session excluded. A threshold of 0
 * disables the age filter, so manual cleanup can browse every stored session.
 */
function eligibleSessions(
    agentDir: string,
    ctx: { sessionManager: { getSessionFile(): string | undefined } },
    thresholdDays: number,
): CleanupCandidate[] {
    return collectCleanupCandidates(agentDir, thresholdDays, ctx.sessionManager.getSessionFile());
}

/** Human phrasing for a threshold, where 0 means "no age filter". */
function thresholdLabel(thresholdDays: number): string {
    return thresholdDays === 0 ? "any age" : `older than ${thresholdDays}d`;
}

async function cleanNow(
    agentDir: string,
    ctx: ExtensionCommandContext,
    thresholdDays: number,
): Promise<void> {
    const cands = eligibleSessions(agentDir, ctx, thresholdDays);
    if (cands.length === 0) {
        ctx.ui.notify(
            thresholdDays === 0
                ? "No session files found to clean."
                : `No sessions found ${thresholdLabel(thresholdDays)}.`,
            "info",
        );
        return;
    }

    const items = cands.map((c) => ({
        value: c.file,
        label: `${c.name} · ${formatAge(c.ageDays)} · ${shortenHome(c.cwd)}`,
        description: `${c.ageDays}d · ${(c.sizeBytes / 1024).toFixed(0)} KB`,
    }));

    const picked = await showPicker(
        ctx,
        `Clean sessions (${cands.length} ${thresholdLabel(thresholdDays)}):`,
        "enter trash this session • esc back",
        () => items,
    );
    if (!picked) return;

    const r = trashCandidates(agentDir, [picked]);
    sweepEmptySessionFolders(agentDir);
    if (r.failed.length > 0) {
        ctx.ui.notify(`Failed: ${r.failed.join("; ")}`, "error");
    } else {
        ctx.ui.notify(
            `Session trashed (${r.os > 0 ? "OS Recycle Bin" : "sessions/.trash"})`,
            "info",
        );
    }
}

export async function handleSessionMgr(
    agentDir: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    for (;;) {
        const thresholdDays = loadCleanupSettings().autoCleanThresholdDays;
        const candidateCount = eligibleSessions(agentDir, ctx, thresholdDays).length;

        const picked = await showPicker(
            ctx,
            "Session manager settings:",
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
                    description: `browse ${candidateCount} sessions ${thresholdLabel(thresholdDays)}`,
                },
            ],
        );
        if (picked === "threshold") {
            await editThreshold(ctx, thresholdDays);
            continue;
        }
        if (picked === "clean-now") {
            await cleanNow(agentDir, ctx, loadCleanupSettings().autoCleanThresholdDays);
            continue;
        }
        return;
    }
}

export async function handleAutoCleanupOnStart(ctx: ExtensionContext): Promise<void> {
    try {
        if (!ctx.hasUI) return;
        const settings = loadCleanupSettings();
        if (settings.autoCleanThresholdDays <= 0) return;
        const last = Date.parse(settings.lastAutoCleanAt);
        if (!Number.isNaN(last) && Date.now() - last < 24 * 3600 * 1000) return;
        const agentDir = getAgentDir();
        const cands = eligibleSessions(agentDir, ctx, settings.autoCleanThresholdDays);
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
        const r = trashCandidates(
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
}
