/** Cleanup threshold + auto-clean throttle stamp for session-mgr. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_FILE_NAME = "session-mgr-settings.json";

export interface CleanupSettings {
    autoCleanThresholdDays: number;
    lastAutoCleanAt: string;
}

const DEFAULT_SETTINGS: Required<CleanupSettings> = {
    autoCleanThresholdDays: 30,
    lastAutoCleanAt: "",
};

function getSettingsPath(): string {
    return join(getAgentDir(), SETTINGS_FILE_NAME);
}

function normalizeThreshold(value: unknown): number {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3650) {
        return value;
    }
    return DEFAULT_SETTINGS.autoCleanThresholdDays;
}

function normalizeStamp(value: unknown): string {
    if (typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value))) {
        return value;
    }
    return "";
}

/** Load cleanup settings. Missing/corrupt/invalid → defaults. Never throws. */
export function loadCleanupSettings(): Required<CleanupSettings> {
    try {
        const settingsPath = getSettingsPath();
        if (!existsSync(settingsPath)) return { ...DEFAULT_SETTINGS };
        const raw = readFileSync(settingsPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<CleanupSettings>;
        return {
            autoCleanThresholdDays: normalizeThreshold(parsed.autoCleanThresholdDays),
            lastAutoCleanAt: normalizeStamp(parsed.lastAutoCleanAt),
        };
    } catch (error) {
        console.error("Failed to load session-mgr settings:", error);
        return { ...DEFAULT_SETTINGS };
    }
}

/** Save cleanup settings. Creates the agent dir if needed. Never throws. */
export function saveCleanupSettings(settings: Required<CleanupSettings>): void {
    try {
        const settingsPath = getSettingsPath();
        const dir = dirname(settingsPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    } catch (error) {
        console.error("Failed to save session-mgr settings:", error);
    }
}
