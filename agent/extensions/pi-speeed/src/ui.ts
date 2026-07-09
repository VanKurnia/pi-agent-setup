import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

export async function showReadOnlyPanel(ctx: ExtensionContext, title: string, body: string) {
    if (ctx.mode !== "tui") {
        ctx.ui.notify(body, "info");
        return;
    }

    await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        const mdTheme = getMarkdownTheme();

        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
        container.addChild(new Markdown(body, 1, 1, mdTheme));
        container.addChild(new Text(theme.fg("dim", "Press Enter, q, or Esc to close"), 1, 0));
        container.addChild(border);

        return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
                if (matchesKey(data, "enter") || matchesKey(data, "escape") || data === "q")
                    done(undefined);
            },
        };
    });
}
