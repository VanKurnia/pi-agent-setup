import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBlackholeDataDir, loadBlackholeConfig, type BlackholeConfig } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PendingObservation {
    id: string;
    text: string;
    createdAt: number;
}

export interface PendingReflection {
    id: string;
    text: string;
    createdAt: number;
}

export interface PendingOMState {
    observations: PendingObservation[];
    reflections: PendingReflection[];
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function getPendingFilePath(sessionId: string): string {
    return join(getBlackholeDataDir(), `${sessionId}-pending.json`);
}

export function readPendingState(sessionId: string): PendingOMState {
    const filePath = getPendingFilePath(sessionId);
    if (!existsSync(filePath)) return { observations: [], reflections: [] };
    try {
        const raw = JSON.parse(readFileSync(filePath, "utf8"));
        return {
            observations: Array.isArray(raw.observations) ? raw.observations : [],
            reflections: Array.isArray(raw.reflections) ? raw.reflections : [],
        };
    } catch {
        return { observations: [], reflections: [] };
    }
}

export function writePendingState(sessionId: string, state: PendingOMState): void {
    const dataDir = getBlackholeDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(getPendingFilePath(sessionId), JSON.stringify(state, null, 2), "utf8");
}

// ── Summarization for Compaction ───────────────────────────────────────────

export function buildOmCompactionSummary(sessionId: string): string {
    const state = readPendingState(sessionId);
    const sections: string[] = [];

    if (state.reflections.length > 0) {
        sections.push(
            `#### Key Reflections\n${state.reflections.map((r) => `- [${r.id}] ${r.text}`).join("\n")}`,
        );
    }
    if (state.observations.length > 0) {
        sections.push(
            `#### Key Observations\n${state.observations.map((o) => `- [${o.id}] ${o.text}`).join("\n")}`,
        );
    }

    return sections.join("\n\n");
}

// ── Background Worker Pipeline ──────────────────────────────────────────────

let isConsolidationRunning = false;

export async function runBackgroundConsolidation(
    ctx: ExtensionContext,
    config: BlackholeConfig,
): Promise<void> {
    if (isConsolidationRunning || config.memory === false) return;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return;

    isConsolidationRunning = true;
    try {
        const modelTarget = config.observerModel || config.model;
        if (!modelTarget?.id) return;

        const state = readPendingState(sessionId);
        const messages = ctx?.sessionManager?.buildSessionProjection?.()?.messages || [];
        if (messages.length < 4) return;

        const lastAssistant = [...messages]
            .reverse()
            .find((m) => (m as { role?: string })?.role === "assistant") as
            { content?: unknown } | undefined;
        if (!lastAssistant) return;

        const textContent = Array.isArray(lastAssistant.content)
            ? lastAssistant.content.map((c) => (c as { text?: string })?.text || "").join(" ")
            : String(lastAssistant.content || "");

        if (textContent.length < 50) return;

        const prompt = `Extract 1-2 concise, factual bullet points of durable insights or user preferences from this exchange:\n\n${textContent}`;
        const model =
            (ctx.modelRegistry
                ? ctx.modelRegistry.find(modelTarget.provider || "9router", modelTarget.id)
                : undefined) || ctx.model;

        if (model && ctx.modelRegistry) {
            const stream = ctx.modelRegistry.streamSimple(model, {
                messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
            });

            let response = "";
            for await (const chunk of stream) {
                if (chunk && chunk.type === "text_delta" && typeof chunk.delta === "string") {
                    response += chunk.delta;
                }
            }

            const cleanText = response.trim();
            if (cleanText) {
                const hexId = Math.random().toString(16).slice(2, 14);
                state.observations.push({
                    id: hexId,
                    text: cleanText.replace(/^[*-]\s*/, ""),
                    createdAt: Date.now(),
                });
                writePendingState(sessionId, state);
            }
        }
    } catch {
        // Background errors are non-fatal to user session
    } finally {
        isConsolidationRunning = false;
    }
}

export function registerConsolidationHooks(pi: ExtensionAPI): void {
    const config = loadBlackholeConfig();
    pi.on("turn_end", async (_event, ctx) => {
        void runBackgroundConsolidation(ctx, config);
    });
}

// ── Cleanup Utility ─────────────────────────────────────────────────────────

export function cleanupOrphanedPendingFiles(): { removed: number; preserved: number } {
    const dataDir = getBlackholeDataDir();
    if (!existsSync(dataDir)) return { removed: 0, preserved: 0 };

    const files = readdirSync(dataDir).filter(
        (f) => f.endsWith("-pending.json") || f.endsWith("-pending.stale.json"),
    );

    let removed = 0;
    let preserved = 0;

    for (const file of files) {
        const fullPath = join(dataDir, file);
        if (file.endsWith("-pending.stale.json")) {
            try {
                unlinkSync(fullPath);
                removed++;
            } catch {
                preserved++;
            }
        } else {
            preserved++;
        }
    }

    return { removed, preserved };
}
