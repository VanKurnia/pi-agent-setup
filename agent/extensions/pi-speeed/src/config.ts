import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-speeed.json");

export type CountStrategy = "estimate" | "direct";

export type Config = {
    enabled: boolean;
    label: string;
    workingPrefix: string;
    icon: string;
    renderIntervalMs: number;
    speedAnimationMs: number;
    slidingWindowMs: number;
    minReliableDurationMs: number;
    maxDisplayTokS: number;
    useProviderTokens: boolean;
    countStrategy: CountStrategy;
};

export const DEFAULT_CONFIG: Config = {
    enabled: true,
    label: "tok/s",
    workingPrefix: "Working...",
    icon: "✦",
    renderIntervalMs: 250,
    speedAnimationMs: 1800,
    slidingWindowMs: 1000,
    minReliableDurationMs: 1000,
    maxDisplayTokS: 500,
    useProviderTokens: true,
    countStrategy: "estimate",
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
        label: stringFrom(input.label, DEFAULT_CONFIG.label),
        workingPrefix: stringFrom(input.workingPrefix, DEFAULT_CONFIG.workingPrefix),
        icon: stringFrom(input.icon, DEFAULT_CONFIG.icon),
        renderIntervalMs: positiveNumberFrom(
            input.renderIntervalMs,
            DEFAULT_CONFIG.renderIntervalMs,
        ),
        speedAnimationMs: positiveNumberFrom(
            input.speedAnimationMs,
            DEFAULT_CONFIG.speedAnimationMs,
        ),
        slidingWindowMs: positiveNumberFrom(input.slidingWindowMs, DEFAULT_CONFIG.slidingWindowMs),
        minReliableDurationMs: positiveNumberFrom(
            input.minReliableDurationMs,
            DEFAULT_CONFIG.minReliableDurationMs,
        ),
        maxDisplayTokS: positiveNumberFrom(input.maxDisplayTokS, DEFAULT_CONFIG.maxDisplayTokS),
        useProviderTokens: booleanFrom(input.useProviderTokens, DEFAULT_CONFIG.useProviderTokens),
        countStrategy: countStrategyFrom(input.countStrategy, DEFAULT_CONFIG.countStrategy),
    };

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
