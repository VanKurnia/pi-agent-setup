/**
 * Merged 2026-09-30 from per-module sources (see FORK.md). This file is now the source of truth - edit it directly.
 * Merged to cut boot cost: jiti pays ~19ms per module regardless of size.
 */
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import {
    registerNativeUserMessageBox,
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
    registerNativeUserMessageBox(pi);
    registerThinkingLabeling(pi);

    pi.on("session_start", () => {
        resetPistyleRegistries();
    });
}

// from: ansi-utils.ts

const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const STYLE_RESET_PARAMS = [39, 22, 23, 24, 25, 27, 28, 29, 59] as const;
export { ANSI_SGR_PATTERN };
function expandSgrReset(param: number): readonly number[] | undefined {
    return param === 0 ? STYLE_RESET_PARAMS : undefined;
}
function toSgrParams(rawParams: string): number[] {
    if (!rawParams.trim()) {
        return [0];
    }
    const parsed = rawParams
        .split(";")
        .map((token) => Number.parseInt(token, 10))
        .filter((value) => Number.isFinite(value));
    return parsed.length > 0 ? parsed : [];
}
function isFiniteSgrParam(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value);
}
function readSgrColorSequence(params: number[], index: number): number[] | undefined {
    const param = params[index];
    if (param !== 38 && param !== 48) {
        return undefined;
    }
    const colorMode = params[index + 1];
    if (colorMode === 5) {
        const colorValue = params[index + 2];
        return isFiniteSgrParam(colorValue) ? [param, colorMode, colorValue] : undefined;
    }
    if (colorMode === 2) {
        const red = params[index + 2];
        const green = params[index + 3];
        const blue = params[index + 4];
        return isFiniteSgrParam(red) && isFiniteSgrParam(green) && isFiniteSgrParam(blue)
            ? [param, colorMode, red, green, blue]
            : undefined;
    }
    return undefined;
}
function stripBackgroundSgrParams(params: readonly number[]): number[] {
    const sanitized: number[] = [];
    for (let index = 0; index < params.length; index++) {
        const param = params[index] ?? 0;
        if (param === 0) {
            sanitized.push(...expandSgrReset(param)!);
            continue;
        }
        if (param === 49 || (param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
            continue;
        }
        if (param === 38 || param === 48) {
            const sequence = readSgrColorSequence(params as number[], index);
            if (sequence) {
                if (param === 38) {
                    sanitized.push(...sequence);
                }
                index += sequence.length - 1;
                continue;
            }
            const advance = params[index + 1] === 5 ? 2 : params[index + 1] === 2 ? 4 : 0;
            if (advance > 0) {
                index += advance;
                if (param === 38) {
                    sanitized.push(param);
                }
                continue;
            }
        }
        sanitized.push(param);
    }
    return sanitized;
}
function filterSgrSequences(text: string, filter: (params: number[]) => number[]): string {
    if (!text || !text.includes("\x1b[")) {
        return text;
    }
    return text.replace(ANSI_SGR_PATTERN, (_sequence, rawParams: string) => {
        const parsed = toSgrParams(rawParams);
        if (parsed.length === 0) {
            return "";
        }
        const sanitized = filter(parsed);
        if (sanitized.length === 0) {
            return "";
        }
        return `\x1b[${sanitized.join(";")}m`;
    });
}
export function sanitizeAnsiForThemedOutput(text: string): string {
    return filterSgrSequences(text, stripBackgroundSgrParams);
}

// from: types.ts

/**
 * Render sizing for the boxed tool cards. There is no runtime knob: the values
 * below are what shipped, and changing them means editing this constant.
 */
export interface ToolDisplayConfig {
    enableNativeUserMessageBox: boolean;
    collapseAfterTurn: boolean;
    previewLines: number;
    expandedPreviewMaxLines: number;
}

/** Frozen render configuration (previously `extensions/pi-tool-display/config.json`). */
export const TOOL_DISPLAY_CONFIG: ToolDisplayConfig = Object.freeze({
    enableNativeUserMessageBox: true,
    collapseAfterTurn: false,
    previewLines: 8,
    expandedPreviewMaxLines: 4000,
});

// from: tool-metadata.ts

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

// from: debug-logger.ts

const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DEBUG_DIR = join(EXTENSION_ROOT, "debug");
const DEFAULT_DEBUG_LOG_FILE = join(DEFAULT_DEBUG_DIR, "debug.log");
const DEBUG_ENV_VAR = "PI_TOOL_DISPLAY_DEBUG";
const SECRET_VALUE_PATTERN =
    /\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,})\b/g;
interface ToolDisplayDebugLoggerFileSystem {
    mkdirSync: typeof mkdirSync;
    appendFile: typeof appendFile;
}
interface ToolDisplayDebugLoggerOptions {
    debugDir?: string;
    debugLogFile?: string;
    createDate?: () => Date;
    fileSystem?: ToolDisplayDebugLoggerFileSystem;
}
interface ToolDisplayDebugLogger {
    log(message: string, error?: unknown): void;
    flush(): Promise<void>;
}
const DEFAULT_FILE_SYSTEM: ToolDisplayDebugLoggerFileSystem = {
    mkdirSync,
    appendFile,
};
function redactMessage(value: string): string {
    return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}
function createToolDisplayDebugLogger(
    options: ToolDisplayDebugLoggerOptions = {},
): ToolDisplayDebugLogger {
    const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
    const debugLogFile = options.debugLogFile ?? DEFAULT_DEBUG_LOG_FILE;
    const createDate = options.createDate ?? (() => new Date());
    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    let debugDirectoryReady = false;
    let writeQueue: Promise<void> = Promise.resolve();
    function isDebugEnabled(): boolean {
        return process.env[DEBUG_ENV_VAR] === "1";
    }
    function ensureDebugDirectory(): void {
        if (debugDirectoryReady) {
            return;
        }
        fileSystem.mkdirSync(debugDir, { recursive: true });
        debugDirectoryReady = true;
    }
    function appendLine(line: string): Promise<void> {
        return fileSystem.appendFile(debugLogFile, line, "utf8");
    }
    return {
        log(message: string, error?: unknown): void {
            if (!isDebugEnabled()) {
                return;
            }
            try {
                ensureDebugDirectory();
                const errorText =
                    error instanceof Error
                        ? `${error.name}: ${error.message}`
                        : error === undefined
                          ? ""
                          : String(error);
                const suffix = errorText ? ` ${redactMessage(errorText)}` : "";
                const line = `${createDate().toISOString()} ${redactMessage(message)}${suffix}\n`;
                writeQueue = writeQueue.then(
                    () => appendLine(line),
                    () => appendLine(line),
                );
                void writeQueue.catch(() => undefined);
            } catch (logError) {
                // Debug logging must never affect extension behavior.
                void logError;
            }
        },
        flush(): Promise<void> {
            return writeQueue.catch(() => undefined);
        },
    };
}
const defaultDebugLogger = createToolDisplayDebugLogger();
export function logToolDisplayDebug(message: string, error?: unknown): void {
    defaultDebugLogger.log(message, error);
}

// from: disposable.ts

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

// from: index.ts (entry helper)

/** Runs `cleanup` when the session shuts down for a reload. */
export function onReloadShutdown(pi: ExtensionAPI, cleanup: () => void): void {
    pi.on("session_shutdown", (event: SessionShutdownEvent) => {
        if (event.reason === "reload") {
            cleanup();
        }
    });
}
