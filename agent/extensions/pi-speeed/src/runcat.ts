import type { ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config";

export const RUNCAT_FRAMES = [" ", " ", " ", " ", " "];

export type RunCatState = {
    intervalMs: number;
};

export function runcatInterval(config: Config, speed: number | null) {
    if (speed === null || !Number.isFinite(speed) || speed <= 0)
        return config.defaultRuncatIntervalMs;
    return Math.max(
        config.minRuncatIntervalMs,
        Math.min(config.maxRuncatIntervalMs, Math.round(config.runcatScale / speed)),
    );
}

export function applyRunCatIndicator(
    ctx: ExtensionContext,
    config: Config,
    state: RunCatState,
    speed: number | null = null,
    force = false,
) {
    if (!ctx.hasUI || !ctx.ui.setWorkingIndicator) return;
    if (!config.runcat) {
        ctx.ui.setWorkingIndicator();
        return;
    }
    const nextInterval = runcatInterval(config, speed);
    const intervalChanged = Math.abs(nextInterval - state.intervalMs) >= 10;
    if (!force && !intervalChanged) return;

    const indicator: WorkingIndicatorOptions = {
        frames: RUNCAT_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
        intervalMs: nextInterval,
    };
    ctx.ui.setWorkingIndicator(indicator);
    state.intervalMs = nextInterval;
}
