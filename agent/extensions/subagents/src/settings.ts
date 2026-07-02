import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SubagentsSettings {
    maxConcurrent?: number;
    agentModels?: Record<string, string>;
}

export const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENT_CEILING = 1024;

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
    return out;
}

export function settingsPath(agentDir: string): string {
    return join(agentDir, "subagents.json");
}

/** Load settings from global config. */
export function loadSettings(agentDir: string): SubagentsSettings {
    try {
        const raw = JSON.parse(readFileSync(settingsPath(agentDir), "utf-8"));
        return sanitize(raw);
    } catch {
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
 * Minimal: only manages maxConcurrent. Expand when needed.
 */
export class SettingsManager {
    private _maxConcurrent: number = DEFAULT_MAX_CONCURRENCY;
    private _agentModels: Record<string, string> = {};
    private readonly agentDir: string;

    constructor() {
        this.agentDir = getAgentDir();
    }

    get maxConcurrent(): number {
        return this._maxConcurrent;
    }

    set maxConcurrent(n: number) {
        this._maxConcurrent = Math.max(1, Math.min(n, MAX_CONCURRENT_CEILING));
    }

    getAgentModel(agentName: string): string | undefined {
        return this._agentModels[agentName];
    }

    setAgentModel(agentName: string, modelId: string | undefined): void {
        if (modelId) {
            this._agentModels[agentName] = modelId;
        } else {
            delete this._agentModels[agentName];
        }
    }

    getAllAgentModels(): Readonly<Record<string, string>> {
        return this._agentModels;
    }

    /** Load from disk (global config). */
    load(): void {
        const settings = loadSettings(this.agentDir);
        if (typeof settings.maxConcurrent === "number") {
            this._maxConcurrent = settings.maxConcurrent;
        }
        if (settings.agentModels) {
            this._agentModels = { ...settings.agentModels };
        }
    }

    /** Save global settings (writes only non-default fields). */
    save(): boolean {
        const payload: SubagentsSettings = {};
        payload.maxConcurrent = this._maxConcurrent;
        if (Object.keys(this._agentModels).length > 0) {
            payload.agentModels = { ...this._agentModels };
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
