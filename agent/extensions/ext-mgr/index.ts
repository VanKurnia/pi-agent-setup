/**
 * ext-mgr — toggle-only extension manager.
 * Registers the `/extensions` command, lazily loading the discovery and
 * UI manager on first execution.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extMgr(pi: ExtensionAPI) {
    pi.registerCommand("extensions", {
        description: "Toggle local extensions and plugins on/off",
        handler: async (args, ctx) => {
            const { handleExtensionsCommand } = await import("./manager.js");
            await handleExtensionsCommand(args, ctx);
        },
    });
}
