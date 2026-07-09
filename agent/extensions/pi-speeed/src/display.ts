import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    type Config,
    OFF_OPTION,
    OFF_VALUE,
    RANDOM_OPTION,
    RANDOM_VALUE,
    STATUS_ID,
} from "./config";
import { LABEL_PRESETS, randomPreset, WORKING_PREFIX_PRESETS } from "./presets";

type Theme = ExtensionContext["ui"]["theme"];

export function resolvePreset(value: string, presets: string[]) {
    return value === RANDOM_VALUE ? randomPreset(presets) : value;
}

export function displayPreset(value: string) {
    if (value === RANDOM_VALUE) return RANDOM_OPTION;
    if (value === OFF_VALUE) return OFF_OPTION;
    return value;
}

export type OccurrenceText = {
    label: string | null;
    workingPrefix: string | null;
};

export function chooseOccurrenceText(config: Config): OccurrenceText {
    return {
        label: resolvePreset(config.label, LABEL_PRESETS),
        workingPrefix: resolvePreset(config.workingPrefix, WORKING_PREFIX_PRESETS),
    };
}

export function formatSpeed(config: Config, occurrence: OccurrenceText, speed: number | null) {
    const label = occurrence.label ?? resolvePreset(config.label, LABEL_PRESETS);
    return speed === null ? `-- ${label}` : `${speed.toFixed(1)} ${label}`;
}

export function renderFooterTokS(config: Config, occurrence: OccurrenceText, speed: number | null) {
    const speedText = formatSpeed(config, occurrence, speed);
    return config.footerPrefix === OFF_VALUE ? speedText : `${config.footerPrefix} ${speedText}`;
}

function speedBadge(config: Config, occurrence: OccurrenceText, speed: number | null) {
    if (config.icon === "none" || config.icon.trim() === "")
        return formatSpeed(config, occurrence, speed);
    if (config.icon.length === 2 && config.icon.startsWith(""))
        return `${formatSpeed(config, occurrence, speed)}`;
    if (config.icon.length === 2 && config.icon.startsWith(""))
        return `${formatSpeed(config, occurrence, speed)}`;
    return `${config.icon} ${formatSpeed(config, occurrence, speed)}`;
}

export function renderWorkingTokS(
    config: Config,
    occurrence: OccurrenceText,
    speed: number | null,
) {
    const left =
        occurrence.workingPrefix ?? resolvePreset(config.workingPrefix, WORKING_PREFIX_PRESETS);
    return `${left}  ${speedBadge(config, occurrence, speed)}`;
}

function styledSpeedText(
    theme: Theme,
    config: Config,
    occurrence: OccurrenceText,
    speed: number | null,
) {
    const label = occurrence.label ?? resolvePreset(config.label, LABEL_PRESETS);
    const value = speed === null ? "--" : speed.toFixed(1);
    const valueTone = speed === null ? "dim" : "accent";
    return `${theme.fg(valueTone, value)} ${theme.fg("dim", label)}`;
}

function styledSpeedBadge(
    theme: Theme,
    config: Config,
    occurrence: OccurrenceText,
    speed: number | null,
) {
    const speedText = styledSpeedText(theme, config, occurrence, speed);
    const icon = config.icon.trim();
    if (icon === "none" || icon === "") return speedText;
    if (icon.length === 2 && icon.startsWith(""))
        return `${theme.fg("accent", "")}${speedText}${theme.fg("accent", "")}`;
    if (icon.length === 2 && icon.startsWith(""))
        return `${theme.fg("accent", "")}${speedText}${theme.fg("accent", "")}`;
    return `${theme.fg("accent", icon)} ${speedText}`;
}

export function renderStyledFooterTokS(
    theme: Theme,
    config: Config,
    occurrence: OccurrenceText,
    speed: number | null,
) {
    const speedText = styledSpeedText(theme, config, occurrence, speed);
    if (config.footerPrefix === OFF_VALUE) return speedText;
    return `${theme.fg("dim", config.footerPrefix)} ${speedText}`;
}

export function renderStyledWorkingTokS(
    theme: Theme,
    config: Config,
    occurrence: OccurrenceText,
    speed: number | null,
) {
    const left =
        occurrence.workingPrefix ?? resolvePreset(config.workingPrefix, WORKING_PREFIX_PRESETS);
    return `${theme.fg("muted", left)}  ${styledSpeedBadge(theme, config, occurrence, speed)}`;
}

export function updateStatus(ctx: ExtensionContext, config: Config, text: string) {
    if (!ctx.hasUI) return;
    if (!config.enabled || !config.footer) {
        ctx.ui.setStatus(STATUS_ID, undefined);
        return;
    }
    ctx.ui.setStatus(STATUS_ID, text);
}

export function clearUi(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_ID, undefined);
    ctx.ui.setWorkingMessage();
    if (ctx.ui.setWorkingIndicator) ctx.ui.setWorkingIndicator();
}
