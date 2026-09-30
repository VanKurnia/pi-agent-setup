import type { Config } from "./config";
import { TokenSpeedEngine } from "./engine";

export class SpeedTracker {
    private readonly engine: TokenSpeedEngine;
    private lastStableTokS: number | null = null;

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

    finishMessage(outputTokens: number) {
        if (!this.engine.isStreaming) return;

        this.engine.reconcileTotal(outputTokens);
        this.lastStableTokS = this.engine.sanitizeTokS(this.engine.avgTokS, this.engine.elapsedMs);
        this.engine.stop();
    }
}
