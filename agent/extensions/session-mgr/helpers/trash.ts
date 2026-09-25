/** Move a session file to the OS Recycle Bin / Trash, with local fallback. */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileStamp } from "./sessions.js";

export type TrashResult =
    { kind: "os" } | { kind: "local"; dest: string } | { kind: "failed"; error: string };

const OS_TRASH_TIMEOUT_MS = 15000;

function osTrashSucceeded(status: number | null, filePath: string): boolean {
    return status === 0 && !existsSync(filePath);
}

function tryOsTrash(filePath: string): boolean {
    try {
        if (process.platform === "win32") {
            const escaped = filePath.replace(/'/g, "''");
            const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}','OnlyErrorDialogs','SendToRecycleBin')`;
            const result = spawnSync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", script],
                { timeout: OS_TRASH_TIMEOUT_MS },
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
                } catch {
                    // Ignore cleanup failure; report the original copy error.
                }
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

/**
 * Trash a single session file: OS Recycle Bin / Trash first, local
 * `sessions/.trash/` fallback. Never throws; never deletes more than the
 * given file; logs nothing (caller notifies).
 */
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
