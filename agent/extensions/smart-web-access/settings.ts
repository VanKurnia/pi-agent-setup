/**
 * The extension's settings, read from the settings pi already merged.
 *
 * `pi.getSettings()` is the global/project merge (project wins, and only in a
 * trusted project), so this module only validates the values and resolves the
 * legacy key names. It is imported lazily from the tool handlers: reading
 * settings only happens when a tool is called.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchToolConfig, FingerprintOs, IncludeRepliesOption } from "./types.ts";

const VALID_OS_VALUES = new Set<FingerprintOs>(["windows", "macos", "linux", "android", "ios"]);

export interface ResolvedSmartFetchSettings extends FetchToolConfig {
    verboseByDefault: boolean;
    /** `smartWebSearch.resultsPerQuery`, before clamping. */
    resultsPerQuery: number | undefined;
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isPositiveNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";
const isFingerprintOs = (value: unknown): value is FingerprintOs =>
    typeof value === "string" && VALID_OS_VALUES.has(value as FingerprintOs);
const isIncludeReplies = (value: unknown): value is IncludeRepliesOption =>
    typeof value === "boolean" || value === "extractors";

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * Read the first alias that holds an acceptable value, so a renamed setting
 * keeps working alongside the current name.
 */
function readSetting<T>(
    source: Record<string, unknown>,
    keys: readonly string[],
    accept: (value: unknown) => value is T,
): T | undefined {
    for (const key of keys) {
        const value = source[key];
        if (accept(value)) return value;
    }
    return undefined;
}

/** `settings`: the value of `pi.getSettings()`. */
export function readSmartFetchSettings(settings: unknown): ResolvedSmartFetchSettings {
    const source = asRecord(settings) ?? {};
    const search = asRecord(source.smartWebSearch);
    const resultsPerQuery = search?.resultsPerQuery;

    return {
        verboseByDefault:
            readSetting(
                source,
                ["smartFetchVerboseByDefault", "webFetchVerboseByDefault"],
                isBoolean,
            ) ?? false,
        maxChars: readSetting(
            source,
            ["smartFetchDefaultMaxChars", "webFetchDefaultMaxChars"],
            isPositiveNumber,
        ),
        timeoutMs: readSetting(source, ["smartFetchDefaultTimeoutMs"], isPositiveNumber),
        browser: readSetting(source, ["smartFetchDefaultBrowser"], isNonEmptyString),
        os: readSetting(source, ["smartFetchDefaultOs"], isFingerprintOs),
        removeImages: readSetting(source, ["smartFetchDefaultRemoveImages"], isBoolean),
        includeReplies: readSetting(source, ["smartFetchDefaultIncludeReplies"], isIncludeReplies),
        tempDir:
            readSetting(source, ["smartFetchTempDir", "webFetchTempDir"], isNonEmptyString) ??
            join(tmpdir(), "smart-fetch-pi"),
        resultsPerQuery: typeof resultsPerQuery === "number" ? resultsPerQuery : undefined,
    };
}
