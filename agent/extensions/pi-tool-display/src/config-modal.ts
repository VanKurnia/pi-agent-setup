import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getToolDisplayConfigPath } from "./support.js";
import {
    detectToolDisplayPreset,
    getToolDisplayPresetConfig,
    parseToolDisplayPreset,
    TOOL_DISPLAY_PRESETS,
    type ToolDisplayPreset,
} from "./presets.js";
import { shortenPath } from "./render-utils.js";
import type { InspectorSettingItem } from "./settings-inspector-modal.js";
import { type ToolDisplayConfig } from "./support.js";

interface ToolDisplayConfigController {
    getConfig(): ToolDisplayConfig;
    setConfig(next: ToolDisplayConfig, ctx: ExtensionCommandContext): void;
}

interface ModalOverlayOptions {
    anchor: "center";
    width: number;
    maxHeight: number;
    margin: number;
}

const PREVIEW_LINE_VALUES = ["4", "8", "12", "20", "40"] as const;
const PRESET_COMMAND_HINT = TOOL_DISPLAY_PRESETS.join("|");

function toOnOff(value: boolean): string {
    return value ? "on" : "off";
}

function summarizeConfig(config: ToolDisplayConfig): string {
    const preset = detectToolDisplayPreset(config);
    return [
        `preset=${preset}`,
        `userBox=${toOnOff(config.enableNativeUserMessageBox)}`,
        `collapseAfterTurn=${toOnOff(config.collapseAfterTurn)}`,
        `preview=${config.previewLines}`,
        `expandedMax=${config.expandedPreviewMaxLines}`,
    ].join(", ");
}

function parseNumber(value: string, fallback: number): number {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function buildAdvancedNotes(extra: readonly string[]): string[] {
    return [
        ...extra,
        "Manual JSON edits also expose expandedPreviewMaxLines, which bounds how large an expanded card may grow.",
        "Every tool is rendered as a pi-style boxed card, so there is no per-tool ownership or output-mode switch.",
    ];
}

function buildInspectorSettings(config: ToolDisplayConfig): InspectorSettingItem[] {
    const configPath = shortenPath(getToolDisplayConfigPath());
    const items: InspectorSettingItem[] = [
        {
            id: "preset",
            label: "Preset profile",
            currentValue: detectToolDisplayPreset(config),
            values: TOOL_DISPLAY_PRESETS,
            inspectorTitle: "Preset Profile",
            inspectorSummary: [
                "Determines how much output a tool card shows before it is expanded.",
                "Presets set previewLines and expandedPreviewMaxLines together so they stay coherent.",
            ],
            inspectorOptions: [
                "opencode — 8 collapsed lines, 4000 line expansion cap",
                "balanced — 12 collapsed lines, 8000 line expansion cap",
                "verbose — 20 collapsed lines, 20000 line expansion cap",
                "custom — shown automatically when the current values match no preset",
            ],
            inspectorAdvanced: buildAdvancedNotes([
                "Presets reset multiple fields together, so manual JSON tuning is the right place for durable custom combinations.",
            ]),
            inspectorPath: configPath,
            searchTerms: ["verbosity", "profile", "layout", "custom", ...TOOL_DISPLAY_PRESETS],
        },
        {
            id: "previewLines",
            label: "Preview lines",
            currentValue: String(config.previewLines),
            values: PREVIEW_LINE_VALUES,
            inspectorTitle: "Preview Lines",
            inspectorSummary: [
                "Sets how many lines a tool card shows while it is collapsed.",
                "Accepted manual range: 1 to 80 lines. The quick selector cycles through a curated set for fast tuning.",
            ],
            inspectorOptions: [
                "Lower values keep transcripts dense and skimmable",
                "Higher values surface more source context before expansion",
            ],
            inspectorAdvanced: buildAdvancedNotes([
                "Pair this with expandedPreviewMaxLines when you want larger expanded previews without making collapsed output noisy.",
            ]),
            inspectorPath: configPath,
            searchTerms: ["preview", "lines", "range", "collapsed", "read", "grep", "mcp", "bash"],
        },
        {
            id: "collapseAfterTurn",
            label: "Collapse tools after turn",
            currentValue: toOnOff(config.collapseAfterTurn),
            values: ["off", "on"],
            inspectorTitle: "Collapse Tools After Turn",
            inspectorSummary: [
                "Collapses a finished turn's tool calls into a single summary line when the turn completes without errors or interruptions.",
                "Turns with errors or interruptions stay expanded, and the global expand toggle restores full tool output at any time.",
            ],
            inspectorOptions: [
                "off — keep every tool block inline (default)",
                "on — collapse clean turns to one summary line",
            ],
            inspectorAdvanced: buildAdvancedNotes([
                "This is an opt-in presentation toggle; it does not change tool behavior.",
            ]),
            inspectorPath: configPath,
            searchTerms: ["turn", "collapse", "summary", "tools", "expand"],
        },
        {
            id: "enableNativeUserMessageBox",
            label: "Native user message box",
            currentValue: toOnOff(config.enableNativeUserMessageBox),
            values: ["on", "off"],
            inspectorTitle: "Native User Message Box",
            inspectorSummary: [
                "Toggles the bordered native renderer used for user prompts inside the Pi transcript.",
                "Keep it on when you want clearer message separation, or turn it off to fall back to Pi's default user message rendering.",
            ],
            inspectorOptions: [
                "on — bordered native user prompt box",
                "off — default Pi prompt rendering",
            ],
            inspectorAdvanced: buildAdvancedNotes([
                "This switch only affects presentation. It does not change stored prompts, markdown handling, or tool behavior.",
            ]),
            inspectorPath: configPath,
            searchTerms: ["user", "message", "box", "prompt", "native"],
        },
    ];

    return items;
}

function applyPreset(preset: ToolDisplayPreset): ToolDisplayConfig {
    return getToolDisplayPresetConfig(preset);
}

function applySetting(config: ToolDisplayConfig, id: string, value: string): ToolDisplayConfig {
    switch (id) {
        case "preset": {
            const parsed = parseToolDisplayPreset(value);
            return parsed ? applyPreset(parsed) : config;
        }
        case "enableNativeUserMessageBox":
            return {
                ...config,
                enableNativeUserMessageBox: value === "on",
            };
        case "collapseAfterTurn":
            return {
                ...config,
                collapseAfterTurn: value === "on",
            };
        case "previewLines":
            return {
                ...config,
                previewLines: parseNumber(value, config.previewLines),
            };
        default:
            return config;
    }
}

function resolveResponsiveOverlayOptions(): ModalOverlayOptions {
    const terminalWidth =
        typeof process.stdout.columns === "number" && Number.isFinite(process.stdout.columns)
            ? process.stdout.columns
            : 120;
    const terminalHeight =
        typeof process.stdout.rows === "number" && Number.isFinite(process.stdout.rows)
            ? process.stdout.rows
            : 36;

    const margin = 1;
    const availableWidth = Math.max(72, terminalWidth - margin * 2);
    const preferredWidth =
        terminalWidth >= 170 ? 128 : terminalWidth >= 145 ? 118 : terminalWidth >= 120 ? 106 : 92;
    const width = Math.max(72, Math.min(preferredWidth, availableWidth));

    const availableHeight = Math.max(14, terminalHeight - margin * 2);
    const preferredHeight = Math.max(14, Math.floor(terminalHeight * 0.78));
    const maxHeight = Math.min(preferredHeight, availableHeight);

    return {
        anchor: "center",
        width,
        maxHeight,
        margin,
    };
}

async function openSettingsModal(
    ctx: ExtensionCommandContext,
    controller: ToolDisplayConfigController,
): Promise<void> {
    const overlayOptions = resolveResponsiveOverlayOptions();

    const [{ ZellijModal }, { SplitPaneInspectorModal }] = await Promise.all([
        import("./zellij-modal.js"),
        import("./settings-inspector-modal.js"),
    ]);

    await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
            const inspector = new SplitPaneInspectorModal(
                {
                    getSettings: () => buildInspectorSettings(controller.getConfig()),
                    onChange: (id, newValue) => {
                        const next = applySetting(controller.getConfig(), id, newValue);
                        controller.setConfig(next, ctx);
                    },
                    onClose: () => done(),
                },
                theme,
            );

            const modal = new ZellijModal(
                inspector,
                {
                    borderStyle: "square",
                    padding: 0,
                    titleBar: {},
                    overlay: overlayOptions,
                },
                theme,
            );

            return {
                render: (width: number) => modal.renderModal(width).lines,
                invalidate: () => modal.invalidate(),
                handleInput(data: string) {
                    modal.handleInput(data);
                    tui.requestRender();
                },
            };
        },
        { overlay: true, overlayOptions },
    );
}

function handleToolDisplayArgs(
    args: string,
    ctx: ExtensionCommandContext,
    controller: ToolDisplayConfigController,
): boolean {
    const raw = args.trim();
    if (!raw) {
        return false;
    }

    const normalized = raw.toLowerCase();

    if (normalized === "show") {
        ctx.ui.notify(`tool-display: ${summarizeConfig(controller.getConfig())}`, "info");
        return true;
    }

    if (normalized === "reset") {
        controller.setConfig(getToolDisplayPresetConfig("opencode"), ctx);
        ctx.ui.notify("Tool display preset reset to opencode.", "info");
        return true;
    }

    if (normalized.startsWith("preset ")) {
        const candidate = normalized.slice("preset ".length).trim();
        const preset = parseToolDisplayPreset(candidate);
        if (!preset) {
            ctx.ui.notify(
                `Unknown preset. Use: /tool-display preset ${PRESET_COMMAND_HINT}`,
                "warning",
            );
            return true;
        }

        controller.setConfig(getToolDisplayPresetConfig(preset), ctx);
        ctx.ui.notify(`Tool display preset set to ${preset}.`, "info");
        return true;
    }

    ctx.ui.notify(`Usage: /tool-display [show|reset|preset ${PRESET_COMMAND_HINT}]`, "warning");
    return true;
}

export async function runToolDisplayCommandHandler(
    args: string,
    ctx: ExtensionCommandContext,
    controller: ToolDisplayConfigController,
): Promise<void> {
    if (handleToolDisplayArgs(args, ctx, controller)) {
        return;
    }

    if (!ctx.hasUI) {
        ctx.ui.notify("/tool-display requires interactive TUI mode.", "warning");
        return;
    }

    await openSettingsModal(ctx, controller);
}
