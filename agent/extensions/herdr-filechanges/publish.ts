/**
 * The herdr-app snapshot writer — the only part of this extension that touches
 * the filesystem or knows about herdr. Imported lazily from `index.ts`, so a
 * plain pi session (no herdr) never evaluates it.
 */
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileChangeCore } from "../shared/filechanges-core.ts";

/** Where the mod reads from. Sibling of the app's own `data/<mod>/` folders. */
const DATA_DIR = join(homedir(), ".config", "herdr-app", "data", "herdr-filechanges");
/** A panel renders a few hundred rows at most; a patch is capped per file. */
const FILES_CAP = 400;
const DIFF_CAP = 40_000;
/** One snapshot per terminal id, and herdr issues a new one when it restarts a pane:
 *  without this the folder grows one small file per restart, forever. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TMP_AGE_MS = 60 * 60 * 1000;
let pruned = false;

async function pruneSnapshots(keep: string): Promise<void> {
    const keepName = `${keep}.json`;
    const now = Date.now();
    let names: string[];
    try {
        names = await readdir(DATA_DIR);
    } catch {
        return;
    }
    await Promise.all(
        names.map(async (name) => {
            if (name === keepName) return;
            const maxAge = name.endsWith(".tmp")
                ? MAX_TMP_AGE_MS
                : name.endsWith(".json")
                  ? MAX_AGE_MS
                  : -1;
            if (maxAge < 0) return;
            const path = join(DATA_DIR, name);
            try {
                const info = await stat(path);
                if (now - info.mtimeMs > maxAge) await rm(path, { force: true });
            } catch {
                // Another terminal is mid-write, or it vanished already: next publish retries.
            }
        }),
    );
}

export async function publish(core: FileChangeCore, terminal: string, cwd: string): Promise<void> {
    const target = join(DATA_DIR, `${terminal}.json`);

    try {
        // Disk truth at write time: a file deleted, reverted or checked out outside pi
        // drops out here, which the in-memory tracker alone cannot notice.
        await Promise.all(
            core.tracker.getAllTracked().map((t) => core.tracker.recomputeTrackedFile(t.path)),
        );

        const files = core.tracker
            .getAllTracked()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, FILES_CAP)
            .map((t) => ({
                path: t.displayPath,
                kind: t.kind,
                added: t.added,
                removed: t.removed,
                updatedAt: t.updatedAt,
                diff: t.diff.length > DIFF_CAP ? t.diff.slice(0, DIFF_CAP) : t.diff,
                truncated: t.diff.length > DIFF_CAP,
            }));

        const snapshot = {
            v: 1,
            terminal,
            cwd,
            updatedAt: Date.now(),
            files,
        };

        await mkdir(DATA_DIR, { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(snapshot), "utf-8");
        // rename is atomic on both NTFS and POSIX: the mod never reads half a file.
        await rename(tmp, target);

        // Once per process, on the first snapshot: old terminal ids and crash leftovers.
        if (!pruned) {
            pruned = true;
            await pruneSnapshots(terminal);
        }
    } catch {
        // herdr-app may be gone or the folder unwritable; a stale snapshot
        // beats a broken session, and the next publish tries again.
    }
}
