import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface ConfiguredModel {
    provider?: string;
    id?: string;
    thinking?: ModelThinkingLevel;
}

/**
 * A model entry is usable only when it names both a provider and an id; missing
 * either leaves the worker it configures off. The menu reports and the workers
 * resolve through this one rule, so what the menu shows is what runs.
 */
export function isModelTarget(
    model: ConfiguredModel | undefined,
): model is ConfiguredModel & { provider: string; id: string } {
    return Boolean(model?.provider && model.id);
}

export interface BlackholeConfig {
    showWorkerMessages?: boolean;
    compaction?: "auto" | "manual" | "off";
    compactionEngine?: "blackhole" | "pi-default";
    compactAfterTokens?: number;
    compactAfterRatio?: number;
    compactReserveTokens?: number;
    memory?: boolean;
    observeAfterTokens?: number;
    reflectAfterTokens?: number;
    observationsPoolMaxTokens?: number;
    observationsPoolTargetTokens?: number;
    /** Token cap for the reflection pool (summaries + worker preambles). */
    reflectionsPoolMaxTokens?: number;
    dropperPressureThreshold?: number;
    observerChunkMaxTokens?: number;
    model?: ConfiguredModel;
    observerModel?: ConfiguredModel;
    reflectorModel?: ConfiguredModel;
    recallResponseMaxChars?: number;
}

export const DEFAULT_CONFIG: BlackholeConfig = {
    showWorkerMessages: true,
    compaction: "auto",
    compactionEngine: "blackhole",
    memory: true,
    observeAfterTokens: 25000,
    reflectAfterTokens: 80000,
    observationsPoolMaxTokens: 40000,
    observationsPoolTargetTokens: 20000,
    reflectionsPoolMaxTokens: 8000,
    dropperPressureThreshold: 0.7,
    observerChunkMaxTokens: 60000,
    recallResponseMaxChars: 4000,
};

export function getBlackholeDataDir(): string {
    return join(getAgentDir(), "pi-blackhole");
}

export function getBlackholeConfigPath(): string {
    return join(getBlackholeDataDir(), "pi-blackhole-config.json");
}

export function loadBlackholeConfig(): BlackholeConfig {
    const configPath = getBlackholeConfigPath();
    if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
    try {
        const raw = JSON.parse(readFileSync(configPath, "utf8"));
        return { ...DEFAULT_CONFIG, ...raw };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

/**
 * Set one key in the on-disk config, leaving the rest of the file alone so
 * hand-written notes and keys this extension does not define survive. An
 * `undefined` value removes the key, restoring that setting's default.
 *
 * Returns false without writing when the existing file is unreadable, so a
 * corrupt config is never replaced by the caller's partial view.
 */
export function setBlackholeConfigValue(key: keyof BlackholeConfig, value: unknown): boolean {
    const configPath = getBlackholeConfigPath();
    let raw: Record<string, unknown> = {};
    if (existsSync(configPath)) {
        try {
            raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
        } catch {
            return false;
        }
    }
    try {
        if (value === undefined) delete raw[key];
        else raw[key] = value;
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf8");
        return true;
    } catch {
        return false;
    }
}

export function getAutoCompactThreshold(config: BlackholeConfig, contextWindow: number): number {
    if (typeof config.compactAfterTokens === "number" && config.compactAfterTokens > 0) {
        return config.compactAfterTokens;
    }
    if (
        typeof config.compactAfterRatio === "number" &&
        config.compactAfterRatio > 0 &&
        config.compactAfterRatio <= 1
    ) {
        return Math.max(1, Math.floor(contextWindow * config.compactAfterRatio));
    }
    if (typeof config.compactReserveTokens === "number" && config.compactReserveTokens > 0) {
        return Math.max(1, contextWindow - config.compactReserveTokens);
    }
    if (contextWindow <= 32768) return Math.max(1, Math.floor(contextWindow * 0.9));
    if (contextWindow <= 131072) return Math.max(1, Math.floor(contextWindow * 0.8));
    if (contextWindow <= 262144) return Math.max(1, Math.floor(contextWindow * 0.7));
    return Math.max(1, Math.floor(contextWindow * 0.65));
}
