import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Box, Container, MouseRegion, Text, type Component } from "@earendil-works/pi-tui";
import {
    estimateTokens,
    type ExtensionAPI,
    type ExtensionContext,
    type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { getBlackholeDataDir, loadBlackholeConfig, type BlackholeConfig } from "./config.js";

type Theme = Parameters<MessageRenderer>[2];

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
    lastObservedEntryId?: string;
    lastReflectedEntryId?: string;
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
            lastObservedEntryId:
                typeof raw.lastObservedEntryId === "string" ? raw.lastObservedEntryId : undefined,
            lastReflectedEntryId:
                typeof raw.lastReflectedEntryId === "string" ? raw.lastReflectedEntryId : undefined,
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

export function estimateEntryTokens(entry: {
    type?: string;
    message?: unknown;
    content?: unknown;
}): number {
    if (entry.type === "message" && entry.message) {
        return estimateTokens(entry.message as Parameters<typeof estimateTokens>[0]);
    }
    if (entry.type === "custom_message" && entry.content) {
        return Math.ceil(String(entry.content).length / 4);
    }
    return 0;
}

export function calculateTokensAfter(
    entries: Array<{ id?: string; type?: string; message?: unknown }>,
    cursorId?: string,
): number {
    let startIndex = -1;
    if (cursorId) {
        startIndex = entries.findIndex((e) => e.id === cursorId);
    }
    let tokens = 0;
    for (let i = startIndex + 1; i < entries.length; i++) {
        tokens += estimateEntryTokens(entries[i]);
    }
    return tokens;
}

export function formatChunkEntries(
    entries: Array<{ id?: string; type?: string; message?: { role?: string; content?: unknown } }>,
    maxTokens = 60000,
): { text: string; lastEntryId?: string } {
    let totalTokens = 0;
    const kept: Array<{
        id?: string;
        type?: string;
        message?: { role?: string; content?: unknown };
    }> = [];
    for (let i = entries.length - 1; i >= 0; i--) {
        const est = estimateEntryTokens(entries[i]);
        if (totalTokens + est > maxTokens && kept.length > 0) break;
        totalTokens += est;
        kept.unshift(entries[i]);
    }

    const blocks: string[] = [];
    for (const e of kept) {
        if (e.type === "message" && e.message) {
            const role = e.message.role || "unknown";
            const content = Array.isArray(e.message.content)
                ? e.message.content
                      .map((c) => (c as { text?: string })?.text || JSON.stringify(c))
                      .join(" ")
                : String(e.message.content || "");
            if (content.trim()) {
                blocks.push(
                    `[Source entry id: ${e.id || "unknown"}]\n[${role.toUpperCase()}]: ${content.trim()}`,
                );
            }
        }
    }
    return { text: blocks.join("\n\n"), lastEntryId: kept.at(-1)?.id };
}

// ── Background Worker Pipeline ──────────────────────────────────────────────

export const ANSI_BLUE = "\x1b[38;2;122;162;247m";
export const ANSI_ORANGE = "\x1b[38;2;255;158;100m";
export const ANSI_WHITE = "\x1b[38;2;230;235;255m";
export const ANSI_RESET = "\x1b[39m";

let isConsolidationRunning = false;

function formatBoxBg(text: string, theme?: Theme): string {
    const mode = typeof theme?.getColorMode === "function" ? theme.getColorMode() : "truecolor";
    if (mode === "256color") {
        return `\x1b[48;5;234m${text}\x1b[49m`;
    }
    return `\x1b[48;2;26;27;38m${text}\x1b[49m`;
}

export class WorkerMessageComponent extends Box {
    expanded = false;
    summaryLine: string;
    detailText?: string;
    theme?: Theme;

    constructor(summaryLine: string, detailText?: string, initialExpanded = false, theme?: Theme) {
        super(1, 0, (t) => formatBoxBg(t, theme));
        this.summaryLine = summaryLine;
        this.detailText = detailText;
        this.expanded = initialExpanded;
        this.theme = theme;
        this.updateDisplay();
    }

    setExpanded(val: boolean): void {
        if (this.expanded !== val) {
            this.expanded = val;
            this.updateDisplay();
        }
    }

    updateDisplay(): void {
        this.clear();
        const content = new Container();
        content.addChild(new Text(this.summaryLine, 0, 0));
        if (this.expanded && this.detailText) {
            content.addChild(new Text(this.detailText, 0, 0));
        }
        this.addChild(
            new MouseRegion(content, (event) => {
                if (event.type === "click" && event.button === "left") {
                    this.setExpanded(!this.expanded);
                    return { handled: true };
                }
            }),
        );
    }
}

export function notifyWorkerAction(
    pi: ExtensionAPI,
    workerName: "observer" | "reflector" | "dropper" | "compaction",
    summary: string,
    details?: string,
): void {
    try {
        const text = details ? `${summary}\n${details}` : summary;
        pi.sendMessage(
            {
                customType: `blackhole:${workerName}`,
                content: [{ type: "text", text }],
                display: true,
                details: { summary, details },
            },
            { triggerTurn: false },
        );
    } catch {
        // Non-interactive or testing fallback
    }
}

async function runReflectorWorker(
    ctx: ExtensionContext,
    config: BlackholeConfig,
    pi: ExtensionAPI,
    sessionId: string,
    state: PendingOMState,
    entries: Array<{ id?: string; type?: string; message?: unknown }>,
): Promise<void> {
    if (state.observations.length < 4) return;
    const reflectThreshold = config.reflectAfterTokens ?? 60000;
    const tokensSinceReflect = calculateTokensAfter(entries, state.lastReflectedEntryId);
    if (tokensSinceReflect < reflectThreshold) return;

    const modelTarget = config.reflectorModel || config.model;
    if (!modelTarget?.id || !ctx.modelRegistry) return;

    const unreflected = state.observations.slice(-8);
    const prompt = `Synthesize these observations into 1 concise, durable high-level reflection:\n${unreflected.map((o) => `- ${o.text}`).join("\n")}`;

    const model =
        ctx.modelRegistry.find(modelTarget.provider || "9router", modelTarget.id) || ctx.model;
    if (!model) return;

    const stream = ctx.modelRegistry.streamSimple(model, {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    });

    let response = "";
    for await (const chunk of stream) {
        if (chunk && chunk.type === "text_delta" && typeof chunk.delta === "string") {
            response += chunk.delta;
        }
    }

    const lines = response
        .split("\n")
        .map((l) => l.trim().replace(/^[*-]\s*/, ""))
        .filter((l) => l.length > 10);

    const newReflections: PendingReflection[] = [];
    for (const text of lines) {
        const hexId = Math.random().toString(16).slice(2, 14);
        const item: PendingReflection = { id: hexId, text, createdAt: Date.now() };
        state.reflections.push(item);
        newReflections.push(item);
    }

    state.lastReflectedEntryId = entries.at(-1)?.id;

    if (newReflections.length > 0) {
        writePendingState(sessionId, state);
        if (config.showWorkerMessages !== false) {
            notifyWorkerAction(
                pi,
                "reflector",
                `${ANSI_BLUE} [blackhole:reflector]${ANSI_RESET}${ANSI_WHITE} - synthesized ${ANSI_RESET}${ANSI_ORANGE}${newReflections.length} reflection(s)${ANSI_RESET}${ANSI_WHITE} from observations${ANSI_RESET}`,
                newReflections
                    .map(
                        (r) =>
                            `${ANSI_WHITE}- [${ANSI_ORANGE}${r.id}${ANSI_WHITE}] ${r.text}${ANSI_RESET}`,
                    )
                    .join("\n"),
            );
        }
    } else {
        writePendingState(sessionId, state);
    }
}

function runDropperWorker(
    config: BlackholeConfig,
    pi: ExtensionAPI,
    sessionId: string,
    state: PendingOMState,
): void {
    if (state.observations.length === 0) return;

    let totalObsTokens = state.observations.reduce(
        (sum, o) => sum + Math.ceil(o.text.length / 4),
        0,
    );
    const poolMax = config.observationsPoolMaxTokens ?? 35000;
    const pressureThreshold = config.dropperPressureThreshold ?? 0.7;

    if (totalObsTokens < poolMax * pressureThreshold) return;

    const targetTokens = config.observationsPoolTargetTokens ?? 18000;
    let droppedCount = 0;
    while (state.observations.length > 0 && totalObsTokens > targetTokens) {
        const removed = state.observations.shift();
        if (removed) {
            totalObsTokens -= Math.ceil(removed.text.length / 4);
            droppedCount++;
        }
    }

    if (droppedCount > 0) {
        writePendingState(sessionId, state);
        if (config.showWorkerMessages !== false) {
            notifyWorkerAction(
                pi,
                "dropper",
                `${ANSI_BLUE}󰃢 [blackhole:dropper]${ANSI_RESET}${ANSI_WHITE} - pruned ${ANSI_RESET}${ANSI_ORANGE}${droppedCount} older observation(s)${ANSI_RESET}${ANSI_WHITE} (${ANSI_RESET}${ANSI_ORANGE}${state.observations.length} remaining${ANSI_RESET}${ANSI_WHITE})${ANSI_RESET}`,
                `${ANSI_WHITE}Pool pressure relieved down to target tokens; ${ANSI_RESET}${ANSI_ORANGE}${state.observations.length} active observations${ANSI_RESET}${ANSI_WHITE} preserved.${ANSI_RESET}`,
            );
        }
    }
}

export async function runBackgroundConsolidation(
    ctx: ExtensionContext,
    config: BlackholeConfig,
    pi: ExtensionAPI,
): Promise<void> {
    if (isConsolidationRunning || config.memory === false) return;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return;

    isConsolidationRunning = true;
    try {
        const state = readPendingState(sessionId);
        const entries = (ctx?.sessionManager?.getBranch?.() ||
            ctx?.sessionManager?.getEntries?.() ||
            []) as Array<{
            id?: string;
            type?: string;
            message?: { role?: string; content?: unknown };
        }>;
        if (entries.length < 2) return;

        const observeThreshold = config.observeAfterTokens ?? 20000;
        const unobservedTokens = calculateTokensAfter(entries, state.lastObservedEntryId);

        if (unobservedTokens >= observeThreshold && ctx.modelRegistry) {
            const modelTarget = config.observerModel || config.model;
            if (modelTarget?.id) {
                let startIndex = -1;
                if (state.lastObservedEntryId) {
                    startIndex = entries.findIndex((e) => e.id === state.lastObservedEntryId);
                }
                const unobservedEntries = entries
                    .slice(startIndex + 1)
                    .filter((e) => e.type === "message");
                const maxChunkTokens = config.observerChunkMaxTokens ?? 60000;
                const chunk = formatChunkEntries(unobservedEntries, maxChunkTokens);

                if (chunk.text.trim().length >= 50) {
                    const prompt = `You are a background observer compressing recent conversation into durable insights.\nCURRENT REFLECTIONS:\n${state.reflections.map((r) => `- ${r.text}`).join("\n") || "(None)"}\n\nCURRENT OBSERVATIONS:\n${state.observations.map((o) => `- ${o.text}`).join("\n") || "(None)"}\n\nNEW CONVERSATION CHUNK:\n${chunk.text}\n\nExtract 1-3 concise, factual bullet points of durable insights or user preferences from this chunk. Do not duplicate facts already in reflections or observations.`;
                    const model =
                        ctx.modelRegistry.find(modelTarget.provider || "9router", modelTarget.id) ||
                        ctx.model;

                    if (model) {
                        const stream = ctx.modelRegistry.streamSimple(model, {
                            messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
                        });

                        let response = "";
                        for await (const deltaChunk of stream) {
                            if (
                                deltaChunk &&
                                deltaChunk.type === "text_delta" &&
                                typeof deltaChunk.delta === "string"
                            ) {
                                response += deltaChunk.delta;
                            }
                        }

                        const lines = response
                            .split("\n")
                            .map((l) => l.trim().replace(/^[*-]\s*/, ""))
                            .filter((l) => l.length > 10);

                        const newObservations: PendingObservation[] = [];
                        for (const text of lines) {
                            const hexId = Math.random().toString(16).slice(2, 14);
                            const item: PendingObservation = {
                                id: hexId,
                                text,
                                createdAt: Date.now(),
                            };
                            state.observations.push(item);
                            newObservations.push(item);
                        }

                        if (chunk.lastEntryId) {
                            state.lastObservedEntryId = chunk.lastEntryId;
                        }

                        if (newObservations.length > 0) {
                            writePendingState(sessionId, state);
                            if (config.showWorkerMessages !== false) {
                                notifyWorkerAction(
                                    pi,
                                    "observer",
                                    `${ANSI_BLUE} [blackhole:observer]${ANSI_RESET}${ANSI_WHITE} - recorded ${ANSI_RESET}${ANSI_ORANGE}${newObservations.length} observation(s)${ANSI_RESET}`,
                                    newObservations
                                        .map(
                                            (o) =>
                                                `${ANSI_WHITE}- [${ANSI_ORANGE}${o.id}${ANSI_WHITE}] ${o.text}${ANSI_RESET}`,
                                        )
                                        .join("\n"),
                                );
                            }
                        } else {
                            writePendingState(sessionId, state);
                        }
                    }
                }
            }
        }

        // Chained execution of Reflector and Dropper subagents with token cadence gates
        await runReflectorWorker(ctx, config, pi, sessionId, state, entries);
        runDropperWorker(config, pi, sessionId, state);
    } catch {
        // Background errors are non-fatal to user session
    } finally {
        isConsolidationRunning = false;
    }
}

export function registerConsolidationHooks(pi: ExtensionAPI): void {
    const config = loadBlackholeConfig();

    const renderWorkerMessage: MessageRenderer = (message, options, theme): Component => {
        const details = (message.details as { summary?: string; details?: string }) || {};
        let summaryLine = details.summary;
        let detailText = details.details;

        if (!summaryLine) {
            const contentStr = Array.isArray(message.content)
                ? message.content.map((c) => (c as { text?: string }).text || "").join("\n")
                : String(message.content || "");
            const firstNewline = contentStr.indexOf("\n");
            if (firstNewline !== -1) {
                summaryLine = contentStr.slice(0, firstNewline).trim();
                detailText = contentStr.slice(firstNewline + 1).trim();
            } else {
                summaryLine = contentStr.trim();
            }
        }

        return new WorkerMessageComponent(summaryLine, detailText, options.expanded, theme);
    };

    pi.registerMessageRenderer("blackhole:observer", renderWorkerMessage);
    pi.registerMessageRenderer("blackhole:reflector", renderWorkerMessage);
    pi.registerMessageRenderer("blackhole:dropper", renderWorkerMessage);
    pi.registerMessageRenderer("blackhole:compaction", renderWorkerMessage);

    pi.on("turn_end", async (_event, ctx) => {
        void runBackgroundConsolidation(ctx, config, pi);
    });
}

// ── Cleanup Utility ─────────────────────────────────────────────────────────

export function cleanupOrphanedPendingFiles(): { removed: number; preserved: number } {
    const dataDir = getBlackholeDataDir();
    if (!existsSync(dataDir)) return { removed: 0, preserved: 0 };

    const sessionsDir = resolve(dataDir, "..", "sessions");
    const activeSessionIds = new Set<string>();

    if (existsSync(sessionsDir)) {
        const stack: string[] = [sessionsDir];
        while (stack.length > 0) {
            const current = stack.pop()!;
            try {
                for (const entry of readdirSync(current, { withFileTypes: true })) {
                    const fullPath = join(current, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(fullPath);
                    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                        try {
                            const content = readFileSync(fullPath, "utf8");
                            const firstLine = content.slice(0, content.indexOf("\n") || undefined);
                            const header = JSON.parse(firstLine);
                            if (header?.type === "session" && typeof header?.id === "string") {
                                activeSessionIds.add(header.id);
                            }
                        } catch {
                            // Unreadable/corrupted session file — skip
                        }
                    }
                }
            } catch {
                // Directory inaccessible — skip
            }
        }
    }

    const pendingFiles = readdirSync(dataDir).filter((f) => f.endsWith("-pending.json"));
    let removed = 0;
    let preserved = 0;

    for (const file of pendingFiles) {
        const sessionId = file.replace(/-pending\.json$/, "");
        const fullPath = join(dataDir, file);
        if (!activeSessionIds.has(sessionId)) {
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
