/**
 * Custom Header Extension
 *
 * Replaces the built-in startup header with an identical copy you can customize.
 * Edit the `buildHeader()` function below to change what's shown at startup.
 *
 * Usage: Just edit this file and run /reload in pi.
 * To restore the built-in header: rename/delete this file and /reload.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
// ponytail: keyHint/rawKeyHint removed as unused (Plan 020)

/**
 * Build the header text. This is what you customize.
 *
 * Currently replicates the built-in header exactly:
 *   - App name + version
 *   - Keybinding hints
 *
 * To customize, just edit the `logo` or `hints` array below.
 */
function buildHeader(theme: Theme): string {
    // ── Logo ──────────────────────────────────────────────
    // Change this to whatever you want as the title line.

    const ascii_art_2 = [
        "   ███████████████████████████╗  ",
        "   ╚══██████╔════════██████╔══╝  ",
        "      ██████║        ██████║     ",
        "      ██████║        ██████║     ",
        "      ██████║        ██████║     ",
        "      ██████║        ██████║     ",
        "      ██████║        ██████║     ",
        "   ████████████╗  ████████████╗  ",
        "   ╚═══════════╝  ╚═══════════╝  ",
    ]
        .map((line) => theme.bold(theme.fg("warning", line)))
        .join("\n");

    const logo =
        "\n" +
        ascii_art_2 +
        "\n\n" +
        theme.bold(theme.fg("accent", "")) +
        theme.fg("dim", ` v${VERSION}`);

    // ── Keybinding hints ─────────────────────────────────
    // Each entry is one line. Remove, reorder, or add your own.
    // ponytail: hints list kept for future keybinding display; not currently rendered
    return logo;
}

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        if (!ctx.hasUI) return;

        ctx.ui.setHeader((_tui, theme) => ({
            render(_width: number): string[] {
                return buildHeader(theme).split("\n");
            },
            invalidate() {},
        }));
    });

    // Command to restore the built-in header
    pi.registerCommand("builtin-header", {
        description: "Restore the built-in startup header",
        handler: async (_args, ctx) => {
            ctx.ui.setHeader(undefined);
            ctx.ui.notify("Built-in header restored", "info");
        },
    });
}
