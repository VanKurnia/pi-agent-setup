import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const STATUS_ID = "pi-speeed";
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-speeed.json");
export const CUSTOM_OPTION = "Custom...";
export const RANDOM_OPTION = "Random";
export const RANDOM_VALUE = "__random__";
export const OFF_OPTION = "Off";
export const OFF_VALUE = "__off__";

export type CountStrategy = "estimate" | "direct";

export type Config = {
    enabled: boolean;
    runcat: boolean;
    label: string;
    footerPrefix: string;
    workingPrefix: string;
    icon: string;
    footer: boolean;
    renderIntervalMs: number;
    speedAnimationMs: number;
    defaultRuncatIntervalMs: number;
    minRuncatIntervalMs: number;
    maxRuncatIntervalMs: number;
    runcatScale: number;
    slidingWindowMs: number;
    minReliableDurationMs: number;
    maxDisplayTokS: number;
    useProviderTokens: boolean;
    countStrategy: CountStrategy;
    persistStats: boolean;
};

export const DEFAULT_CONFIG: Config = {
    enabled: true,
    runcat: true,
    label: "tok/s",
    footerPrefix: "session avg",
    workingPrefix: "Working...",
    icon: "✦",
    footer: true,
    renderIntervalMs: 250,
    speedAnimationMs: 1800,
    defaultRuncatIntervalMs: 167,
    minRuncatIntervalMs: 50,
    maxRuncatIntervalMs: 250,
    runcatScale: 6000,
    slidingWindowMs: 1000,
    minReliableDurationMs: 1000,
    maxDisplayTokS: 500,
    useProviderTokens: true,
    countStrategy: "estimate",
    persistStats: true,
};

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function booleanFrom(raw: unknown, fallback: boolean) {
    return typeof raw === "boolean" ? raw : fallback;
}

function stringFrom(raw: unknown, fallback: string) {
    return typeof raw === "string" ? raw : fallback;
}

function positiveNumberFrom(raw: unknown, fallback: number) {
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function countStrategyFrom(raw: unknown, fallback: CountStrategy): CountStrategy {
    return raw === "estimate" || raw === "direct" ? raw : fallback;
}

export function normalizeConfig(raw: unknown): Config {
    const input = asRecord(raw);
    const config: Config = {
        enabled: booleanFrom(input.enabled, DEFAULT_CONFIG.enabled),
        runcat: booleanFrom(input.runcat, DEFAULT_CONFIG.runcat),
        label: stringFrom(input.label, DEFAULT_CONFIG.label),
        footerPrefix: stringFrom(input.footerPrefix, DEFAULT_CONFIG.footerPrefix),
        workingPrefix: stringFrom(input.workingPrefix, DEFAULT_CONFIG.workingPrefix),
        icon: stringFrom(input.icon, DEFAULT_CONFIG.icon),
        footer: booleanFrom(input.footer, DEFAULT_CONFIG.footer),
        renderIntervalMs: positiveNumberFrom(
            input.renderIntervalMs,
            DEFAULT_CONFIG.renderIntervalMs,
        ),
        speedAnimationMs: positiveNumberFrom(
            input.speedAnimationMs,
            DEFAULT_CONFIG.speedAnimationMs,
        ),
        defaultRuncatIntervalMs: positiveNumberFrom(
            input.defaultRuncatIntervalMs,
            DEFAULT_CONFIG.defaultRuncatIntervalMs,
        ),
        minRuncatIntervalMs: positiveNumberFrom(
            input.minRuncatIntervalMs,
            DEFAULT_CONFIG.minRuncatIntervalMs,
        ),
        maxRuncatIntervalMs: positiveNumberFrom(
            input.maxRuncatIntervalMs,
            DEFAULT_CONFIG.maxRuncatIntervalMs,
        ),
        runcatScale: positiveNumberFrom(input.runcatScale, DEFAULT_CONFIG.runcatScale),
        slidingWindowMs: positiveNumberFrom(input.slidingWindowMs, DEFAULT_CONFIG.slidingWindowMs),
        minReliableDurationMs: positiveNumberFrom(
            input.minReliableDurationMs,
            DEFAULT_CONFIG.minReliableDurationMs,
        ),
        maxDisplayTokS: positiveNumberFrom(input.maxDisplayTokS, DEFAULT_CONFIG.maxDisplayTokS),
        useProviderTokens: booleanFrom(input.useProviderTokens, DEFAULT_CONFIG.useProviderTokens),
        countStrategy: countStrategyFrom(input.countStrategy, DEFAULT_CONFIG.countStrategy),
        persistStats: booleanFrom(input.persistStats, DEFAULT_CONFIG.persistStats),
    };

    if (config.minRuncatIntervalMs > config.maxRuncatIntervalMs) {
        config.minRuncatIntervalMs = DEFAULT_CONFIG.minRuncatIntervalMs;
        config.maxRuncatIntervalMs = DEFAULT_CONFIG.maxRuncatIntervalMs;
    }

    return config;
}

export function loadConfig(): Config {
    try {
        if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
        return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

export function saveConfig(config: Config) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}
