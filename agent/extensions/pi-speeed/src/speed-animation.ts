export class SpeedAnimator {
    private from: number | null = null;
    private target: number | null = null;
    private startedAt = 0;

    constructor(private durationMs: number) {}

    updateDuration(durationMs: number) {
        this.durationMs = durationMs;
    }

    reset(value: number | null = null, now = Date.now()) {
        this.from = value;
        this.target = value;
        this.startedAt = now;
    }

    setTarget(target: number | null, now = Date.now()) {
        if (target === null) {
            this.reset(null, now);
            return null;
        }

        const current = this.value(now);
        if (current === null) {
            this.reset(target, now);
            return target;
        }

        if (this.target !== null && Math.abs(target - this.target) < 0.05) return current;

        this.from = current;
        this.target = target;
        this.startedAt = now;
        return current;
    }

    value(now = Date.now()) {
        if (this.target === null) return null;
        if (this.from === null || this.durationMs <= 0) return this.target;

        const progress = Math.max(0, Math.min(1, (now - this.startedAt) / this.durationMs));
        if (progress >= 1) {
            this.from = this.target;
            return this.target;
        }

        return this.from + (this.target - this.from) * progress;
    }

    isAnimating(now = Date.now()) {
        return (
            this.target !== null &&
            this.from !== null &&
            Math.abs(this.target - this.from) >= 0.05 &&
            now - this.startedAt < this.durationMs
        );
    }
}
