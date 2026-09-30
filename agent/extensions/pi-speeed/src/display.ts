import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config";

type Theme = ExtensionContext["ui"]["theme"];

// Two-character icons starting with a badge opener glyph are rendered as a
// wrapping pair (opener ... closer); every other value is a plain prefix.
const BADGE_CLOSERS: Record<string, string> = {
    "\uE0B6": "\uE0B4",
    "\uE0C7": "\uE0C6",
};

function styledSpeedText(theme: Theme, config: Config, speed: number | null) {
    const value = speed === null ? "--" : speed.toFixed(1);
    const valueTone = speed === null ? "dim" : "accent";
    return `${theme.fg(valueTone, value)} ${theme.fg("dim", config.label)}`;
}

function styledSpeedBadge(theme: Theme, config: Config, speed: number | null) {
    const speedText = styledSpeedText(theme, config, speed);
    const icon = config.icon.trim();
    if (icon === "none" || icon === "") return speedText;
    if (icon.length === 2 && BADGE_CLOSERS[icon[0]] === icon[1])
        return `${theme.fg("accent", icon[0])}${speedText}${theme.fg("accent", icon[1])}`;
    return `${theme.fg("accent", icon)} ${speedText}`;
}

export function renderStyledWorkingTokS(theme: Theme, config: Config, speed: number | null) {
    return `${theme.fg("muted", config.workingPrefix)}  ${styledSpeedBadge(theme, config, speed)}`;
}

export function clearUi(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setWorkingMessage();
}
