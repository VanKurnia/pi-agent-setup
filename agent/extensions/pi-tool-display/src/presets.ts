import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "./support.js";

export const TOOL_DISPLAY_PRESETS = ["opencode", "balanced", "verbose"] as const;
export type ToolDisplayPreset = (typeof TOOL_DISPLAY_PRESETS)[number];

/** Presets differ only in how much output a card shows before it is expanded. */
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
    if (!normalized) {
        return undefined;
    }
    return TOOL_DISPLAY_PRESETS.find((preset) => preset === normalized);
}
