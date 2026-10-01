/**
 * Shared interactive picker UI for extension commands: bottom-docked border, title, fuzzy
 * search box, themed list, hint line.
 */

import type {
    ExtensionCommandContext,
    KeybindingsManager,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Key,
    SelectList,
    Text,
    Input,
    fuzzyFilter,
    getKeybindings,
    matchesKey,
} from "@earendil-works/pi-tui";
import type { SelectItem, SelectListTheme, TUI } from "@earendil-works/pi-tui";

/** Ask for a text value. Re-prompts on empty input. Returns undefined on cancel. */
export async function promptForName(
    ctx: ExtensionCommandContext,
    title: string,
    prefill?: string,
): Promise<string | undefined> {
    if (!ctx.hasUI) {
        ctx.ui.notify(`${title}: no dialog available. Pass the value inline instead.`, "error");
        return undefined;
    }
    for (;;) {
        const answer = await ctx.ui.input(title, prefill);
        if (answer === undefined) return undefined;
        if (answer.trim().length === 0) {
            ctx.ui.notify("Name cannot be empty. Try again or press Esc to cancel.", "warning");
        } else {
            return answer.trim();
        }
    }
}

type PickerDone = (result: string | null) => void;

export interface PickerOptions {
    /**
     * Called when an item is confirmed.
     *
     * - Return an array to keep the dialog open and re-render it with those items — use
     *   this for in-place actions such as toggles.
     * - Return `"close"` or nothing to close the dialog and resolve with the picked value.
     *
     * Async is supported; the list refreshes when the promise settles.
     */
    onPick?: (
        value: string,
        theme: Theme,
    ) => SelectItem[] | "close" | void | Promise<SelectItem[] | "close" | void>;

    /**
     * Enables the uppercase `S` shortcut, which takes precedence over the search box. The
     * dialog closes and resolves with `null`, so a caller that must tell a save from a cancel
     * records that here.
     */
    onSave?: () => void;

    /**
     * Treat Space as confirm while the search box is empty, for pickers whose confirm action
     * is a toggle. With a query typed, Space keeps inserting a space into the search.
     */
    spaceConfirms?: boolean;
}

/**
 * Bottom-docked searchable picker. Returns the picked value, or null on cancel.
 *
 * The search box matches each item's `value`, so callers that want name search should put
 * searchable text there.
 */
export async function showPicker(
    ctx: ExtensionCommandContext,
    title: string,
    hint: string,
    buildItems: (theme: Theme) => SelectItem[],
    options: PickerOptions = {},
): Promise<string | null> {
    return ctx.ui.custom<string | null>(
        (tui: TUI, theme: Theme, _kb: KeybindingsManager, done: PickerDone) => {
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

            const search = new Input();
            search.focused = true;
            container.addChild(search);

            let allItems = buildItems(theme);

            const listTheme: SelectListTheme = {
                selectedPrefix: (t: string) => theme.fg("accent", t),
                selectedText: (t: string) => theme.fg("accent", t),
                description: (t: string) => theme.fg("dim", t),
                scrollInfo: (t: string) => theme.fg("dim", t),
                noMatch: (t: string) => theme.fg("warning", t),
            };
            const makeList = (items: SelectItem[]) => {
                const fresh = new SelectList(
                    items,
                    Math.min(14, Math.max(items.length, 1)),
                    listTheme,
                );
                fresh.onSelect = (item) => {
                    void handlePick(item.value);
                };
                fresh.onCancel = () => done(null);
                return fresh;
            };
            let list = makeList(allItems);
            container.addChild(list);

            const refreshList = (keepValue?: string) => {
                const query = search.getValue().trim();
                const matched = query ? fuzzyFilter(allItems, query, (i) => i.value) : allItems;
                const idx = container.children.indexOf(list);
                list = makeList(matched);
                if (keepValue !== undefined) {
                    const restored = matched.findIndex((item) => item.value === keepValue);
                    if (restored >= 0) list.setSelectedIndex(restored);
                }
                container.children.splice(idx, 1, list);
                container.invalidate();
            };

            const handlePick = async (value: string): Promise<void> => {
                if (!options.onPick) {
                    done(value);
                    return;
                }
                const next = await options.onPick(value, theme);
                if (next === undefined || next === "close") {
                    done(value);
                    return;
                }
                allItems = next;
                // Keep the cursor on the item that was just acted on, not back at the top.
                refreshList(value);
                tui.requestRender();
            };

            container.addChild(new Text(theme.fg("dim", hint), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

            const kb = getKeybindings();
            const view = {
                render: (w: number) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data: string) => {
                    if (options.onSave && data === "S") {
                        options.onSave();
                        done(null);
                        return;
                    }
                    const hasQuery = search.getValue().trim().length > 0;
                    if (
                        options.spaceConfirms &&
                        !hasQuery &&
                        (matchesKey(data, Key.space) || data === " ")
                    ) {
                        const selected = list.getSelectedItem();
                        if (selected) void handlePick(selected.value);
                        tui.requestRender();
                        return;
                    }
                    if (
                        kb.matches(data, "tui.select.up") ||
                        kb.matches(data, "tui.select.down") ||
                        kb.matches(data, "tui.select.confirm") ||
                        kb.matches(data, "tui.select.cancel")
                    ) {
                        list.handleInput(data);
                    } else {
                        search.handleInput(data);
                        refreshList();
                    }
                    tui.requestRender();
                },
            };
            return view;
        },
    );
}
