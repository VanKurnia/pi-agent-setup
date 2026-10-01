/**
 * Plugin (npm/git/local package) toggles for the pi settings file.
 *
 * A `settings.packages` entry is either a bare source string — everything the package
 * declares loads — or the object form with per-resource filters. Turning a package off
 * sets `extensions: []`, the documented "load none of that type" filter; turning it back on
 * drops that filter, collapsing to the bare source when nothing else is configured.
 *
 * Known limitation: an entry that already carried a non-empty `extensions` filter (`!glob`,
 * `+path`, `-path`, partial list) loses that filter when toggled off and back on — the other
 * filter keys are preserved, only `extensions` is replaced.
 */

import { readFile, writeFile } from "node:fs/promises";

/** A `settings.packages` entry: a bare source, or the object form with per-resource filters. */
export type PackageSetting = string | PackageObject;

export interface PackageObject {
    source: string;
    /** `[]` filters out every extension the package declares — how a plugin is switched off. */
    extensions?: string[];
    [key: string]: unknown;
}

export type PackageState = "enabled" | "disabled" | "filtered";

export function packageSource(entry: PackageSetting): string {
    return typeof entry === "string" ? entry : entry.source;
}

/** Display name: `npm:pi-zentui` → `pi-zentui`; URLs fall back to their last path segment. */
export function packageName(entry: PackageSetting): string {
    const bare = packageSource(entry).replace(/^(npm|git|file|local):/, "");
    if (/^(https?:\/\/|git@)/.test(bare)) {
        const segment = bare
            .replace(/\.git$/, "")
            .split(/[/:]/)
            .filter(Boolean)
            .pop();
        return segment ?? bare;
    }
    return bare;
}

/**
 * `disabled` means every declared extension is filtered out. `filtered` means the entry
 * carries some other narrowing (another resource type, a glob, a partial list).
 */
export function packageState(entry: PackageSetting): PackageState {
    if (typeof entry === "string") return "enabled";
    if (entry.extensions?.length === 0) return "disabled";
    return Object.keys(entry).some((key) => key !== "source") ? "filtered" : "enabled";
}

/** Return a new entry with the package switched on or off. Pure — does not touch disk. */
export function setPackageEnabled(entry: PackageSetting, enabled: boolean): PackageSetting {
    if (!enabled) {
        return typeof entry === "string"
            ? { source: entry, extensions: [] }
            : { ...entry, extensions: [] };
    }
    if (typeof entry === "string") return entry;

    const next: PackageObject = { ...entry };
    delete next.extensions;
    // Nothing left to configure — collapse back to the bare source form.
    return Object.keys(next).length === 1 ? next.source : next;
}

/** Read `settings.packages`, or an empty list when the file or the key is missing. */
export async function readPackages(settingsPath: string): Promise<PackageSetting[]> {
    try {
        const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
        return Array.isArray(parsed.packages) ? (parsed.packages as PackageSetting[]) : [];
    } catch {
        return [];
    }
}

/**
 * Rewrite `settings.packages`, preserving every other key and the file's formatting. pi
 * writes this file as 2-space JSON; the original trailing-newline convention is reproduced
 * exactly, so a write that changes nothing round-trips byte-for-byte.
 */
export async function writePackages(
    settingsPath: string,
    packages: PackageSetting[],
): Promise<void> {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.packages = packages;
    const body = JSON.stringify(parsed, null, 2);
    await writeFile(settingsPath, raw.endsWith("\n") ? `${body}\n` : body, "utf8");
}
