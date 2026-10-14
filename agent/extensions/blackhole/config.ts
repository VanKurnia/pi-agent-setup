import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface ConfiguredModel {
    provider?: string;
    id?: string;
    thinking?: ModelThinkingLevel;
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
