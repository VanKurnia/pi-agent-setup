import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Config, loadConfig, saveConfig } from "./config";
import {
    chooseOccurrenceText,
    clearUi,
    type OccurrenceText,
    renderFooterTokS,
    renderStyledFooterTokS,
    renderStyledWorkingTokS,
    updateStatus,
} from "./display";
import { recordCompletedMessageSpeed } from "./history";
import { applyRunCatIndicator, type RunCatState } from "./runcat";
import { openSettings } from "./settings";
import { SpeedAnimator } from "./speed-animation";
import { SpeedTracker } from "./speed-tracker";
import { loadStats, summarizeStats } from "./stats";
import { showReadOnlyPanel } from "./ui";

export default function (pi: ExtensionAPI) {
    let config: Config = loadConfig();
    let lastRenderedAt = 0;
    let occurrence: OccurrenceText = { label: null, workingPrefix: null };
    let aggregateStats = loadStats();
    const runcatState: RunCatState = { intervalMs: 0 };
    const speedTracker = new SpeedTracker(config);
    const liveSpeedAnimator = new SpeedAnimator(config.speedAnimationMs);
    const footerSpeedAnimator = new SpeedAnimator(config.speedAnimationMs);
    let liveAnimationTimer: ReturnType<typeof setInterval> | undefined;
    let footerAnimationTimer: ReturnType<typeof setInterval> | undefined;

    function renderFooterStatus(ctx: ExtensionContext, speed = footerSpeedAnimator.value()) {
        ensureOccurrence();
        return ctx.hasUI
            ? renderStyledFooterTokS(ctx.ui.theme, config, occurrence, speed)
            : renderFooterTokS(config, occurrence, speed);
    }

    function renderWorking(ctx: ExtensionContext, speed = speedTracker.liveTokS()) {
        if (!config.enabled || !ctx.hasUI) return;
        ctx.ui.setWorkingMessage(renderStyledWorkingTokS(ctx.ui.theme, config, occurrence, speed));
    }

    function refreshRunCat(ctx: ExtensionContext, speed = speedTracker.lastTokS, force = true) {
        if (!config.enabled) return;
        applyRunCatIndicator(ctx, config, runcatState, speed, force);
    }

    function applyConfig(ctx: ExtensionContext) {
        saveConfig(config);
        speedTracker.updateConfig(config);
        liveSpeedAnimator.updateDuration(config.speedAnimationMs);
        footerSpeedAnimator.updateDuration(config.speedAnimationMs);
        if (!config.enabled) {
            stopLiveAnimation();
            stopFooterAnimation();
            clearUi(ctx);
            return;
        }
        refreshRunCat(ctx);
        updateStatus(ctx, config, renderFooterStatus(ctx));
    }

    function ensureOccurrence() {
        if (occurrence.label === null || occurrence.workingPrefix === null)
            occurrence = chooseOccurrenceText(config);
    }

    function renderLiveSpeed(ctx: ExtensionContext) {
        const speed = speedTracker.liveTokS();
        const displayedSpeed = liveSpeedAnimator.setTarget(speed);
        applyRunCatIndicator(ctx, config, runcatState, speed);
        renderWorking(ctx, displayedSpeed);
    }

    function stopLiveAnimation() {
        if (!liveAnimationTimer) return;
        clearInterval(liveAnimationTimer);
        liveAnimationTimer = undefined;
    }

    function startLiveAnimation(ctx: ExtensionContext) {
        if (liveAnimationTimer || !ctx.hasUI) return;
        liveAnimationTimer = setInterval(() => {
            if (!config.enabled || !speedTracker.isStreaming) {
                stopLiveAnimation();
                return;
            }
            renderLiveSpeed(ctx);
        }, config.renderIntervalMs);
    }

    function stopFooterAnimation() {
        if (!footerAnimationTimer) return;
        clearInterval(footerAnimationTimer);
        footerAnimationTimer = undefined;
    }

    function startFooterAnimation(ctx: ExtensionContext) {
        if (footerAnimationTimer || !ctx.hasUI) return;
        footerAnimationTimer = setInterval(() => {
            if (!config.enabled) {
                stopFooterAnimation();
                return;
            }
            updateStatus(ctx, config, renderFooterStatus(ctx));
            if (!footerSpeedAnimator.isAnimating()) stopFooterAnimation();
        }, config.renderIntervalMs);
    }

    function resetWorkingUi(ctx: ExtensionContext) {
        ensureOccurrence();
        refreshRunCat(ctx, null);
        liveSpeedAnimator.reset(speedTracker.lastTokS);
        renderWorking(ctx, speedTracker.lastTokS);
    }

    pi.on("session_start", async (_event, ctx) => {
        stopLiveAnimation();
        stopFooterAnimation();
        config = loadConfig();
        speedTracker.updateConfig(config);
        liveSpeedAnimator.updateDuration(config.speedAnimationMs);
        footerSpeedAnimator.updateDuration(config.speedAnimationMs);
        speedTracker.resetSession();
        footerSpeedAnimator.reset(null);
        refreshRunCat(ctx);
        if (config.enabled && ctx.hasUI) updateStatus(ctx, config, renderFooterStatus(ctx));
    });

    pi.on("agent_start", async (_event, ctx) => {
        if (!config.enabled) return;
        occurrence = chooseOccurrenceText(config);
        resetWorkingUi(ctx);
    });

    pi.on("turn_start", async (_event, ctx) => {
        if (!config.enabled) return;
        resetWorkingUi(ctx);
    });

    pi.on("message_start", async (event, ctx) => {
        if (!config.enabled || event.message?.role !== "assistant") return;
        speedTracker.startMessage();
        liveSpeedAnimator.reset(speedTracker.lastTokS);
        startLiveAnimation(ctx);
        lastRenderedAt = 0;
    });

    pi.on("message_update", async (event, ctx) => {
        if (!config.enabled || event.message.role !== "assistant" || !speedTracker.isStreaming)
            return;

        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta" || ev.type === "thinking_delta") {
            speedTracker.recordDelta(ev.delta, ev.partial?.usage?.output);
        }

        ensureOccurrence();
        if (ev.type === "start") resetWorkingUi(ctx);

        const now = Date.now();
        if (now - lastRenderedAt < config.renderIntervalMs && ev.type !== "done") return;
        lastRenderedAt = now;

        renderLiveSpeed(ctx);
    });

    pi.on("message_end", async (event, ctx) => {
        if (!config.enabled || event.message.role !== "assistant" || !speedTracker.isStreaming)
            return;

        const completed = speedTracker.finishMessage(
            event.message.usage?.output ?? 0,
            event.message.stopReason,
        );
        if (!completed) return;

        recordCompletedMessageSpeed(pi, config, aggregateStats, completed, {
            endedAt: Date.now(),
            model: event.message.model,
            provider: event.message.provider,
            api: event.message.api,
            responseId: event.message.responseId,
            stopReason: event.message.stopReason,
        });
        footerSpeedAnimator.setTarget(speedTracker.sessionAvgTokS());
        updateStatus(ctx, config, renderFooterStatus(ctx));
        startFooterAnimation(ctx);
        refreshRunCat(ctx);
    });

    pi.on("turn_end", async () => {
        speedTracker.stopMessage();
        stopLiveAnimation();
    });

    pi.on("agent_end", async (_event, ctx) => {
        speedTracker.stopMessage();
        stopLiveAnimation();
        refreshRunCat(ctx);
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        if (!config.enabled && ctx.hasUI) clearUi(ctx);
        occurrence = { label: null, workingPrefix: null };
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        stopLiveAnimation();
        stopFooterAnimation();
        clearUi(ctx);
    });

    async function handleConfigCommand(args: string, ctx: ExtensionCommandContext) {
        const [cmd] = args.trim().split(/\s+/).filter(Boolean);
        if (!cmd || cmd === "settings") {
            await openSettings(
                ctx,
                () => config,
                (next) => (config = next),
                () => applyConfig(ctx),
            );
            return;
        }
        if (cmd === "stats") {
            aggregateStats = loadStats();
            await showReadOnlyPanel(ctx, "pi-speeed stats", summarizeStats(aggregateStats));
            return;
        }
        ctx.ui.notify(
            "Use /pi-speeed for settings or /pi-speeed stats for aggregate stats.",
            "error",
        );
    }

    pi.registerCommand("pi-speeed", {
        description: "Open pi-speeed settings; use /pi-speeed stats for aggregate speed stats",
        handler: handleConfigCommand,
    });
}
