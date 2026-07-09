import type { Config } from "./config";
import { TokenSpeedEngine } from "./engine";

export type CompletedMessageSpeed = {
    outputTokens: number;
    durationMs: number;
    /** Sanitized tokens-per-second for the completed assistant message. */
    tokS: number | null;
};

function isSuccessfulStop(stopReason: string | undefined) {
    return stopReason !== "error" && stopReason !== "aborted";
}

export class SpeedTracker {
    private readonly engine: TokenSpeedEngine;
    private lastStableTokS: number | null = null;
    private sessionOutputTokens = 0;
    private sessionDurationMs = 0;

    constructor(config: Config) {
        this.engine = new TokenSpeedEngine(config);
    }

    updateConfig(config: Config) {
        this.engine.updateConfig(config);
    }

    get isStreaming() {
        return this.engine.isStreaming;
    }

    get lastTokS() {
        return this.lastStableTokS;
    }

    resetSession() {
        this.sessionOutputTokens = 0;
        this.sessionDurationMs = 0;
    }

    startMessage() {
        this.engine.start();
    }

    recordDelta(delta: string, usageOutput?: number) {
        this.engine.recordDelta(delta, usageOutput);
    }

    stopMessage() {
        if (this.engine.isStreaming) this.engine.stop();
    }

    liveTokS() {
        const speed = this.engine.tokS;
        return speed > 0 ? speed : this.lastStableTokS;
    }

    sessionAvgTokS() {
        return this.sessionDurationMs > 0
            ? this.sessionOutputTokens / (this.sessionDurationMs / 1000)
            : null;
    }

    finishMessage(
        outputTokens: number,
        stopReason: string | undefined,
    ): CompletedMessageSpeed | null {
        if (!this.engine.isStreaming) return null;

        this.engine.reconcileTotal(outputTokens);
        const durationMs = this.engine.elapsedMs;
        const tokens = this.engine.tokenCount;
        const rawAvgTokS = durationMs > 0 ? tokens / (durationMs / 1000) : null;
        const tokS = this.engine.sanitizeTokS(rawAvgTokS, durationMs);
        this.lastStableTokS = tokS;
        this.engine.stop();

        if (tokS !== null && isSuccessfulStop(stopReason)) {
            this.sessionOutputTokens += tokens;
            this.sessionDurationMs += durationMs;
        }

        return {
            outputTokens: tokens,
            durationMs,
            tokS,
        };
    }
}
