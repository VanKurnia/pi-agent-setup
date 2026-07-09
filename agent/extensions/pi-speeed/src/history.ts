import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config";
import type { CompletedMessageSpeed } from "./speed-tracker";
import { type AggregateStats, type RecentStat, recordStat, saveStats } from "./stats";

export type AssistantMessageMetadata = {
    endedAt: number;
    model: string;
    provider: string;
    api: string;
    responseId?: string;
    stopReason: string;
};

export function recordCompletedMessageSpeed(
    pi: ExtensionAPI,
    config: Config,
    aggregateStats: AggregateStats,
    completed: CompletedMessageSpeed,
    metadata: AssistantMessageMetadata,
    saveAggregateStats = saveStats,
) {
    const recentStat: RecentStat = {
        endedAt: metadata.endedAt,
        model: metadata.model,
        provider: metadata.provider,
        api: metadata.api,
        outputTokens: completed.outputTokens,
        durationMs: completed.durationMs,
        tokS: completed.tokS,
        stopReason: metadata.stopReason,
    };

    recordStat(aggregateStats, recentStat);
    saveAggregateStats(aggregateStats);

    if (!config.persistStats) return;
    pi.appendEntry("pi-speeed-stats", {
        schemaVersion: 3,
        startedAt: metadata.endedAt - completed.durationMs,
        endedAt: metadata.endedAt,
        durationMs: completed.durationMs,
        outputTokens: completed.outputTokens,
        tokS: completed.tokS,
        model: metadata.model,
        provider: metadata.provider,
        api: metadata.api,
        responseId: metadata.responseId,
        stopReason: metadata.stopReason,
    });
}
