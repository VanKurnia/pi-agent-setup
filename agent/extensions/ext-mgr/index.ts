/**
 * ext-mgr — extension manager with named presets.
 * Registers the `/extensions` command, lazily loading the discovery and
 * UI manager on first execution.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extMgr(pi: ExtensionAPI) {
    pi.registerCommand("extensions", {
        description: "Manage extensions and plugins — toggle on/off or save/restore presets",
        handler: async (args, ctx) => {
            const { handleExtensionsCommand } = await import("./manager.js");
            await handleExtensionsCommand(args, ctx);
        },
    });
}
