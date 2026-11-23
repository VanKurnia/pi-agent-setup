import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import {
    registerPistyleToolRenderer,
    registerThinkingLabeling,
    registerToolDecoration,
    resetPistyleRegistries,
} from "./wiring.ts";

// ── Main Extension Entry Point ──────────────────────────────────────────────

export default function toolDisplayExtension(pi: ExtensionAPI): void {
    resetDisposed();

    pi.on("session_shutdown", (event: SessionShutdownEvent) => {
        resetPistyleRegistries();
        if (event.reason === "reload") {
            disposeAll();
        }
    });

    registerToolDecoration(pi);
    registerPistyleToolRenderer(pi);
    registerThinkingLabeling(pi);

    pi.on("session_start", () => {
        resetPistyleRegistries();
    });
}

/** Render sizing for the boxed tool cards. There is no runtime knob: the values
 * below are what shipped, and changing them means editing this constant. */
export interface ToolDisplayConfig {
    collapseAfterTurn: boolean;
    previewLines: number;
    expandedPreviewMaxLines: number;
}

/** Frozen render configuration (previously `extensions/pi-tool-display/config.json`). */
export const TOOL_DISPLAY_CONFIG: ToolDisplayConfig = Object.freeze({
    collapseAfterTurn: false,
    previewLines: 8,
    expandedPreviewMaxLines: 4000,
});

const MCP_DESCRIPTION_PATTERN = /\bmcp\b/i;
const MCP_ADAPTER_SOURCE_PATTERN =
    /(?:^|[/\\@_-])(?:pi-)?mcp(?:[/\\@_-]|$)|pi-mcp-adapter|mcp-adapter/i;
const MAX_PROMPT_SNIPPET_LENGTH = 120;
export const MCP_PROXY_PROMPT_SNIPPET =
    "Discover, inspect, and call MCP tools across configured servers";
export const MCP_PROXY_PROMPT_GUIDELINES = [
    "Use mcp for MCP discovery first: search by capability, describe one exact tool, then call it.",
] as const;
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function toRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        return {};
    }
    return value;
}
export function getTextField(value: unknown, field: string): string | undefined {
    const record = toRecord(value);
    const raw = record[field];
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}
function normalizeInlineText(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}
function trimPromptSnippet(value: string): string {
    if (value.length <= MAX_PROMPT_SNIPPET_LENGTH) {
        return value;
    }
    const truncated = value.slice(0, MAX_PROMPT_SNIPPET_LENGTH).trimEnd();
    return `${truncated.replace(/[\s.,;:!?-]+$/u, "")}…`;
}
export function buildPromptSnippetFromDescription(
    description: string | undefined,
    fallback: string,
): string {
    const normalizedDescription = normalizeInlineText(description || "");
    const normalizedFallback = normalizeInlineText(fallback);
    const base = normalizedDescription || normalizedFallback;
    const firstSentence = base.split(/(?<=[.!?])\s+/u, 1)[0] ?? base;
    const withoutSentencePunctuation = firstSentence.replace(/[.!?]+$/u, "").trim();
    return trimPromptSnippet(withoutSentencePunctuation || base);
}
function hasMcpSourceInfo(value: unknown): boolean {
    const sourceInfo = toRecord(value);
    for (const [key, raw] of Object.entries(sourceInfo)) {
        if (typeof raw !== "string" || raw.trim().length === 0) {
            continue;
        }
        const normalizedKey = key.toLowerCase();
        const normalizedValue = raw.trim();
        if (
            ["source", "type", "kind", "origin"].includes(normalizedKey) &&
            normalizedValue.toLowerCase() === "mcp"
        ) {
            return true;
        }
        if (MCP_ADAPTER_SOURCE_PATTERN.test(normalizedValue)) {
            return true;
        }
    }
    return false;
}
export function isMcpToolCandidate(tool: unknown): boolean {
    if (!tool || typeof tool !== "object") {
        return false;
    }
    const record = tool as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const description = typeof record.description === "string" ? record.description : "";
    const label = typeof record.label === "string" ? record.label : "";
    if (name === "mcp") {
        return true;
    }
    if (MCP_DESCRIPTION_PATTERN.test(description) || MCP_DESCRIPTION_PATTERN.test(label)) {
        return true;
    }
    if (hasMcpSourceInfo(record.sourceInfo)) {
        return true;
    }
    if (/^mcp[_-]/i.test(name) || /_mcp$/i.test(name)) {
        return true;
    }
    if (name.includes(":")) {
        return true;
    }
    if (/^ctx_/i.test(name)) {
        return true;
    }
    const params = record.parameters;
    if (params && typeof params === "object") {
        const parameterRecord = params as Record<string, unknown>;
        if (
            "mcpServer" in parameterRecord ||
            "serverUrl" in parameterRecord ||
            "server_name" in parameterRecord
        ) {
            return true;
        }
    }
    return false;
}

const EXTENSION_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEBUG_DIR = join(EXTENSION_ROOT, "debug");
const DEFAULT_DEBUG_LOG_FILE = join(DEFAULT_DEBUG_DIR, "debug.log");
const DEBUG_ENV_VAR = "PI_TOOL_DISPLAY_DEBUG";
const SECRET_VALUE_PATTERN =
    /\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,})\b/g;
function redactMessage(value: string): string {
    return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}
let debugDirectoryReady = false;
let debugWriteQueue: Promise<void> = Promise.resolve();
/** Logs to the extension's own debug file when `PI_TOOL_DISPLAY_DEBUG=1`; never affects rendering. */
export function logToolDisplayDebug(message: string, error?: unknown): void {
    if (process.env[DEBUG_ENV_VAR] !== "1") return;
    try {
        if (!debugDirectoryReady) {
            mkdirSync(DEFAULT_DEBUG_DIR, { recursive: true });
            debugDirectoryReady = true;
        }
        const errorText =
            error instanceof Error
                ? `${error.name}: ${error.message}`
                : error === undefined
                  ? ""
                  : String(error);
        const suffix = errorText ? ` ${redactMessage(errorText)}` : "";
        const line = `${new Date().toISOString()} ${redactMessage(message)}${suffix}\n`;
        const append = (): Promise<void> => appendFile(DEFAULT_DEBUG_LOG_FILE, line, "utf8");
        debugWriteQueue = debugWriteQueue.then(append, append);
        void debugWriteQueue.catch(() => undefined);
    } catch {
        // Debug logging must never affect extension behavior.
    }
}

// Track cleanup callbacks for reload safety
let cleanupCallbacks: Array<() => void> = [];
let isDisposed = false;
export function registerCleanup(callback: () => void): void {
    if (isDisposed) {
        callback();
        return;
    }
    cleanupCallbacks.push(callback);
}
export function disposeAll(): void {
    if (isDisposed) return;
    isDisposed = true;
    // Run in reverse order (LIFO)
    for (let i = cleanupCallbacks.length - 1; i >= 0; i--) {
        try {
            cleanupCallbacks[i]();
        } catch (cleanupError) {
            void cleanupError;
        }
    }
    cleanupCallbacks = [];
}
export function resetDisposed(): void {
    isDisposed = false;
    cleanupCallbacks = [];
}

/** Runs `cleanup` when the session shuts down for a reload. */
export function onReloadShutdown(pi: ExtensionAPI, cleanup: () => void): void {
    pi.on("session_shutdown", (event: SessionShutdownEvent) => {
        if (event.reason === "reload") {
            cleanup();
        }
    });
}
