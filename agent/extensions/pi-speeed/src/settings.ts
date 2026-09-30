import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Config, DEFAULT_CONFIG } from "./config";

async function promptText(ctx: ExtensionContext, title: string, current: string) {
    const value = await ctx.ui.input(title, current);
    return value === undefined ? current : value;
}

async function promptNumber(ctx: ExtensionContext, title: string, current: number) {
    const value = await ctx.ui.input(title, String(current));
    if (value === undefined) return current;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : current;
}

export async function openSettings(
    ctx: ExtensionContext,
    getConfig: () => Config,
    setConfig: (config: Config) => void,
    applyConfig: () => void,
) {
    while (true) {
        let config = getConfig();
        const choice = await ctx.ui.select("pi-speeed settings", [
            `Enabled: ${config.enabled ? "on" : "off"}`,
            `Label: ${config.label}`,
            `Working prefix: ${config.workingPrefix}`,
            `Speed badge icon: ${config.icon}`,
            `Render interval: ${config.renderIntervalMs}ms`,
            "Reset defaults",
            "Done",
        ]);
        if (!choice || choice === "Done") return;

        config = { ...config };
        if (choice.startsWith("Enabled:")) config.enabled = !config.enabled;
        else if (choice.startsWith("Label:"))
            config.label = await promptText(ctx, "Speed label", config.label);
        else if (choice.startsWith("Working prefix:"))
            config.workingPrefix = await promptText(ctx, "Working prefix", config.workingPrefix);
        else if (choice.startsWith("Speed badge icon:"))
            config.icon = await promptText(
                ctx,
                "Speed badge icon (empty or none = no icon)",
                config.icon,
            );
        else if (choice.startsWith("Render interval:"))
            config.renderIntervalMs = await promptNumber(
                ctx,
                "Render interval ms",
                config.renderIntervalMs,
            );
        else if (choice === "Reset defaults") {
            if (await ctx.ui.confirm("Reset pi-speeed?", "Restore default settings?"))
                config = { ...DEFAULT_CONFIG };
        }
        setConfig(config);
        applyConfig();
        ctx.ui.notify("pi-speeed config saved", "info");
    }
}
