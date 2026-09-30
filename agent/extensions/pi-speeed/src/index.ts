import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Config, loadConfig, saveConfig } from "./config";
import { clearUi, renderStyledWorkingTokS } from "./display";
import { openSettings } from "./settings";
import { SpeedAnimator } from "./speed-animation";
import { SpeedTracker } from "./speed-tracker";

export default function (pi: ExtensionAPI) {
    let config: Config = loadConfig();
    let lastRenderedAt = 0;
    const speedTracker = new SpeedTracker(config);
    const liveSpeedAnimator = new SpeedAnimator(config.speedAnimationMs);
    let liveAnimationTimer: ReturnType<typeof setInterval> | undefined;

    function renderWorking(ctx: ExtensionContext, speed = speedTracker.liveTokS()) {
        if (!config.enabled || !ctx.hasUI) return;
        ctx.ui.setWorkingMessage(renderStyledWorkingTokS(ctx.ui.theme, config, speed));
    }

    function applyConfig(ctx: ExtensionContext) {
        saveConfig(config);
        speedTracker.updateConfig(config);
        liveSpeedAnimator.updateDuration(config.speedAnimationMs);
        if (!config.enabled) {
            stopLiveAnimation();
            clearUi(ctx);
        }
    }

    function renderLiveSpeed(ctx: ExtensionContext) {
        const speed = speedTracker.liveTokS();
        const displayedSpeed = liveSpeedAnimator.setTarget(speed);
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

    function resetWorkingUi(ctx: ExtensionContext) {
        liveSpeedAnimator.reset(speedTracker.lastTokS);
        renderWorking(ctx, speedTracker.lastTokS);
    }

    pi.on("session_start", async () => {
        stopLiveAnimation();
        config = loadConfig();
        speedTracker.updateConfig(config);
        liveSpeedAnimator.updateDuration(config.speedAnimationMs);
    });

    pi.on("agent_start", async (_event, ctx) => {
        if (!config.enabled) return;
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

        if (ev.type === "start") resetWorkingUi(ctx);

        const now = Date.now();
        if (now - lastRenderedAt < config.renderIntervalMs && ev.type !== "done") return;
        lastRenderedAt = now;

        renderLiveSpeed(ctx);
    });

    pi.on("message_end", async (event) => {
        if (!config.enabled || event.message.role !== "assistant") return;
        speedTracker.finishMessage(event.message.usage?.output ?? 0);
    });

    pi.on("turn_end", async () => {
        speedTracker.stopMessage();
        stopLiveAnimation();
    });

    pi.on("agent_end", async (_event, ctx) => {
        speedTracker.stopMessage();
        stopLiveAnimation();
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        stopLiveAnimation();
        clearUi(ctx);
    });

    pi.registerCommand("pi-speeed", {
        description: "Open pi-speeed settings",
        handler: async (_args, ctx) => {
            await openSettings(
                ctx,
                () => config,
                (next) => (config = next),
                () => applyConfig(ctx),
            );
        },
    });
}
