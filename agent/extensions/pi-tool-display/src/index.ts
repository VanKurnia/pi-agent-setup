import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    disposeAll,
    loadToolDisplayConfig,
    normalizeToolDisplayConfig,
    resetDisposed,
    saveToolDisplayConfig,
    type ToolDisplayConfig,
} from "./support.js";
import {
    installPistyleToolRendererPatch,
    registerNativeUserMessageBox,
    registerThinkingLabeling,
    registerToolDecoration,
    removePistyleToolRendererPatch,
    resetPistyleRegistries,
} from "./wiring.js";

export default function toolDisplayExtension(pi: ExtensionAPI): void {
    const initial = loadToolDisplayConfig();
    if (!initial.config.enabled) {
        return;
    }

    resetDisposed();

    pi.on("session_shutdown", (event: { reason: string }) => {
        resetPistyleRegistries();
        if (event.reason === "reload") {
            removePistyleToolRendererPatch();
            disposeAll();
        }
    });

    let config: ToolDisplayConfig = initial.config;
    let pendingLoadError = initial.error;

    const getConfig = (): ToolDisplayConfig => config;

    const setConfig = (next: ToolDisplayConfig, ctx: ExtensionCommandContext): void => {
        const normalized = normalizeToolDisplayConfig(next);
        config = normalized;

        const saved = saveToolDisplayConfig(normalized);
        if (!saved.success && saved.error) {
            ctx.ui.notify(saved.error, "error");
        }
    };

    registerToolDecoration(pi, getConfig);
    installPistyleToolRendererPatch(getConfig);
    registerNativeUserMessageBox(pi, getConfig);
    registerThinkingLabeling(pi);

    pi.registerCommand("tool-display", {
        description: "Configure tool output rendering (OpenCode-style)",
        handler: async (args, ctx) => {
            const { runToolDisplayCommandHandler } = await import("./config-modal.js");
            await runToolDisplayCommandHandler(args, ctx, { getConfig, setConfig });
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        resetPistyleRegistries();
        if (pendingLoadError) {
            ctx.ui.notify(pendingLoadError, "warning");
            pendingLoadError = undefined;
        }
    });
}
