import type { Config } from "./config";

export type TokenEvent = { time: number; tokens: number };

const COMPACTION_THRESHOLD = 5000;

export type EngineConfig = Pick<
    Config,
    | "slidingWindowMs"
    | "minReliableDurationMs"
    | "maxDisplayTokS"
    | "useProviderTokens"
    | "countStrategy"
>;

export function estimateTokensFromDelta(text: string, strategy: Config["countStrategy"]) {
    if (!text) return 0;
    if (strategy === "direct") return 1;
    const matches = text.match(/\w+|[^\s\w]/g);
    return matches ? matches.length : 0;
}

export class TokenSpeedEngine {
    private _isStreaming = false;
    private _tokenCount = 0;
    private _startTime = 0;
    private _endTime = 0;
    private _events: TokenEvent[] = [];
    private _windowStartIndex = 0;
    private _countedUsageOutput = 0;
    private _lastStableTokS = 0;

    constructor(private _config: EngineConfig) {}

    updateConfig(config: EngineConfig) {
        this._config = config;
    }

    get isStreaming() {
        return this._isStreaming;
    }

    get tokenCount() {
        return this._tokenCount;
    }

    get elapsedMs() {
        if (this._startTime === 0) return 0;
        if (this._isStreaming) return Date.now() - this._startTime;
        return this._endTime - this._startTime;
    }

    get avgTokS() {
        const elapsedSec = this.elapsedMs / 1000;
        if (elapsedSec <= 0) return 0;
        return this._tokenCount / elapsedSec;
    }

    sanitizeTokS(value: number | null, durationMs = this.elapsedMs) {
        if (value === null || !Number.isFinite(value) || value <= 0) return null;
        if (durationMs < this._config.minReliableDurationMs) return null;
        if (value > this._config.maxDisplayTokS) return null;
        return value;
    }

    /** Sliding-window tok/s; suppresses unreliable burst-only readings. */
    get tokS() {
        const candidate = this.rawTokS;
        const stable = this.sanitizeTokS(candidate);
        if (stable !== null) this._lastStableTokS = stable;
        return this._lastStableTokS;
    }

    /** Unsanitized sliding-window tok/s; useful for tests and diagnostics. */
    get rawTokS() {
        if (this.elapsedMs < this._config.slidingWindowMs) return this.avgTokS;
        if (!this._isStreaming) return this.avgTokS;

        const now = Date.now();
        const windowStart = now - this._config.slidingWindowMs;

        while (
            this._windowStartIndex < this._events.length &&
            this._events[this._windowStartIndex].time < windowStart
        ) {
            this._windowStartIndex++;
        }

        if (this._windowStartIndex >= this._events.length) return this.avgTokS;

        let windowTokenCount = 0;
        for (let i = this._windowStartIndex; i < this._events.length; i++) {
            windowTokenCount += this._events[i].tokens;
        }
        if (windowTokenCount === 0) return this.avgTokS;

        const windowDuration = (now - this._events[this._windowStartIndex].time) / 1000;
        if (windowDuration <= 0) return 0;

        return windowTokenCount / windowDuration;
    }

    start() {
        this._tokenCount = 0;
        this._isStreaming = true;
        this._startTime = Date.now();
        this._endTime = Date.now();
        this._events = [];
        this._windowStartIndex = 0;
        this._countedUsageOutput = 0;
        this._lastStableTokS = 0;
    }

    stop() {
        this._isStreaming = false;
        this._endTime = Date.now();
        this._events = [];
        this._windowStartIndex = 0;
    }

    recordDelta(delta: string, usageOutput?: number) {
        if (!this._isStreaming) return;

        if (
            this._config.useProviderTokens &&
            usageOutput !== undefined &&
            usageOutput > this._countedUsageOutput
        ) {
            this.recordTokens(usageOutput - this._countedUsageOutput);
            this._countedUsageOutput = usageOutput;
            return;
        }

        this.recordTokens(estimateTokensFromDelta(delta, this._config.countStrategy));
    }

    reconcileTotal(tokens: number) {
        if (tokens > 0) this._tokenCount = tokens;
    }

    recordTokens(tokens: number) {
        if (!this._isStreaming || tokens <= 0) return;

        this._tokenCount += tokens;
        this._events.push({ time: Date.now(), tokens });

        if (this._windowStartIndex >= COMPACTION_THRESHOLD) this.compact();
    }

    private compact() {
        if (this._windowStartIndex === 0) return;
        this._events = this._events.slice(this._windowStartIndex);
        this._windowStartIndex = 0;
    }
}
