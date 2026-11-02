/**
 * filechanges — the **TUI frontend** of the log.
 *
 * The log itself (tracking, session entries, accept/decline) lives in
 * `shared/filechanges-core.ts` and is installed by whatever frontend loads
 * first. This file only draws: the status line, the widget, and the
 * `/filechanges` overlay. Disable it and the log still works; the herdr
 * sidebar keeps showing what it always showed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, Key, Markdown, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import {
    installFileChangeCore,
    parseCommandArgs,
    type FileChangeTracker,
} from "../shared/filechanges-core.ts";

function formatAddedRemovedPlain(added: number, removed: number): string {
    return `(+${added}/-${removed})`;
}

function styleAddedRemovedForList(theme: any, text: string): string {
    // File rows use "+x/-y" as description; other rows use normal sentences.
    const m = text.match(/^\+(\d+)\/-(\d+)$/);
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
        const plus =
            t.added === 0 ? theme.fg("text", `+${t.added}`) : theme.fg("success", `+${t.added}`);
        const minus =
            t.removed === 0
                ? theme.fg("text", `-${t.removed}`)
                : theme.fg("error", `-${t.removed}`);
        const counts =
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

export default function (pi: ExtensionAPI) {
    let ctx: any = null;

    const core = installFileChangeCore(pi, {
        owner: "filechanges-tui",
        onChange: () => updateUi(),
    });
    const tracker: FileChangeTracker = core.tracker;

    function updateUi(): void {
        if (!ctx?.hasUI) return;
        ctx.ui.setStatus("filechanges", formatStatus(tracker, ctx.ui.theme));
        ctx.ui.setWidget("filechanges", buildWidgetLines(tracker, ctx.ui.theme));
    }

    // State changes come from the core; these hooks only keep a ctx for repaints.
    pi.on("session_start", async (_event, sessionCtx) => {
        ctx = sessionCtx;
        updateUi();
    });
    pi.on("session_tree", async (_event, sessionCtx) => {
        ctx = sessionCtx;
        updateUi();
    });
    pi.on("tool_result", async (_event, sessionCtx) => {
        ctx = sessionCtx;
        updateUi();
    });

    pi.registerCommand("filechanges", {
        description: "Show files changed by pi and inspect diffs",
        handler: async (_args, cmdCtx) => {
            (cmdCtx as any).args = parseCommandArgs(_args);

            await cmdCtx.waitForIdle();
            ctx = cmdCtx;
            updateUi();

            if (!cmdCtx.hasUI) {
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
                await cmdCtx.waitForIdle();
                updateUi();

                const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
                if (items.length === 0) {
                    cmdCtx.ui.notify("filechanges: no pi-made modifications recorded.", "info");
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

                const picked = await cmdCtx.ui.custom<string | null>(
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
                    await core.accept(cmdCtx);
                    return;
                }
                if (picked === "__decline__") {
                    await core.decline(cmdCtx);
                    return;
                }

                const t = tracker.getTracked(picked);
                if (!t) {
                    cmdCtx.ui.notify("filechanges: entry not found (maybe log was cleared).", "warning");
                    continue;
                }

                const md = "```diff\n" + (t.diff.trimEnd() || "(no diff)") + "\n```";
                await cmdCtx.ui.custom<void>(
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
}
