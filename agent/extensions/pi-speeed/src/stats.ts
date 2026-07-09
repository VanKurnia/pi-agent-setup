import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const STATS_PATH = join(homedir(), ".pi", "agent", "pi-speeed-stats.json");

export type RecentStat = {
    endedAt: number;
    model: string;
    provider: string;
    api: string;
    outputTokens: number;
    durationMs: number;
    /** Sanitized tokens-per-second for this completed assistant message. */
    tokS: number | null;
    stopReason: string;
};

export type StatsBucket = {
    messages: number;
    outputTokens: number;
    durationMs: number;
    tokSValues: number[];
    maxTokS: number | null;
    minTokS: number | null;
    avgTokS: number | null;
    medianTokS: number | null;
};

export type AggregateStats = {
    schemaVersion: 2;
    totals: StatsBucket;
    byModel: Record<string, StatsBucket>;
    stopReasons: Record<string, number>;
    recent: RecentStat[];
};

const MAX_RECENT = 200;

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function finiteNumber(value: unknown, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableFiniteNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringFrom(value: unknown, fallback = "") {
    return typeof value === "string" ? value : fallback;
}

function numberArrayFrom(value: unknown) {
    return Array.isArray(value)
        ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
        : [];
}

export function median(values: number[]) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function emptyBucket(): StatsBucket {
    return {
        messages: 0,
        outputTokens: 0,
        durationMs: 0,
        tokSValues: [],
        maxTokS: null,
        minTokS: null,
        avgTokS: null,
        medianTokS: null,
    };
}

export function emptyStats(): AggregateStats {
    return {
        schemaVersion: 2,
        totals: emptyBucket(),
        byModel: {},
        stopReasons: {},
        recent: [],
    };
}

function normalizeBucket(rawBucket: unknown): StatsBucket {
    const bucket = asRecord(rawBucket);
    const tokSValues = numberArrayFrom(bucket.tokSValues).concat(
        numberArrayFrom(bucket.medianTokSValues),
    );
    const normalized = {
        messages: finiteNumber(bucket.messages),
        outputTokens: finiteNumber(bucket.outputTokens),
        durationMs: finiteNumber(bucket.durationMs),
        tokSValues,
        maxTokS: nullableFiniteNumber(bucket.maxTokS ?? bucket.maxMedianTokS),
        minTokS: nullableFiniteNumber(bucket.minTokS ?? bucket.minMedianTokS),
        avgTokS: nullableFiniteNumber(bucket.avgTokS),
        medianTokS: nullableFiniteNumber(bucket.medianTokS ?? bucket.medianOfMediansTokS),
    };

    if (normalized.medianTokS === null) normalized.medianTokS = median(normalized.tokSValues);
    if (normalized.maxTokS === null && normalized.tokSValues.length > 0)
        normalized.maxTokS = Math.max(...normalized.tokSValues);
    if (normalized.minTokS === null && normalized.tokSValues.length > 0)
        normalized.minTokS = Math.min(...normalized.tokSValues);
    if (normalized.avgTokS === null && normalized.durationMs > 0)
        normalized.avgTokS = normalized.outputTokens / (normalized.durationMs / 1000);
    return normalized;
}

function normalizeByModel(rawByModel: unknown) {
    const byModel = asRecord(rawByModel);
    return Object.fromEntries(
        Object.entries(byModel).map(([model, bucket]) => [model, normalizeBucket(bucket)]),
    );
}

function normalizeRecentStat(rawStat: unknown): RecentStat | null {
    const stat = asRecord(rawStat);
    const endedAt = finiteNumber(stat.endedAt);
    const outputTokens = finiteNumber(stat.outputTokens);
    const durationMs = finiteNumber(stat.durationMs);
    if (endedAt <= 0 && outputTokens <= 0 && durationMs <= 0) return null;
    return {
        endedAt,
        model: stringFrom(stat.model, "unknown"),
        provider: stringFrom(stat.provider, "unknown"),
        api: stringFrom(stat.api, "unknown"),
        outputTokens,
        durationMs,
        tokS: nullableFiniteNumber(stat.tokS ?? stat.medianTokS ?? stat.avgTokS),
        stopReason: stringFrom(stat.stopReason, "unknown"),
    };
}

export function normalizeStats(raw: unknown): AggregateStats {
    const input = asRecord(raw);
    const stopReasons = Object.fromEntries(
        Object.entries(asRecord(input.stopReasons)).map(([reason, count]) => [
            reason,
            finiteNumber(count),
        ]),
    );
    return {
        schemaVersion: 2,
        totals: normalizeBucket(input.totals),
        byModel: normalizeByModel(input.byModel),
        stopReasons,
        recent: (Array.isArray(input.recent) ? input.recent : [])
            .map(normalizeRecentStat)
            .filter((stat): stat is RecentStat => stat !== null),
    };
}

export function loadStats(): AggregateStats {
    try {
        if (!existsSync(STATS_PATH)) return emptyStats();
        return normalizeStats(JSON.parse(readFileSync(STATS_PATH, "utf8")));
    } catch {
        return emptyStats();
    }
}

export function saveStats(stats: AggregateStats) {
    writeFileSync(STATS_PATH, `${JSON.stringify(normalizeStats(stats), null, 2)}\n`);
}

function addToBucket(bucket: StatsBucket, stat: RecentStat) {
    bucket.messages += 1;
    bucket.outputTokens += stat.outputTokens;
    bucket.durationMs += stat.durationMs;
    if (stat.tokS !== null && Number.isFinite(stat.tokS)) {
        bucket.tokSValues.push(stat.tokS);
        bucket.maxTokS = bucket.maxTokS === null ? stat.tokS : Math.max(bucket.maxTokS, stat.tokS);
        bucket.minTokS = bucket.minTokS === null ? stat.tokS : Math.min(bucket.minTokS, stat.tokS);
    }
    bucket.avgTokS =
        bucket.durationMs > 0 ? bucket.outputTokens / (bucket.durationMs / 1000) : null;
    bucket.medianTokS = median(bucket.tokSValues);
}

function isSpeedEligible(stat: RecentStat) {
    return stat.stopReason !== "error" && stat.stopReason !== "aborted";
}

export function recordStat(stats: AggregateStats, stat: RecentStat) {
    if (isSpeedEligible(stat)) {
        addToBucket(stats.totals, stat);
        const modelKey = `${stat.provider}/${stat.model}`;
        stats.byModel[modelKey] ??= emptyBucket();
        addToBucket(stats.byModel[modelKey], stat);
    }
    stats.stopReasons[stat.stopReason] = (stats.stopReasons[stat.stopReason] ?? 0) + 1;
    stats.recent.push(stat);
    if (stats.recent.length > MAX_RECENT) stats.recent = stats.recent.slice(-MAX_RECENT);
}

function formatTokS(value: number | null) {
    return value === null ? "--" : value.toFixed(1);
}

export function summarizeStats(stats: AggregateStats) {
    const bestModel = Object.entries(stats.byModel)
        .filter(([, bucket]) => bucket.medianTokS !== null)
        .sort((a, b) => (b[1].medianTokS ?? 0) - (a[1].medianTokS ?? 0))[0];
    const last = stats.recent[stats.recent.length - 1];
    return [
        `messages: ${stats.totals.messages}`,
        `output tokens: ${Math.round(stats.totals.outputTokens)}`,
        `avg: ${formatTokS(stats.totals.avgTokS)} tok/s`,
        `median: ${formatTokS(stats.totals.medianTokS)} tok/s`,
        `fastest: ${formatTokS(stats.totals.maxTokS)} tok/s`,
        `slowest: ${formatTokS(stats.totals.minTokS)} tok/s`,
        `best model: ${bestModel ? `${bestModel[0]} (${formatTokS(bestModel[1].medianTokS)} tok/s)` : "--"}`,
        `last: ${last ? `${formatTokS(last.tokS)} tok/s, ${last.outputTokens} tok, ${(last.durationMs / 1000).toFixed(1)}s` : "--"}`,
    ].join("\n");
}
