import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface SubagentsSettings {
    maxConcurrent?: number;
    agentModels?: Record<string, string>;
    agentThinking?: Record<string, ThinkingLevel>;
}

export const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENT_CEILING = 1024;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

function sanitize(raw: unknown): SubagentsSettings {
    if (!raw || typeof raw !== "object") return {};
    const r = raw as Record<string, unknown>;
    const out: SubagentsSettings = {};
    if (
        typeof r.maxConcurrent === "number" &&
        Number.isInteger(r.maxConcurrent) &&
        r.maxConcurrent >= 1 &&
        r.maxConcurrent <= MAX_CONCURRENT_CEILING
    ) {
        out.maxConcurrent = r.maxConcurrent;
    }
    if (typeof r.agentModels === "object" && r.agentModels !== null) {
        const validated: Record<string, string> = {};
        for (const [name, model] of Object.entries(r.agentModels)) {
            if (typeof model === "string" && model.includes("/")) {
                validated[name] = model;
            }
        }
        if (Object.keys(validated).length > 0) {
            out.agentModels = validated;
        }
    }
    if (typeof r.agentThinking === "object" && r.agentThinking !== null) {
        const validated: Record<string, ThinkingLevel> = {};
        for (const [name, level] of Object.entries(r.agentThinking)) {
            if (
                typeof level === "string" &&
                (THINKING_LEVELS as readonly string[]).includes(level)
            ) {
                validated[name] = level as ThinkingLevel;
            }
        }
        if (Object.keys(validated).length > 0) {
            out.agentThinking = validated;
        }
    }
    return out;
}

export function settingsPath(agentDir: string): string {
    return join(agentDir, "subagents.json");
}

/** Load settings from global config. */
export function loadSettings(agentDir: string): SubagentsSettings {
    const settingsFile = settingsPath(agentDir);
    try {
        const raw = JSON.parse(readFileSync(settingsFile, "utf-8"));
        return sanitize(raw);
    } catch (err) {
        // A missing file is normal: it is created on the first subagent invocation.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn(
                `[subagents] Failed to load ${settingsFile}: ${(err as Error)?.message ?? String(err)}; using defaults.`,
            );
        }
        return {};
    }
}

/** Write global settings. Returns true on success. */
export function saveSettings(s: SubagentsSettings, agentDir: string): boolean {
    const path = settingsPath(agentDir);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
        return true;
    } catch {
        return false;
    }
}

/**
 * SettingsManager — owns in-memory settings with load/save lifecycle.
 */
export class SettingsManager {
    private _maxConcurrent: number = DEFAULT_MAX_CONCURRENCY;
    private _agentModels: Record<string, string> = {};
    private _agentThinking: Record<string, ThinkingLevel> = {};
    private _loaded = false;
    private readonly agentDir: string;

    constructor() {
        this.agentDir = getAgentDir();
    }

    get maxConcurrent(): number {
        this.ensureLoaded();
        return this._maxConcurrent;
    }

    set maxConcurrent(n: number) {
        this.ensureLoaded();
        this._maxConcurrent = Math.max(1, Math.min(n, MAX_CONCURRENT_CEILING));
    }

    getAgentModel(agentName: string): string | undefined {
        this.ensureLoaded();
        return this._agentModels[agentName];
    }

    setAgentModel(agentName: string, modelId: string | undefined): void {
        this.ensureLoaded();
        if (modelId) {
            this._agentModels[agentName] = modelId;
        } else {
            delete this._agentModels[agentName];
        }
    }

    getAllAgentModels(): Readonly<Record<string, string>> {
        this.ensureLoaded();
        return this._agentModels;
    }

    getAgentThinking(agentName: string): ThinkingLevel | undefined {
        this.ensureLoaded();
        return this._agentThinking[agentName];
    }

    setAgentThinking(agentName: string, level: ThinkingLevel | undefined): void {
        this.ensureLoaded();
        if (level) {
            this._agentThinking[agentName] = level;
        } else {
            delete this._agentThinking[agentName];
        }
    }

    getAllAgentThinking(): Readonly<Record<string, ThinkingLevel>> {
        this.ensureLoaded();
        return this._agentThinking;
    }

    /** Read the config file once, on first access. Keeps extension boot free of disk I/O. */
    private ensureLoaded(): void {
        if (!this._loaded) this.load();
    }

    /** Load from disk (global config). Reads once; subsequent calls are cheap no-ops. */
    load(): void {
        if (this._loaded) return;
        this._loaded = true;
        // Reset before re-applying so keys deleted from the file are evicted.
        this._maxConcurrent = DEFAULT_MAX_CONCURRENCY;
        this._agentModels = {};
        this._agentThinking = {};
        const settings = loadSettings(this.agentDir);
        if (typeof settings.maxConcurrent === "number") {
            this._maxConcurrent = settings.maxConcurrent;
        }
        if (settings.agentModels) {
            this._agentModels = { ...settings.agentModels };
        }
        if (settings.agentThinking) {
            this._agentThinking = { ...settings.agentThinking };
        }
    }

    /** Force a re-read from disk on next load (e.g. after wizard saves). */
    reload(): void {
        this._loaded = false;
        this.load();
    }

    /**
     * Write the config file when it is missing, seeded from the caller's defaults, then sync
     * in-memory state. No-op when the file exists.
     */
    ensureSeeded(payload: SubagentsSettings): void {
        if (existsSync(settingsPath(this.agentDir))) return;
        if (saveSettings(payload, this.agentDir)) this.reload();
    }

    /** Save global settings (writes only non-default fields). */
    save(): boolean {
        this.ensureLoaded();
        const payload: SubagentsSettings = {};
        payload.maxConcurrent = this._maxConcurrent;
        if (Object.keys(this._agentModels).length > 0) {
            payload.agentModels = { ...this._agentModels };
        }
        if (Object.keys(this._agentThinking).length > 0) {
            payload.agentThinking = { ...this._agentThinking };
        }
        return saveSettings(payload, this.agentDir);
    }

    /** Apply a new concurrency value, persist, return toast message. */
    applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
        this.maxConcurrent = n;
        const persisted = this.save();
        return persisted
            ? { message: `Max concurrency set to ${this._maxConcurrent}`, level: "info" }
            : {
                  message: `Max concurrency set to ${this._maxConcurrent} (session only; failed to persist)`,
                  level: "warning",
              };
    }
}
