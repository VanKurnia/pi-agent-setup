/**
 * filechanges core — the log itself.
 *
 * Tracks files pi changes through the `edit`/`write` tools, writes them to the
 * session as custom entries, keeps an in-memory tracker, serves the legacy
 * subagent API and owns `/filechanges-accept` + `/filechanges-decline`. It
 * renders **nothing**: the TUI panel lives in `agent/extensions/filechanges/`,
 * the herdr sidebar in `agent/extensions/herdr-filechanges.ts`, and either one
 * can be enabled without the other.
 *
 * Why globalThis: the loader builds one jiti instance per extension
 * (`moduleCache:false`), so each frontend gets its own copy of this module. If
 * both frontends are enabled, the log must still be written exactly once — so
 * the tracker and the "already installed" flags live on globalThis, the only
 * state shared process-wide (same reasoning as `./cross-extension-api.ts`).
 */
import { createTwoFilesPatch } from "diff";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    isEditToolResult,
    isToolCallEventType,
    isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { registerExtensionApi } from "./cross-extension-api.js";
import type { FilechangesApi } from "./filechanges-api.ts";

// ── Types ──────────────────────────────────────────────

export type Baseline = {
    path: string;
    absPath: string;
    originalContent: string | null;
    createdAt: number;
};

export type TrackedFile = {
    path: string;
    absPath: string;
    displayPath: string;
    originalContent: string | null;
    currentContent: string;
    diff: string;
    added: number;
    removed: number;
    kind: "new" | "edited";
    updatedAt: number;
};

type PendingSnapshot = {
    path: string;
    absPath: string;
    before: string | null;
};

// ── Entry type constants ───────────────────────────────

export const ENTRY_BASELINE = "filechanges:baseline";
export const ENTRY_CLEAR = "filechanges:clear";
export const ENTRY_UNTRACK = "filechanges:untrack";

// ── Helpers ────────────────────────────────────────────

function stripAtPrefix(p: string): string {
    return p.startsWith("@") ? p.slice(1) : p;
}

/**
 * Normalize a tool-provided file path into absolute + cwd-relative forms.
 *
 * Strips one leading "@" (pi mention syntax); `absPath` is always
 * `resolve(cwd, cleaned)`. `relPath` is the cwd-relative slash-normalized
 * form when inside cwd, else falls back to the cleaned raw input
 * (slash-normalized). Outside-cwd files are intentionally tracked under
 * that absolute/cleaned form and round-trip on a stable cwd.
 * Empty input yields `relPath ""`; callers must skip empty paths.
 */
export function normalizeToolPath(cwd: string, raw: string): { absPath: string; relPath: string } {
    const cleaned = stripAtPrefix(raw);
    const absPath = resolve(cwd, cleaned);
    const rel = relative(cwd, absPath).replace(/\\/g, "/");
    const cleanedNormalized = cleaned.replace(/\\/g, "/");
    const relPath = rel && !rel.startsWith("..") && rel !== "" ? rel : cleanedNormalized;
    return { absPath, relPath };
}

export async function readTextOrNull(absPath: string): Promise<string | null> {
    try {
        return await readFile(absPath, "utf-8");
    } catch {
        return null;
    }
}

export function countDiffLines(unifiedDiff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of unifiedDiff.split("\n")) {
        if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
    }
    return { added, removed };
}

export function patchFromBaseline(
    displayPath: string,
    original: string | null,
    current: string,
): string {
    return createTwoFilesPatch(displayPath, displayPath, original ?? "", current, "", "", {
        context: 3,
    });
}

async function ensureParentDir(absPath: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
}

export function parseCommandArgs(args: string | undefined): string[] {
    if (!args) return [];
    return args
        .split(/\s+/g)
        .map((s) => s.trim())
        .filter(Boolean);
}

// ── FileChangeTracker class ────────────────────────────

export class FileChangeTracker {
    private baselines = new Map<string, Baseline>();
    private tracked = new Map<string, TrackedFile>();
    private pendingByToolCallId = new Map<string, PendingSnapshot>();

    // ── Pending snapshot management ──

    setPending(toolCallId: string, path: string, absPath: string, before: string | null): void {
        this.pendingByToolCallId.set(toolCallId, { path, absPath, before });
    }

    /** Returns the pending snapshot and removes it from the map. */
    getPending(toolCallId: string): PendingSnapshot | undefined {
        const p = this.pendingByToolCallId.get(toolCallId);
        this.pendingByToolCallId.delete(toolCallId);
        return p;
    }

    deletePending(toolCallId: string): void {
        this.pendingByToolCallId.delete(toolCallId);
    }

    // ── Baseline access ──

    hasBaseline(relPath: string): boolean {
        return this.baselines.has(relPath);
    }

    getBaseline(relPath: string): Baseline | undefined {
        return this.baselines.get(relPath);
    }

    getAllBaselines(): Baseline[] {
        return [...this.baselines.values()];
    }

    deleteBaseline(relPath: string): void {
        this.baselines.delete(relPath);
    }

    // ── Tracked file access ──

    getTracked(relPath: string): TrackedFile | undefined {
        return this.tracked.get(relPath);
    }

    getAllTracked(): TrackedFile[] {
        return [...this.tracked.values()];
    }

    getTrackedSize(): number {
        return this.tracked.size;
    }

    // ── Core operations ──

    /**
     * Adds a baseline for the given file and recomputes the tracked diff.
     * Returns true if a new baseline was created, false if already tracked.
     */
    async trackFile(
        relPath: string,
        absPath: string,
        originalContent: string | null,
    ): Promise<boolean> {
        if (this.baselines.has(relPath)) return false;

        this.baselines.set(relPath, {
            path: relPath,
            absPath,
            originalContent,
            createdAt: Date.now(),
        });

        await this.recomputeTrackedFile(relPath);
        return true;
    }

    /**
     * Re-reads the file from disk and recomputes the diff against its baseline.
     */
    async recomputeTrackedFile(relPath: string): Promise<void> {
        const baseline = this.baselines.get(relPath);
        if (!baseline) return;

        const current = await readTextOrNull(baseline.absPath);

        if (baseline.originalContent === null) {
            // File was created (did not exist before)
            if (current === null) {
                this.tracked.delete(relPath);
                return;
            }
            const displayPath = baseline.path;
            const diff = patchFromBaseline(displayPath, null, current);
            const { added, removed } = countDiffLines(diff);
            this.tracked.set(relPath, {
                path: baseline.path,
                absPath: baseline.absPath,
                displayPath,
                originalContent: null,
                currentContent: current,
                diff,
                added,
                removed,
                kind: "new",
                updatedAt: Date.now(),
            });
            return;
        }

        // File existed before
        if (current === null) {
            // Deleted outside of tracked tools (or manually)
            const displayPath = baseline.path;
            const diff = patchFromBaseline(displayPath, baseline.originalContent, "");
            const { added, removed } = countDiffLines(diff);
            this.tracked.set(relPath, {
                path: baseline.path,
                absPath: baseline.absPath,
                displayPath,
                originalContent: baseline.originalContent,
                currentContent: "",
                diff,
                added,
                removed,
                kind: "edited",
                updatedAt: Date.now(),
            });
            return;
        }

        if (current === baseline.originalContent) {
            // Back to original; untrack
            this.tracked.delete(relPath);
            return;
        }

        const displayPath = baseline.path;
        const diff = patchFromBaseline(displayPath, baseline.originalContent, current);
        const { added, removed } = countDiffLines(diff);
        this.tracked.set(relPath, {
            path: baseline.path,
            absPath: baseline.absPath,
            displayPath,
            originalContent: baseline.originalContent,
            currentContent: current,
            diff,
            added,
            removed,
            kind: "edited",
            updatedAt: Date.now(),
        });
    }

    /** Clear all state (baselines, tracked files, pending snapshots). */
    clear(): void {
        this.baselines.clear();
        this.tracked.clear();
        this.pendingByToolCallId.clear();
    }

    /**
     * Rebuild state from an array of session entries (custom entries).
     * This is used when loading a session or navigating the session tree.
     */
    async rebuildFromEntries(entries: any[], cwd: string): Promise<void> {
        this.clear();

        for (const entry of entries) {
            if (entry.type !== "custom") continue;

            if (entry.customType === ENTRY_CLEAR) {
                this.baselines.clear();
                this.tracked.clear();
                continue;
            }

            if (entry.customType === ENTRY_BASELINE) {
                const data = entry.data as any;
                if (typeof data?.path !== "string" || data.path.trim() === "") continue;
                const { absPath, relPath } = normalizeToolPath(cwd, data.path);
                this.baselines.set(relPath, {
                    path: relPath,
                    absPath,
                    originalContent:
                        typeof data.originalContent === "string" ? data.originalContent : null,
                    createdAt: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
                });
                continue;
            }

            if (entry.customType === ENTRY_UNTRACK) {
                const data = entry.data as any;
                if (typeof data?.path !== "string" || data.path.trim() === "") continue;
                const { relPath } = normalizeToolPath(cwd, data.path);
                this.baselines.delete(relPath);
                this.tracked.delete(relPath);
                continue;
            }
        }

        // Recompute current diffs with bounded parallelism (chunked Promise.all,
        // no new dependency). Concurrency 10 stays within the 8-16 bound.
        const relPaths = [...this.baselines.keys()];
        const REBUILD_CONCURRENCY = 10;
        for (let i = 0; i < relPaths.length; i += REBUILD_CONCURRENCY) {
            const chunk = relPaths.slice(i, i + REBUILD_CONCURRENCY);
            await Promise.all(chunk.map((relPath) => this.recomputeTrackedFile(relPath)));
        }
    }

    /** Check whether the file at relPath is back to its baseline content. */
    isBackToBaseline(relPath: string, currentContent: string | null): boolean {
        const baseline = this.baselines.get(relPath);
        if (!baseline) return false;
        return (
            (baseline.originalContent !== null && currentContent === baseline.originalContent) ||
            (baseline.originalContent === null && currentContent === null)
        );
    }
}

// ── Process-wide install ───────────────────────────────

export type FileChangeCore = {
    /** The one tracker this process shares, live (never a snapshot). */
    tracker: FileChangeTracker;
    /** Append a baseline entry for an external (subagent) change, then refresh. */
    track(relPath: string, absPath: string, originalContent: string | null): Promise<boolean>;
    /** Rebuild the tracker from the session's entries (after a late install). */
    rebuildFromSession(ctx: any): Promise<void>;
    /** Accept whatever is logged: keep files, clear the log. */
    accept(ctx: any): Promise<void>;
    /** Decline whatever is logged: revert files, clear the log. */
    decline(ctx: any): Promise<void>;
    /** Tell every frontend the log changed. */
    refresh(): void;
};

type CoreState = {
    tracker: FileChangeTracker;
    /** The extension instance that installed the writer hooks and commands. */
    owner: ExtensionAPI | null;
    listeners: Map<string, () => void>;
};

const CORE_KEY = "__pi_filechanges_core";
const HOOKS_KEY = "__pi_filechanges_hooks";
const COMMANDS_KEY = "__pi_filechanges_commands";

function globalState(): Record<string, unknown> {
    return globalThis as unknown as Record<string, unknown>;
}

function coreState(): CoreState {
    const g = globalState();
    let state = g[CORE_KEY] as CoreState | undefined;
    if (!state) {
        state = { tracker: new FileChangeTracker(), owner: null, listeners: new Map() };
        g[CORE_KEY] = state;
    }
    return state;
}

/**
 * Install the log: writer hooks, accept/decline commands, subagent API.
 *
 * Idempotent across extension instances. Call it from a frontend's factory,
 * before any early return of that frontend — the log must work even where no
 * frontend has anything to show.
 */
export function installFileChangeCore(
    pi: ExtensionAPI,
    opts: { owner?: string; onChange?: () => void } = {},
): FileChangeCore {
    const g = globalState();
    const state = coreState();
    const { tracker } = state;

    if (opts.owner && opts.onChange) state.listeners.set(opts.owner, opts.onChange);

    function refresh(): void {
        for (const fn of state.listeners.values()) {
            try {
                fn();
            } catch {
                // A frontend's render must never break the log.
            }
        }
    }

    function appendBaseline(relPath: string, originalContent: string | null): void {
        state.owner?.appendEntry(ENTRY_BASELINE, {
            path: relPath,
            originalContent,
            timestamp: Date.now(),
        });
    }

    async function clearLog(ctx: any, reason: "accept" | "decline"): Promise<void> {
        tracker.clear();
        state.owner?.appendEntry(ENTRY_CLEAR, { timestamp: Date.now(), reason });
        refresh();
        void ctx;
    }

    async function accept(ctx: ExtensionCommandContext): Promise<void> {
        await ctx.waitForIdle();

        if (tracker.getTrackedSize() === 0) {
            if (ctx.hasUI) ctx.ui.notify("filechanges: nothing to accept.", "info");
            return;
        }

        const force = (ctx as any).args?.includes("force") ?? false;
        if (ctx.hasUI && !force) {
            const ok = await ctx.ui.confirm(
                "Accept pi changes?",
                "This will keep current files as-is and clear the modification log.",
            );
            if (!ok) return;
        } else if (!ctx.hasUI && !force) {
            throw new Error("Accept requires confirmation. Run: /filechanges-accept force");
        }

        const count = tracker.getTrackedSize();
        await clearLog(ctx, "accept");
        if (ctx.hasUI) ctx.ui.notify(`filechanges: accepted changes for ${count} file(s).`, "info");
    }

    async function decline(ctx: ExtensionCommandContext): Promise<void> {
        await ctx.waitForIdle();

        if (tracker.getTrackedSize() === 0) {
            if (ctx.hasUI) ctx.ui.notify("filechanges: nothing to decline.", "info");
            return;
        }

        const force = (ctx as any).args?.includes("force") ?? false;
        if (ctx.hasUI && !force) {
            const ok = await ctx.ui.confirm(
                "Decline pi changes?",
                "This will revert ALL currently logged pi changes (overwrite files / delete created files).",
            );
            if (!ok) return;
        } else if (!ctx.hasUI && !force) {
            throw new Error("Decline requires confirmation. Run: /filechanges-decline force");
        }

        const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
        let reverted = 0;
        const errors: string[] = [];

        for (const item of items) {
            try {
                if (item.originalContent === null) {
                    // created file
                    await rm(item.absPath, { force: true });
                } else {
                    await ensureParentDir(item.absPath);
                    await writeFile(item.absPath, item.originalContent, "utf-8");
                }
                reverted++;
            } catch (e: any) {
                errors.push(`${item.displayPath}: ${e?.message ?? String(e)}`);
            }
        }

        if (errors.length > 0) {
            // Don't clear — let the person retry the failed files.
            if (ctx.hasUI) {
                ctx.ui.notify(
                    `filechanges: declined with ${errors.length} error(s). Run /filechanges-decline to retry.`,
                    "warning",
                );
                console.warn("[filechanges] decline errors:\n" + errors.join("\n"));
            } else {
                console.error("[filechanges] decline errors:\n" + errors.join("\n"));
            }
            return;
        }

        await clearLog(ctx, "decline");

        if (ctx.hasUI) {
            ctx.ui.notify(`filechanges: declined changes for ${reverted} file(s).`, "info");
        }
    }

    async function rebuildFromSession(ctx: any): Promise<void> {
        await tracker.rebuildFromEntries(ctx.sessionManager.getBranch(), ctx.cwd);
        refresh();
    }

    // ── Writer hooks: installed by whichever frontend loads first ──

    if (!g[HOOKS_KEY]) {
        g[HOOKS_KEY] = true;
        state.owner = pi;

        // Rebuild state on any session/branch navigation events
        pi.on("session_start", async (_event, ctx) => {
            await rebuildFromSession(ctx);
        });

        pi.on("session_tree", async (_event, ctx) => {
            await rebuildFromSession(ctx);
        });

        // Capture before snapshots for edit/write
        pi.on("tool_call", async (event, ctx) => {
            if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
                const rawPath = event.input.path;
                // Ignore empty tool paths; nothing to track.
                if (typeof rawPath !== "string" || rawPath.trim() === "") return;
                const { absPath, relPath } = normalizeToolPath(ctx.cwd, rawPath);
                if (!relPath) return;
                const before = await readTextOrNull(absPath);
                tracker.setPending(event.toolCallId, relPath, absPath, before);
            }
        });

        // Commit on successful results
        pi.on("tool_result", async (event, ctx) => {
            if (event.isError) {
                tracker.deletePending(event.toolCallId);
                return;
            }

            if (!isEditToolResult(event) && !isWriteToolResult(event)) return;

            const pending = tracker.getPending(event.toolCallId);
            if (!pending) return;

            // If no baseline exists yet for this file, create one from the successful call's snapshot.
            if (!tracker.hasBaseline(pending.path)) {
                await tracker.trackFile(pending.path, pending.absPath, pending.before);
                appendBaseline(pending.path, pending.before);
            } else {
                // Recompute cumulative diff against baseline
                await tracker.recomputeTrackedFile(pending.path);
            }

            // If recompute already removed the entry (file reverted to baseline or
            // created-then-deleted), clean up the baseline too.
            if (tracker.hasBaseline(pending.path) && !tracker.getTracked(pending.path)) {
                tracker.deleteBaseline(pending.path);
                state.owner?.appendEntry(ENTRY_UNTRACK, {
                    path: pending.path,
                    timestamp: Date.now(),
                });
            }

            void ctx;
            refresh();
        });

        // A reload disposes the instance that owns the hooks: drop the flags so the
        // next load installs them again instead of trusting a dead registration.
        pi.on("session_shutdown", async () => {
            if (state.owner !== pi) return;
            delete g[HOOKS_KEY];
            delete g[COMMANDS_KEY];
            state.owner = null;
        });
    }

    // ── Commands: protocol, so they exist whichever frontend is enabled ──

    if (!g[COMMANDS_KEY]) {
        g[COMMANDS_KEY] = true;
        state.owner = state.owner ?? pi;

        pi.registerCommand("filechanges-accept", {
            description: "Accept pi-made changes (keeps files, clears log)",
            handler: async (args, ctx) => {
                (ctx as any).args = parseCommandArgs(args);
                await accept(ctx);
            },
        });

        pi.registerCommand("filechanges-decline", {
            description: "Decline pi-made changes (reverts files, clears log)",
            handler: async (args, ctx) => {
                (ctx as any).args = parseCommandArgs(args);
                await decline(ctx);
            },
        });
    }

    // ── Legacy in-process API for subagents (each extension has its own registry) ──

    registerExtensionApi<FilechangesApi>("filechanges", {
        trackFile: async (
            ctx: any,
            relPath: string,
            absPath: string,
            originalContent: string | null,
        ): Promise<void> => {
            const added = await tracker.trackFile(relPath, absPath, originalContent);
            if (added) {
                appendBaseline(relPath, originalContent);
                refresh();
            }
        },
    });

    return {
        tracker,
        rebuildFromSession,
        track: async (relPath, absPath, originalContent) => {
            const added = await tracker.trackFile(relPath, absPath, originalContent);
            if (added) {
                appendBaseline(relPath, originalContent);
                refresh();
            }
            return added;
        },
        accept,
        decline,
        refresh,
    };
}
