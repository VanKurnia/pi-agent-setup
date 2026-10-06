import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    disposeAll,
    loadToolDisplayConfig,
    normalizeToolDisplayConfig,
    resetDisposed,
    saveToolDisplayConfig,
    DEFAULT_TOOL_DISPLAY_CONFIG,
    type ToolDisplayConfig,
} from "./support.js";
import {
    registerNativeUserMessageBox,
    registerPistyleToolRenderer,
    registerThinkingLabeling,
    registerToolDecoration,
    resetPistyleRegistries,
} from "./wiring.js";

// ── Lifecycle Utilities ─────────────────────────────────────────────────────

export function onReloadShutdown(pi: ExtensionAPI, cleanup: () => void): void {
    pi.on("session_shutdown", async (event: { reason?: string }) => {
        if (event?.reason === "reload") {
            cleanup();
        }
    });
}

// ── Render Utilities ────────────────────────────────────────────────────────

export function shortenPath(inputPath: string | undefined): string {
    if (!inputPath) return "";
    const home = homedir();
    return inputPath.startsWith(home) ? `~${inputPath.slice(home.length)}` : inputPath;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
    return count === 1 ? singular : plural;
}

export function previewLines(
    lines: string[],
    maxLines: number,
): { shown: string[]; remaining: number } {
    const limit = Math.max(0, maxLines);
    const shown = lines.slice(0, limit);
    const remaining = Math.max(0, lines.length - shown.length);
    return { shown, remaining };
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const TOOL_DISPLAY_PRESETS = ["opencode", "balanced", "verbose"] as const;
export type ToolDisplayPreset = (typeof TOOL_DISPLAY_PRESETS)[number];

const TOOL_DISPLAY_PRESET_CONFIGS: Record<ToolDisplayPreset, ToolDisplayConfig> = {
    opencode: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG,
    },
    balanced: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG,
        previewLines: 12,
        expandedPreviewMaxLines: 8000,
    },
    verbose: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG,
        previewLines: 20,
        expandedPreviewMaxLines: 20_000,
    },
};

function configsEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
    return (
        a.enabled === b.enabled &&
        a.enableNativeUserMessageBox === b.enableNativeUserMessageBox &&
        a.collapseAfterTurn === b.collapseAfterTurn &&
        a.previewLines === b.previewLines &&
        a.expandedPreviewMaxLines === b.expandedPreviewMaxLines
    );
}

export function getToolDisplayPresetConfig(preset: ToolDisplayPreset): ToolDisplayConfig {
    return { ...TOOL_DISPLAY_PRESET_CONFIGS[preset] };
}

export function detectToolDisplayPreset(config: ToolDisplayConfig): ToolDisplayPreset | "custom" {
    for (const preset of TOOL_DISPLAY_PRESETS) {
        if (configsEqual(config, TOOL_DISPLAY_PRESET_CONFIGS[preset])) {
            return preset;
        }
    }
    return "custom";
}

export function parseToolDisplayPreset(raw: string): ToolDisplayPreset | undefined {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return undefined;
    return TOOL_DISPLAY_PRESETS.find((preset) => preset === normalized);
}

// ── Main Extension Entry Point ──────────────────────────────────────────────

export default function toolDisplayExtension(pi: ExtensionAPI): void {
    const initial = loadToolDisplayConfig();
    if (!initial.config.enabled) {
        return;
    }

    resetDisposed();

    pi.on("session_shutdown", (event: { reason: string }) => {
        resetPistyleRegistries();
        if (event.reason === "reload") {
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
    registerPistyleToolRenderer(pi, getConfig);
    registerNativeUserMessageBox(pi, getConfig);
    registerThinkingLabeling(pi);

    pi.registerCommand("tool-display", {
        description:
            "Configure tool output rendering (presets: opencode | balanced | verbose | reload)",
        handler: async (args, ctx) => {
            const trimmed = (args || "").trim().toLowerCase();
            const preset = parseToolDisplayPreset(trimmed);
            if (preset) {
                const target = getToolDisplayPresetConfig(preset);
                setConfig(target, ctx);
                ctx.ui.notify(
                    `Applied preset "${preset}" (previewLines: ${target.previewLines})`,
                    "info",
                );
            } else if (trimmed === "reload") {
                const refreshed = loadToolDisplayConfig();
                config = refreshed.config;
                ctx.ui.notify("tool-display configuration reloaded", "info");
            } else {
                const currentPreset = detectToolDisplayPreset(config);
                ctx.ui.notify(
                    `tool-display: preset=${currentPreset}, previewLines=${config.previewLines}, expandedMax=${config.expandedPreviewMaxLines}`,
                    "info",
                );
            }
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
