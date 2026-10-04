import { createTwoFilesPatch } from "diff";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    DynamicBorder,
    getMarkdownTheme,
    isEditToolResult,
    isToolCallEventType,
    isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, Key, Markdown, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { registerExtensionApi } from "../shared/cross-extension-api.js";
import type { FilechangesApi } from "../subagents/src/core.js";

// ── Inlined from tracker.ts (file deleted) ───────────────────────────
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

function normalizeToolPath(cwd: string, raw: string): { absPath: string; relPath: string } {
    const cleaned = stripAtPrefix(raw);
    const absPath = resolve(cwd, cleaned);
    const rel = relative(cwd, absPath).replace(/\\/g, "/");
    const cleanedNormalized = cleaned.replace(/\\/g, "/");
    const relPath = rel && !rel.startsWith("..") && rel !== "" ? rel : cleanedNormalized;
    return { absPath, relPath };
}

async function readTextOrNull(absPath: string): Promise<string | null> {
    try {
        return await readFile(absPath, "utf-8");
    } catch {
        return null;
    }
}

function countDiffLines(unifiedDiff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of unifiedDiff.split("\n")) {
        if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
    }
    return { added, removed };
}

function patchFromBaseline(displayPath: string, original: string | null, current: string): string {
    return createTwoFilesPatch(displayPath, displayPath, original ?? "", current, "", "", {
        context: 3,
    });
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
                if (!data?.path) continue;
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
                if (!data?.path) continue;
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

// Re-export helper for external use
export { normalizeToolPath, readTextOrNull, countDiffLines, patchFromBaseline };

function formatAddedRemovedPlain(added: number, removed: number): string {
    return `(+${added}/-${removed})`;
}

function styleAddedRemovedForList(theme: any, text: string): string {
    // File rows use "+x/-y" as description; other rows use normal sentences.
    const m = text.match(/^\+(\d+)\/\-(\d+)$/);
    if (!m) return theme.fg("muted", text);
    const added = Number(m[1]);
    const removed = Number(m[2]);

    const plus = added === 0 ? theme.fg("text", `+${added}`) : theme.fg("success", `+${added}`);
    const minus =
        removed === 0 ? theme.fg("text", `-${removed}`) : theme.fg("error", `-${removed}`);
    return plus + theme.fg("text", "/") + minus;
}

function formatStatus(tracker: FileChangeTracker, theme?: any): string | undefined {
    const size = tracker.getTrackedSize();
    if (size === 0) return undefined;
    let edited = 0;
    let created = 0;
    for (const t of tracker.getAllTracked()) {
        if (t.kind === "new") created++;
        else edited++;
    }
    if (!theme) {
        return `Δ ${edited}  + ${created}`;
    }
    return theme.fg("muted", `Δ ${edited}  + ${created}`);
}

function buildWidgetLines(tracker: FileChangeTracker, theme?: any): string[] | undefined {
    const size = tracker.getTrackedSize();
    if (size === 0) return undefined;
    const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
    const max = 8;
    const lines: string[] = [];

    for (const t of items.slice(0, max)) {
        const tag = t.kind === "new" ? "+" : "Δ";

        if (!theme) {
            lines.push(`${tag} ${t.displayPath} ${formatAddedRemovedPlain(t.added, t.removed)}`);
            continue;
        }

        const prefix = theme.fg("muted", `${tag} `) + theme.fg("muted", `${t.displayPath} `);
        let counts: string;
        const plus =
            t.added === 0 ? theme.fg("text", `+${t.added}`) : theme.fg("success", `+${t.added}`);
        const minus =
            t.removed === 0
                ? theme.fg("text", `-${t.removed}`)
                : theme.fg("error", `-${t.removed}`);
        counts =
            theme.fg("text", "(") + plus + theme.fg("text", "/") + minus + theme.fg("text", ")");

        lines.push(prefix + counts);
    }
    if (items.length > max) {
        lines.push(
            theme
                ? theme.fg("dim", `…and ${items.length - max} more`)
                : `…and ${items.length - max} more`,
        );
    }
    return lines;
}

async function ensureParentDir(absPath: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
}

export default function (pi: ExtensionAPI) {
    const tracker = new FileChangeTracker();

    function updateUi(ctx: any) {
        if (!ctx?.hasUI) return;

        ctx.ui.setStatus("filechanges", formatStatus(tracker, ctx.ui.theme));
        ctx.ui.setWidget("filechanges", buildWidgetLines(tracker, ctx.ui.theme));
    }

    // ── Cross-extension API for subagent file tracking ──────────────

    registerExtensionApi<FilechangesApi>("filechanges", {
        trackFile: async (
            ctx: any,
            relPath: string,
            absPath: string,
            originalContent: string | null,
        ): Promise<void> => {
            const added = await tracker.trackFile(relPath, absPath, originalContent);
            if (added) {
                pi.appendEntry(ENTRY_BASELINE, {
                    path: relPath,
                    originalContent,
                    timestamp: Date.now(),
                });
                updateUi(ctx);
            }
        },
    });

    async function clearLog(ctx: ExtensionCommandContext, reason: "accept" | "decline") {
        tracker.clear();
        pi.appendEntry(ENTRY_CLEAR, { timestamp: Date.now(), reason });
        updateUi(ctx);
    }

    async function declineAll(ctx: ExtensionCommandContext) {
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
            // Don't clear — let user retry the failed files
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

    async function acceptAll(ctx: ExtensionCommandContext) {
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

    function parseCommandArgs(args: string | undefined): string[] {
        if (!args) return [];
        return args
            .split(/\s+/g)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    // Commands
    pi.registerCommand("filechanges", {
        description: "Show files changed by pi and inspect diffs",
        handler: async (_args, ctx) => {
            (ctx as any).args = parseCommandArgs(_args);

            await ctx.waitForIdle();
            updateUi(ctx);

            if (!ctx.hasUI) {
                const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
                if (items.length === 0) {
                    console.log("filechanges: no pi-made modifications recorded.");
                    return;
                }
                const lines = buildWidgetLines(tracker) ?? [];
                console.log(lines.join("\n"));
                return;
            }

            // Interactive loop: ESC in diff view returns to the modification log.
            while (true) {
                await ctx.waitForIdle();
                updateUi(ctx);

                const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
                if (items.length === 0) {
                    ctx.ui.notify("filechanges: no pi-made modifications recorded.", "info");
                    return;
                }

                const selectItems: SelectItem[] = [
                    {
                        value: "__accept__",
                        label: "Accept changes (clear log)",
                        description: "Keep current files",
                    },
                    {
                        value: "__decline__",
                        label: "Undo changes (revert)",
                        description: "Restore original contents",
                    },
                    { value: "__sep__", label: "────────", description: "" },
                    ...items.map((t) => ({
                        value: t.path,
                        label: `${t.kind === "new" ? "+" : "Δ"} ${t.displayPath}`,
                        description: `+${t.added}/-${t.removed}`,
                    })),
                ];

                const picked = await ctx.ui.custom<string | null>(
                    (tui, theme, _kb, done) => {
                        const container = new Container();
                        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                        container.addChild(
                            new Text(theme.fg("accent", theme.bold("File changes")), 1, 0),
                        );

                        const list = new SelectList(selectItems, Math.min(14, selectItems.length), {
                            selectedPrefix: (t) => theme.fg("accent", t),
                            selectedText: (t) => theme.fg("accent", t),
                            description: (t) => styleAddedRemovedForList(theme, t),
                            scrollInfo: (t) => theme.fg("dim", t),
                            noMatch: (t) => theme.fg("warning", t),
                        });

                        list.onSelect = (item) => {
                            if (item.value === "__sep__") return;
                            done(item.value);
                        };
                        list.onCancel = () => done(null);
                        container.addChild(list);

                        container.addChild(
                            new Text(
                                theme.fg("dim", "↑↓ navigate • enter select • esc close"),
                                1,
                                0,
                            ),
                        );
                        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

                        return {
                            render: (w) => container.render(w),
                            invalidate: () => container.invalidate(),
                            handleInput: (data) => {
                                list.handleInput(data);
                                tui.requestRender();
                            },
                        };
                    },
                    { overlay: true },
                );

                if (!picked) return;
                if (picked === "__accept__") {
                    await acceptAll(ctx);
                    return;
                }
                if (picked === "__decline__") {
                    await declineAll(ctx);
                    return;
                }

                const t = tracker.getTracked(picked);
                if (!t) {
                    ctx.ui.notify(
                        "filechanges: entry not found (maybe log was cleared).",
                        "warning",
                    );
                    continue;
                }

                const md = "```diff\n" + (t.diff.trimEnd() || "(no diff)") + "\n```";
                await ctx.ui.custom<void>(
                    (tui, theme, _kb, done) => {
                        const container = new Container();
                        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                        container.addChild(
                            new Text(theme.fg("accent", theme.bold(t.displayPath)), 1, 0),
                        );
                        container.addChild(new Markdown(md, 1, 0, getMarkdownTheme()));
                        container.addChild(new Text(theme.fg("dim", "esc to go back"), 1, 0));
                        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

                        return {
                            render: (w) => container.render(w),
                            invalidate: () => container.invalidate(),
                            handleInput: (data) => {
                                if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))
                                    done();
                                else tui.requestRender();
                            },
                        };
                    },
                    { overlay: true },
                );

                // After closing diff, loop back to the modification log.
            }
        },
    });

    pi.registerCommand("filechanges-accept", {
        description: "Accept pi-made changes (keeps files, clears log)",
        handler: async (args, ctx) => {
            (ctx as any).args = parseCommandArgs(args);
            await acceptAll(ctx);
        },
    });

    pi.registerCommand("filechanges-decline", {
        description: "Decline pi-made changes (reverts files, clears log)",
        handler: async (args, ctx) => {
            (ctx as any).args = parseCommandArgs(args);
            await declineAll(ctx);
        },
    });

    async function rebuildFromSession(ctx: any): Promise<void> {
        await tracker.rebuildFromEntries(ctx.sessionManager.getBranch(), ctx.cwd);
        updateUi(ctx);
    }

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
            const { absPath, relPath } = normalizeToolPath(ctx.cwd, event.input.path);
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

        // If no baseline exists yet for this file, create one now from the successful call's snapshot.
        if (!tracker.hasBaseline(pending.path)) {
            await tracker.trackFile(pending.path, pending.absPath, pending.before);
            pi.appendEntry(ENTRY_BASELINE, {
                path: pending.path,
                originalContent: pending.before,
                timestamp: Date.now(),
            });
        } else {
            // Recompute cumulative diff against baseline
            await tracker.recomputeTrackedFile(pending.path);
        }

        // If recomputeTrackedFile already removed the entry (file reverted to
        // baseline or created-then-deleted), clean up the baseline too.
        if (tracker.hasBaseline(pending.path) && !tracker.getTracked(pending.path)) {
            tracker.deleteBaseline(pending.path);
            pi.appendEntry(ENTRY_UNTRACK, { path: pending.path, timestamp: Date.now() });
        }

        updateUi(ctx);
    });
}
