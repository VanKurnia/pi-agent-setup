/** Shared interactive UI for session-mgr commands. */

import type {
    ExtensionCommandContext,
    KeybindingsManager,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
    Container,
    SelectList,
    Text,
    Input,
    fuzzyFilter,
    getKeybindings,
} from "@earendil-works/pi-tui";
import type { SelectItem, SelectListTheme, TUI } from "@earendil-works/pi-tui";

/** Ask for a session name. Re-prompts on empty input. Returns undefined on cancel. */
export async function promptForName(
    ctx: ExtensionCommandContext,
    title: string,
    prefill?: string,
): Promise<string | undefined> {
    if (!ctx.hasUI) {
        ctx.ui.notify(
            `${title}: no dialog available. Pass a name inline, e.g. /rclone my-name.`,
            "error",
        );
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

/** Bottom-docked searchable picker. Returns the picked value, or null on cancel. */
export async function showPicker(
    ctx: ExtensionCommandContext,
    title: string,
    hint: string,
    buildItems: (theme: Theme) => SelectItem[],
): Promise<string | null> {
    return ctx.ui.custom<string | null>(
        (tui: TUI, theme: Theme, _kb: KeybindingsManager, done: PickerDone) => {
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

            const search = new Input();
            search.focused = true;
            container.addChild(search);

            const allItems = buildItems(theme);

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
                fresh.onSelect = (item) => done(item.value);
                fresh.onCancel = () => done(null);
                return fresh;
            };
            let list = makeList(allItems);
            container.addChild(list);
            const refreshList = () => {
                const query = search.getValue().trim();
                const matched = query ? fuzzyFilter(allItems, query, (i) => i.value) : allItems;
                const idx = container.children.indexOf(list);
                list = makeList(matched);
                container.children.splice(idx, 1, list);
                container.invalidate();
            };

            container.addChild(new Text(theme.fg("dim", hint), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

            const kb = getKeybindings();
            const view = {
                render: (w: number) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data: string) => {
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
