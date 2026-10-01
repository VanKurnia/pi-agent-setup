/**
 * Presentation layer for the extension manager: the two sections (`Extensions`, `Plugins`),
 * the plain-text listing, and the toggle pickers.
 *
 * Both pickers share `agent/extensions/shared/picker.ts`; its `onPick` hook keeps the dialog
 * open while entries are toggled in place, and `⇧S` ends the session by offering a reload
 * instead of leaving it as manual work.
 */

import { join } from "node:path";
import {
    getAgentDir,
    type ExtensionCommandContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { showPicker } from "../../shared/picker.js";
import { discoverExtensions, setExtensionState } from "./discovery.js";
import {
    packageName,
    packageSource,
    packageState,
    readPackages,
    setPackageEnabled,
    writePackages,
    type PackageSetting,
    type PackageState,
} from "./plugins.js";
import type { ExtensionEntry, State } from "./types.js";

const MENU_HINT = "↑↓ move · Enter opens a section · Esc exits";
const TOGGLE_HINT =
    "↑↓ move · Enter/Space toggles · type to search · ⇧S saves & offers reload · Esc exits";

const PLUGIN_DETAIL: Record<PackageState, string> = {
    enabled: "loads all declared resources",
    disabled: "all extensions filtered out",
    filtered: "object filters in settings.json",
};

function settingsPath(): string {
    return join(getAgentDir(), "settings.json");
}

/** `~/.pi/agent/extensions/bash-guard/index.ts` → `bash-guard`; other paths are kept as-is. */
export function shortName(entry: ExtensionEntry): string {
    const stripped = entry.displayName
        .replace(/^.*?\/extensions\//, "")
        .replace(/\/index\.(ts|js)$/, "");
    return stripped || entry.displayName;
}

function glyph(state: State | PackageState): string {
    return state === "disabled" ? "○" : "●";
}

function themedGlyph(theme: Theme, state: State | PackageState): string {
    return state === "disabled" ? theme.fg("muted", "○") : theme.fg("success", "●");
}

/** Plain-text rows for `/extensions list` (no ANSI, so print/RPC hosts render them too). */
export function formatEntry(entry: ExtensionEntry): string {
    return `${glyph(entry.state)} ${shortName(entry)} (${entry.scope}) — ${entry.summary}`;
}

export function formatPlugin(entry: PackageSetting): string {
    const state = packageState(entry);
    return `${glyph(state)} ${packageName(entry)} — ${packageSource(entry)} · ${PLUGIN_DETAIL[state]}`;
}

function extensionItems(entries: ExtensionEntry[], theme: Theme): SelectItem[] {
    return entries.map((entry) => ({
        value: entry.id,
        label: `${themedGlyph(theme, entry.state)} ${theme.bold(shortName(entry))} ${theme.fg("dim", entry.scope)}`,
        description: entry.summary,
    }));
}

function pluginItems(packages: PackageSetting[], theme: Theme): SelectItem[] {
    return packages.map((entry) => {
        const state = packageState(entry);
        return {
            value: packageSource(entry),
            label: `${themedGlyph(theme, state)} ${theme.bold(packageName(entry))} ${theme.fg("dim", "plugin")}`,
            description: `${packageSource(entry)} · ${PLUGIN_DETAIL[state]}`,
        };
    });
}

/**
 * Run a picker whose confirm action toggles an entry in place, then report what happened.
 *
 * `toggle` returns the description of a change, `undefined` to close quietly, or throws to
 * close and surface the message as an error notification. Pressing `S` finishes and offers a
 * reload; `ctx.reload()` is only awaited before returning, never mid-dialog.
 */
async function runTogglePicker(
    ctx: ExtensionCommandContext,
    title: string,
    build: (theme: Theme) => SelectItem[],
    toggle: (value: string) => Promise<string | undefined>,
): Promise<boolean> {
    const changed: string[] = [];
    let failure: string | undefined;
    let saved = false;

    await showPicker(ctx, title, TOGGLE_HINT, build, {
        onPick: async (value, theme) => {
            try {
                const description = await toggle(value);
                if (description === undefined) return "close";
                changed.push(description);
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
                return "close";
            }
            return build(theme);
        },
        onSave: () => {
            saved = true;
        },
        spaceConfirms: true,
    });

    if (failure) {
        ctx.ui.notify(failure, "error");
        return false;
    }
    if (saved) return offerReload(ctx, changed);
    if (changed.length > 0) ctx.ui.notify(manualHint(changed), "info");
    return false;
}

function manualHint(changed: string[]): string {
    return `${changed.join(", ")} — run /reload to apply`;
}

/**
 * Ask whether to reload now. Declining (or a failed reload) leaves the manual `/reload` hint.
 * Returns whether the session was reloaded, so callers stop touching this runtime.
 */
async function offerReload(ctx: ExtensionCommandContext, changed: string[]): Promise<boolean> {
    if (changed.length === 0) {
        ctx.ui.notify("No changes to apply.", "info");
        return false;
    }
    const reload = await ctx.ui.confirm(
        "Reload pi now?",
        `${changed.join(", ")} — reload to activate.`,
    );
    if (!reload) {
        ctx.ui.notify(manualHint(changed), "info");
        return false;
    }
    try {
        await ctx.reload();
        return true;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Reload failed: ${detail}. Run /reload to retry.`, "error");
        return false;
    }
}

/** Toggle local extensions by renaming their entry file. Returns whether a reload happened. */
export async function showExtensionPicker(ctx: ExtensionCommandContext): Promise<boolean> {
    const entries = await discoverExtensions(ctx.cwd);
    if (entries.length === 0) {
        ctx.ui.notify("No local extensions found.", "info");
        return false;
    }

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return runTogglePicker(
        ctx,
        "Extensions",
        (theme) => extensionItems(entries, theme),
        async (id) => {
            const entry = byId.get(id);
            if (!entry) return undefined;

            const target: State = entry.state === "enabled" ? "disabled" : "enabled";
            const result = await setExtensionState(entry, target);
            if (!result.ok) {
                const verb = target === "enabled" ? "enable" : "disable";
                throw new Error(`Failed to ${verb} ${shortName(entry)}: ${result.error}`);
            }

            entry.state = target;
            return `${shortName(entry)} → ${target}`;
        },
    );
}

/**
 * Toggle plugins by writing or dropping the `extensions: []` filter in the settings file.
 * Returns whether a reload happened.
 */
export async function showPluginPicker(ctx: ExtensionCommandContext): Promise<boolean> {
    const path = settingsPath();
    const packages = await readPackages(path);
    if (packages.length === 0) {
        ctx.ui.notify(`No packages configured in ${path}.`, "info");
        return false;
    }

    return runTogglePicker(
        ctx,
        "Plugins",
        (theme) => pluginItems(packages, theme),
        async (source) => {
            const index = packages.findIndex((entry) => packageSource(entry) === source);
            if (index === -1) return undefined;

            const enable = packageState(packages[index]) === "disabled";
            const next = setPackageEnabled(packages[index], enable);
            packages[index] = next;

            try {
                await writePackages(path, packages);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Failed to write ${path}: ${detail}`);
            }

            return `${packageName(next)} → ${enable ? "enabled" : "disabled"}`;
        },
    );
}

/** `/extensions`: pick a section, work in it, then return to the section menu. */
export async function showManager(ctx: ExtensionCommandContext): Promise<void> {
    for (;;) {
        const localCount = (await discoverExtensions(ctx.cwd)).length;
        const pluginCount = (await readPackages(settingsPath())).length;

        const picked = await showPicker(ctx, "Extensions manager", MENU_HINT, (theme) => [
            {
                value: "extensions",
                label: `${theme.bold("Extensions")} ${theme.fg("dim", `${localCount} local`)}`,
                description: "local extensions — on/off by renaming <file>.disabled",
            },
            {
                value: "plugins",
                label: `${theme.bold("Plugins")} ${theme.fg("dim", `${pluginCount} configured`)}`,
                description: "packages in agent/settings.json — on/off via extensions: []",
            },
        ]);

        if (picked === null) return;
        const reloaded =
            picked === "extensions" ? await showExtensionPicker(ctx) : await showPluginPicker(ctx);
        // A reload replaces this extension instance — do not open another dialog from it.
        if (reloaded) return;
    }
}

/** Text listing for `/extensions list` and non-interactive hosts. */
export async function formatListing(ctx: ExtensionCommandContext): Promise<string> {
    const entries = await discoverExtensions(ctx.cwd);
    const packages = await readPackages(settingsPath());

    return [
        `Extensions (${entries.length} local):`,
        ...(entries.length > 0 ? entries.map(formatEntry) : ["  none"]),
        "",
        `Plugins (${packages.length} configured in agent/settings.json):`,
        ...(packages.length > 0 ? packages.map(formatPlugin) : ["  none"]),
    ].join("\n");
}
