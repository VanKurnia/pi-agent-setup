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

function globalPath(agentDir: string): string {
  return join(agentDir, "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/** Load layered settings: global provides defaults, project overrides. */
export function loadSettings(agentDir: string, cwd: string): SubagentsSettings {
  const merged: SubagentsSettings = {};

  // Global: read, sanitize, apply
  try {
    const globalRaw = JSON.parse(readFileSync(globalPath(agentDir), "utf-8"));
    Object.assign(merged, sanitize(globalRaw));
  } catch { /* file not found or invalid JSON — skip */ }

  // Project: read, sanitize, apply (overrides global)
  try {
    const projectRaw = JSON.parse(readFileSync(projectPath(cwd), "utf-8"));
    Object.assign(merged, sanitize(projectRaw));
  } catch { /* file not found or invalid JSON — skip */ }

  return merged;
}

/** Write project-local settings. Returns true on success. */
export function saveSettings(s: SubagentsSettings, cwd: string): boolean {
  const path = projectPath(cwd);
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
  private readonly cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
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

  /** Load from disk (global + project merge). */
  load(): void {
    const settings = loadSettings(this.agentDir, this.cwd);
    if (typeof settings.maxConcurrent === "number") {
      this._maxConcurrent = settings.maxConcurrent;
    }
    if (settings.agentModels) {
      this._agentModels = { ...settings.agentModels };
    }
  }

  /** Save project-level settings (writes only non-default fields). */
  save(): boolean {
    const payload: SubagentsSettings = {};
    payload.maxConcurrent = this._maxConcurrent;
    if (Object.keys(this._agentModels).length > 0) {
      payload.agentModels = { ...this._agentModels };
    }
    return saveSettings(payload, this.cwd);
  }

  /** Apply a new concurrency value, persist, return toast message. */
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
    this.maxConcurrent = n;
    const persisted = this.save();
    return persisted
      ? { message: `Max concurrency set to ${this._maxConcurrent}`, level: "info" }
      : { message: `Max concurrency set to ${this._maxConcurrent} (session only; failed to persist)`, level: "warning" };
  }
}
