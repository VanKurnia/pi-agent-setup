import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Box, Container, MouseRegion, Text, type Component } from "@earendil-works/pi-tui";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
    type EntryRenderer,
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

function getPendingBackupPath(sessionId: string): string {
    return join(getBlackholeDataDir(), `${sessionId}-pending.stale.json`);
}

/** Parse one store file; undefined when it is missing, unreadable or corrupt. */
function readStateFile(filePath: string): PendingOMState | undefined {
    if (!existsSync(filePath)) return undefined;
    try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        return {
            observations: Array.isArray(parsed.observations) ? parsed.observations : [],
            reflections: Array.isArray(parsed.reflections) ? parsed.reflections : [],
            lastObservedEntryId:
                typeof parsed.lastObservedEntryId === "string"
                    ? parsed.lastObservedEntryId
                    : undefined,
            lastReflectedEntryId:
                typeof parsed.lastReflectedEntryId === "string"
                    ? parsed.lastReflectedEntryId
                    : undefined,
        };
    } catch {
        return undefined;
    }
}

export function readPendingState(sessionId: string): PendingOMState {
    const main = readStateFile(getPendingFilePath(sessionId));
    if (main) return main;
    // Main file missing or unreadable: recover the last good state instead of
    // reporting "no memory". A corrupt main file is left in place as evidence.
    return readStateFile(getPendingBackupPath(sessionId)) ?? { observations: [], reflections: [] };
}

export function writePendingState(sessionId: string, state: PendingOMState): void {
    const dataDir = getBlackholeDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const filePath = getPendingFilePath(sessionId);
    const tmpPath = `${filePath}.tmp`;
    // Rotate only a file we can still read: a corrupt main file must never
    // displace a good backup.
    if (readStateFile(filePath)) {
        try {
            copyFileSync(filePath, getPendingBackupPath(sessionId));
        } catch {
            // Backup is best-effort; the atomic write below still protects the store.
        }
    }
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmpPath, filePath);
}

// ── Summarization for Compaction ───────────────────────────────────────────

/** Token estimate for plain memory text (chars / 4), used by every pool bound. */
export function estimateTextTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Newest-first selection of the memory that is safe to show the model, bounded by
 * the configured pool budgets. Returns oldest→newest so rendered output is stable.
 */
export function activeMemory(
    state: PendingOMState,
    config: BlackholeConfig,
    opts?: { observationBudget?: number },
): { reflections: PendingReflection[]; observations: PendingObservation[] } {
    const reflectionBudget = config.reflectionsPoolMaxTokens ?? 8000;
    const observationBudget = opts?.observationBudget ?? config.observationsPoolMaxTokens ?? 40000;

    const pick = <T extends { text: string }>(items: T[], budget: number): T[] => {
        const kept: T[] = [];
        let used = 0;
        for (let i = items.length - 1; i >= 0; i--) {
            const cost = estimateTextTokens(items[i].text);
            if (used + cost > budget && kept.length > 0) break;
            kept.unshift(items[i]);
            used += cost;
        }
        return kept;
    };

    return {
        reflections: pick(state.reflections, reflectionBudget),
        observations: pick(state.observations, observationBudget),
    };
}

/**
 * Trim a state in place to the pool budgets (observations down to the target,
 * reflections down to their pool). Pure except for the state mutation; the caller
 * persists and notifies.
 */
export function trimForDropper(
    state: PendingOMState,
    config: BlackholeConfig,
): { droppedObservations: number; droppedReflections: number } {
    const trim = <T extends { text: string }>(items: T[], budget: number): number => {
        let tokens = items.reduce((sum, item) => sum + estimateTextTokens(item.text), 0);
        let dropped = 0;
        while (items.length > 0 && tokens > budget) {
            tokens -= estimateTextTokens(items[0].text);
            items.shift();
            dropped++;
        }
        return dropped;
    };

    return {
        droppedObservations: trim(state.observations, config.observationsPoolTargetTokens ?? 20000),
        droppedReflections: trim(state.reflections, config.reflectionsPoolMaxTokens ?? 8000),
    };
}

/**
 * Re-anchor cursors whose entry id no longer exists in the branch (a compaction
 * rewrote history). Mutates `state`, returns whether anything changed.
 */
export function reanchorMissingCursors(
    state: PendingOMState,
    entries: Array<{ id?: string }>,
): boolean {
    const ids = new Set<string>();
    let newestId: string | undefined;
    for (const entry of entries) {
        if (entry.id) {
            ids.add(entry.id);
            newestId = entry.id;
        }
    }
    let changed = false;
    if (state.lastObservedEntryId && !ids.has(state.lastObservedEntryId)) {
        state.lastObservedEntryId = newestId;
        changed = true;
    }
    if (state.lastReflectedEntryId && !ids.has(state.lastReflectedEntryId)) {
        state.lastReflectedEntryId = newestId;
        changed = true;
    }
    return changed;
}

export function buildOmCompactionSummary(sessionId: string): string {
    const { reflections, observations } = activeMemory(
        readPendingState(sessionId),
        loadBlackholeConfig(),
    );
    const sections: string[] = [];

    if (reflections.length > 0) {
        sections.push(
            `#### Key Reflections\n${reflections.map((r) => `- [${r.id}] ${r.text}`).join("\n")}`,
        );
    }
    if (observations.length > 0) {
        sections.push(
            `#### Key Observations\n${observations.map((o) => `- [${o.id}] ${o.text}`).join("\n")}`,
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
        return estimateTextTokens(String(entry.content));
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
        // A cursor that vanished (compaction rewrote the branch) means "unknown
        // position", not "count everything" — counting the whole branch here
        // made the observer replay the entire conversation.
        if (startIndex === -1) return 0;
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
export const ANSI_GREEN = "\x1b[38;2;158;206;106m";
export const ANSI_WHITE = "\x1b[38;2;230;235;255m";
export const ANSI_RESET = "\x1b[39m";

let isConsolidationRunning = false;

const WORKER_TIMEOUT_MS = 120_000;
const WORKER_COOLDOWN_MS = 5 * 60_000;

/** In-memory only: a restart clears it. Keys are worker names. */
const workerCooldowns = new Map<string, number>();

export function isWorkerCoolingDown(name: string, now = Date.now()): boolean {
    const until = workerCooldowns.get(name);
    return until !== undefined && now < until;
}

export function markWorkerFailure(name: string, now = Date.now()): void {
    workerCooldowns.set(name, now + WORKER_COOLDOWN_MS);
}

export function clearWorkerCooldown(name: string): void {
    workerCooldowns.delete(name);
}

/**
 * Run one model stream with a hard timeout so a hung provider cannot hold the
 * background pipeline open forever.
 */
export async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`worker timeout after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function notifyWorkerFailure(
    pi: ExtensionAPI,
    config: BlackholeConfig,
    name: "observer" | "reflector" | "dropper",
    err: unknown,
): void {
    if (config.showWorkerMessages === false) return;
    const message = err instanceof Error ? err.message : String(err);
    notifyWorkerAction(
        pi,
        name,
        `${ANSI_ORANGE}${ANSI_RESET} ${ANSI_BLUE}[blackhole:${name}]${ANSI_RESET}${ANSI_WHITE} - worker error; paused for ${Math.round(WORKER_COOLDOWN_MS / 60000)} minutes${ANSI_RESET}`,
        `${ANSI_WHITE}${message}${ANSI_RESET}`,
    );
}

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
        // A custom entry, not a custom message: entries render in the TUI but do
        // not participate in LLM context, which is what keeps worker noise and
        // ANSI escapes out of the model's conversation.
        pi.appendEntry(`blackhole:${workerName}`, { summary, details });
    } catch {
        // Non-interactive or testing fallback
    }
}

/**
 * Consume one background-worker stream under the failure guard: a failed or hung
 * stream pauses that worker instead of retrying it every turn. Returns the parsed
 * bullets, or undefined when the worker was paused.
 */
async function runWorkerStream(
    pi: ExtensionAPI,
    config: BlackholeConfig,
    name: "observer" | "reflector",
    stream: AssistantMessageEventStream,
): Promise<string[] | undefined> {
    let response = "";
    try {
        response = await withTimeout(async () => {
            let acc = "";
            for await (const chunk of stream) {
                if (chunk && chunk.type === "text_delta" && typeof chunk.delta === "string") {
                    acc += chunk.delta;
                }
            }
            return acc;
        }, WORKER_TIMEOUT_MS);
        clearWorkerCooldown(name);
    } catch (err) {
        markWorkerFailure(name);
        notifyWorkerFailure(pi, config, name, err);
        return undefined;
    }
    return response
        .split("\n")
        .map((line) => line.trim().replace(/^[*-]\s*/, ""))
        .filter((line) => line.length > 10);
}

async function runReflectorWorker(
    ctx: ExtensionContext,
    config: BlackholeConfig,
    pi: ExtensionAPI,
    sessionId: string,
    state: PendingOMState,
    entries: Array<{ id?: string; type?: string; message?: unknown }>,
): Promise<void> {
    if (isWorkerCoolingDown("reflector")) return;
    if (state.observations.length < 4) return;
    const reflectThreshold = config.reflectAfterTokens ?? 80000;
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

    const lines = await runWorkerStream(pi, config, "reflector", stream);
    if (!lines) return;

    const newReflections: PendingReflection[] = [];
    for (const text of lines) {
        const hexId = Math.random().toString(16).slice(2, 14);
        const item: PendingReflection = { id: hexId, text, createdAt: Date.now() };
        state.reflections.push(item);
        newReflections.push(item);
    }

    state.lastReflectedEntryId = entries.at(-1)?.id;

    writePendingState(sessionId, state);
    if (newReflections.length > 0 && config.showWorkerMessages !== false) {
        notifyWorkerAction(
            pi,
            "reflector",
            `${ANSI_ORANGE}${ANSI_RESET} ${ANSI_BLUE}[blackhole:reflector]${ANSI_RESET}${ANSI_WHITE} - synthesized ${ANSI_RESET}${ANSI_GREEN}${newReflections.length} reflection(s)${ANSI_RESET}${ANSI_WHITE} from observations${ANSI_RESET}`,
            newReflections
                .map(
                    (r) =>
                        `${ANSI_WHITE}- [${ANSI_ORANGE}${r.id}${ANSI_WHITE}] ${r.text}${ANSI_RESET}`,
                )
                .join("\n"),
        );
    }
}

function runDropperWorker(
    config: BlackholeConfig,
    pi: ExtensionAPI,
    sessionId: string,
    state: PendingOMState,
): void {
    if (isWorkerCoolingDown("dropper")) return;
    if (state.observations.length === 0 && state.reflections.length === 0) return;

    const totalObsTokens = state.observations.reduce(
        (sum, o) => sum + estimateTextTokens(o.text),
        0,
    );
    const poolMax = config.observationsPoolMaxTokens ?? 40000;
    const pressureThreshold = config.dropperPressureThreshold ?? 0.7;
    const reflectionTokens = state.reflections.reduce(
        (sum, r) => sum + estimateTextTokens(r.text),
        0,
    );
    const reflectionBudget = config.reflectionsPoolMaxTokens ?? 8000;

    // Observations are pressure-gated; reflections are trimmed whenever they
    // exceed their own budget (nothing else ever pruned them).
    const underPressure = totalObsTokens >= poolMax * pressureThreshold;
    if (!underPressure && reflectionTokens <= reflectionBudget) return;

    const { droppedObservations, droppedReflections } = trimForDropper(state, config);

    if (droppedObservations > 0 || droppedReflections > 0) {
        writePendingState(sessionId, state);
        if (config.showWorkerMessages !== false) {
            notifyWorkerAction(
                pi,
                "dropper",
                `${ANSI_ORANGE}󰃢${ANSI_RESET} ${ANSI_BLUE}[blackhole:dropper]${ANSI_RESET}${ANSI_WHITE} - pruned ${ANSI_RESET}${ANSI_GREEN}${droppedObservations} observation(s)${ANSI_RESET}${ANSI_WHITE} and ${ANSI_RESET}${ANSI_GREEN}${droppedReflections} reflection(s)${ANSI_RESET}${ANSI_WHITE} (${ANSI_RESET}${ANSI_GREEN}${state.observations.length} / ${state.reflections.length} remaining${ANSI_RESET}${ANSI_WHITE})${ANSI_RESET}`,
                `${ANSI_WHITE}Pool pressure relieved down to target tokens; ${ANSI_RESET}${ANSI_GREEN}${state.observations.length} active observations${ANSI_RESET}${ANSI_WHITE} preserved.${ANSI_RESET}`,
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

        if (reanchorMissingCursors(state, entries)) {
            writePendingState(sessionId, state);
        }

        const observeThreshold = config.observeAfterTokens ?? 25000;
        const unobservedTokens = calculateTokensAfter(entries, state.lastObservedEntryId);

        if (
            !isWorkerCoolingDown("observer") &&
            unobservedTokens >= observeThreshold &&
            ctx.modelRegistry
        ) {
            const modelTarget = config.observerModel || config.model;
            if (modelTarget?.id) {
                let startIndex = -1;
                if (state.lastObservedEntryId) {
                    startIndex = entries.findIndex((e) => e.id === state.lastObservedEntryId);
                    // Belt-and-braces: a vanished anchor must never mean "from the
                    // start of the branch" (replay would duplicate observations).
                    if (startIndex === -1) return;
                }
                const unobservedEntries = entries
                    .slice(startIndex + 1)
                    .filter((e) => e.type === "message");
                const maxChunkTokens = config.observerChunkMaxTokens ?? 60000;
                const chunk = formatChunkEntries(unobservedEntries, maxChunkTokens);

                if (chunk.text.trim().length >= 50) {
                    const preamble = activeMemory(state, config, {
                        observationBudget: Math.floor(
                            (config.observerChunkMaxTokens ?? 60000) * 0.3,
                        ),
                    });
                    const prompt = `You are a background observer compressing recent conversation into durable insights.\nCURRENT REFLECTIONS:\n${preamble.reflections.map((r) => `- ${r.text}`).join("\n") || "(None)"}\n\nCURRENT OBSERVATIONS:\n${preamble.observations.map((o) => `- ${o.text}`).join("\n") || "(None)"}\n\nNEW CONVERSATION CHUNK:\n${chunk.text}\n\nExtract 1-3 concise, factual bullet points of durable insights or user preferences from this chunk. Do not duplicate facts already in reflections or observations.`;
                    const model =
                        ctx.modelRegistry.find(modelTarget.provider || "9router", modelTarget.id) ||
                        ctx.model;

                    if (model) {
                        const stream = ctx.modelRegistry.streamSimple(model, {
                            messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
                        });

                        const lines = await runWorkerStream(pi, config, "observer", stream);
                        if (!lines) return;

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

                        writePendingState(sessionId, state);
                        if (newObservations.length > 0 && config.showWorkerMessages !== false) {
                            notifyWorkerAction(
                                pi,
                                "observer",
                                `${ANSI_ORANGE}${ANSI_RESET} ${ANSI_BLUE}[blackhole:observer]${ANSI_RESET}${ANSI_WHITE} - recorded ${ANSI_RESET}${ANSI_GREEN}${newObservations.length} observation(s)${ANSI_RESET}`,
                                newObservations
                                    .map(
                                        (o) =>
                                            `${ANSI_WHITE}- [${ANSI_ORANGE}${o.id}${ANSI_WHITE}] ${o.text}${ANSI_RESET}`,
                                    )
                                    .join("\n"),
                            );
                        }
                    }
                }
            }
        }

        // Chained execution of Reflector and Dropper subagents with token cadence gates
        await runReflectorWorker(ctx, config, pi, sessionId, state, entries);
        runDropperWorker(config, pi, sessionId, state);
    } catch {
        // Background errors are non-fatal to user session. Worker-level failures
        // are handled per worker above (cooldown + one notice), so this only
        // covers the branch read and state persistence.
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

    // Legacy path: sessions written before the appendEntry switch already contain
    // blackhole:* custom_message entries; keep rendering them as worker cards.
    pi.registerMessageRenderer("blackhole:observer", renderWorkerMessage);
    pi.registerMessageRenderer("blackhole:reflector", renderWorkerMessage);
    pi.registerMessageRenderer("blackhole:dropper", renderWorkerMessage);
    pi.registerMessageRenderer("blackhole:compaction", renderWorkerMessage);

    const renderWorkerEntry: EntryRenderer<{ summary?: string; details?: string }> = (
        entry,
        options,
        theme,
    ): Component => {
        const data = entry.data || {};
        return new WorkerMessageComponent(
            data.summary || `[blackhole:${entry.customType}]`,
            data.details,
            options.expanded,
            theme,
        );
    };

    pi.registerEntryRenderer("blackhole:observer", renderWorkerEntry);
    pi.registerEntryRenderer("blackhole:reflector", renderWorkerEntry);
    pi.registerEntryRenderer("blackhole:dropper", renderWorkerEntry);
    pi.registerEntryRenderer("blackhole:compaction", renderWorkerEntry);

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

    const pendingFiles = readdirSync(dataDir).filter(
        (f) =>
            f.endsWith("-pending.json") ||
            f.endsWith("-pending.stale.json") ||
            f.endsWith("-pending.json.tmp"),
    );
    let removed = 0;
    let preserved = 0;

    for (const file of pendingFiles) {
        const sessionId = file.replace(
            /(-pending\.stale\.json|-pending\.json\.tmp|-pending\.json)$/,
            "",
        );
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
