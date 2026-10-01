/**
 * extmgr — toggle-only extension manager.
 *
 * Forked from `pi-extmgr@0.3.0` (MIT, github.com/ayagmar/pi-extmgr) and reduced to the one
 * thing this setup uses: turning things on and off. Two sections:
 *
 *   Extensions — local extensions; toggling renames the entry file to `<file>.disabled`
 *   Plugins    — packages from `agent/settings.json`; toggling writes the `extensions: []`
 *                filter, so a package stops contributing without being uninstalled
 *
 *   /extensions          section menu → toggle picker
 *   /extensions list     plain-text listing of both sections
 *   /extensions plugins  jump straight to the plugin picker
 *
 * Inside a picker: Enter toggles, `⇧S` saves and offers to reload the session immediately,
 * Esc exits and leaves the reload manual. Uninstalling a package outright stays with the
 * `pi` CLI (`pi remove npm:<pkg>`), which also owns `pi config` for per-resource toggles.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatListing, showExtensionPicker, showManager, showPluginPicker } from "./src/ui.js";

async function listAll(ctx: ExtensionCommandContext): Promise<void> {
    ctx.ui.notify(await formatListing(ctx), "info");
}

export default function extmgr(pi: ExtensionAPI) {
    pi.registerCommand("extensions", {
        description: "Toggle local extensions and plugins on/off",
        handler: async (args, ctx) => {
            const sub = args.trim().toLowerCase();

            if (!ctx.hasUI || sub === "list") {
                await listAll(ctx);
                return;
            }
            if (sub === "") {
                await showManager(ctx);
                return;
            }
            if (sub === "extensions") {
                await showExtensionPicker(ctx);
                return;
            }
            if (sub === "plugins") {
                await showPluginPicker(ctx);
                return;
            }
            ctx.ui.notify(
                `Unknown subcommand "${sub}". Use /extensions, /extensions list, /extensions extensions or /extensions plugins.`,
                "warning",
            );
        },
    });
}
