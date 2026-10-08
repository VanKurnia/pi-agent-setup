/**
 * ext-mgr — toggle-only extension manager.
 *
 * Consolidates discovery, plugin settings management, and interactive pickers
 * into a single module loaded on-demand when `/extensions` is executed.
 */

import { type Dirent } from "node:fs";
import { access, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, matchesGlob, relative } from "node:path";
import {
    getAgentDir,
    type ExtensionCommandContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { showPicker } from "../shared/picker.js";

// =============================================================================
// Constants & Types
// =============================================================================

const DISABLED_SUFFIX = ".disabled";

type Scope = "global" | "project";
type State = "enabled" | "disabled";

interface ExtensionEntry {
    id: string;
    scope: Scope;
    state: State;
    activePath: string;
    disabledPath: string;
    displayName: string;
    summary: string;
}

type PackageSetting = string | PackageObject;

interface PackageObject {
    source: string;
    extensions?: string[];
    [key: string]: unknown;
}

type PackageState = "enabled" | "disabled" | "filtered";

interface RootConfig {
    root: string;
    scope: Scope;
    label: string;
}

interface PackageManifest {
    name?: string;
    dependencies?: Record<string, string>;
    pi?: {
        extensions?: unknown;
    };
}

const MENU_HINT = "↑↓ move · Enter opens a section · Esc exits";
const TOGGLE_HINT =
    "↑↓ move · Enter/Space toggles · type to search · ⇧S saves & offers reload · Esc exits";

const PLUGIN_DETAIL: Record<PackageState, string> = {
    enabled: "loads all declared resources",
    disabled: "all extensions filtered out",
    filtered: "object filters in settings.json",
};

// =============================================================================
// File System & Manifest Helpers
// =============================================================================

function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return `${text.slice(0, maxLength - 3)}...`;
}

function formatSummary(text: string): string {
    return truncate(text.replace(/\s+/g, " ").trim(), 80);
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

/** Strip the comment delimiters and leading asterisks from one comment line. */
function stripCommentMarks(line: string): string {
    return line
        .replace(/^\/\*+/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/^\/\/+/, "")
        .replace(/^\*\s?/, "")
        .trim();
}

async function readSummary(filePath: string): Promise<string> {
    try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]?.trim();
            if (!line) continue;

            if (line.startsWith("/**")) {
                const head = stripCommentMarks(line);
                // A one-line `/** summary */` closes on the opening line.
                if (line.includes("*/")) {
                    if (head) return formatSummary(head);
                    continue;
                }

                const commentLines = head ? [head] : [];
                for (let j = i + 1; j < lines.length; j++) {
                    const commentLine = lines[j]?.trim();
                    if (!commentLine) continue;
                    const cleaned = stripCommentMarks(commentLine);
                    const closed = commentLine.includes("*/");
                    if (closed) {
                        if (cleaned) commentLines.push(cleaned);
                        break;
                    }
                    if (cleaned) commentLines.push(cleaned);
                }
                if (commentLines.length > 0) return formatSummary(commentLines.join(" "));
                continue;
            }

            if (line.startsWith("//")) {
                const commentLines = [stripCommentMarks(line)];
                for (let j = i + 1; j < lines.length; j++) {
                    const nextLine = lines[j]?.trim();
                    if (!nextLine?.startsWith("//")) break;
                    commentLines.push(stripCommentMarks(nextLine));
                }
                return formatSummary(commentLines.join(" "));
            }

            break;
        }

        return "No description available";
    } catch {
        return "No description available";
    }
}

async function readPackageManifest(packageRoot: string): Promise<PackageManifest | undefined> {
    const packageJsonPath = join(packageRoot, "package.json");
    try {
        const raw = await readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return undefined;
        }
        return parsed as PackageManifest;
    } catch {
        return undefined;
    }
}

// =============================================================================
// Relative Path Selection
// =============================================================================

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasGlobMagic(path: string): boolean {
    return /[*?{}[\]]/.test(path);
}

function isSafeRelativePath(path: string): boolean {
    const normalizedPath = path.replace(/\\/g, "/");
    return (
        normalizedPath !== "" &&
        normalizedPath !== ".." &&
        !normalizedPath.startsWith("/") &&
        !path.startsWith("\\") &&
        !/^[A-Za-z]:/.test(normalizedPath) &&
        !normalizedPath.startsWith("../") &&
        !normalizedPath.includes("/../") &&
        !normalizedPath.endsWith("/..")
    );
}

function safeMatchesGlob(targetPath: string, pattern: string): boolean {
    try {
        return matchesGlob(targetPath, pattern);
    } catch {
        return false;
    }
}

function matchesFilterPattern(targetPath: string, pattern: string): boolean {
    const normalizedPattern = normalizeRelativePath(pattern.trim());
    if (!normalizedPattern) return false;
    if (targetPath === normalizedPattern) return true;
    return safeMatchesGlob(targetPath, normalizedPattern);
}

function selectDirectoryFiles(allFiles: readonly string[], directoryPath: string): string[] {
    const prefix = `${directoryPath}/`;
    return allFiles.filter((file) => file.startsWith(prefix));
}

function applySelection(selected: Set<string>, files: Iterable<string>, exclude: boolean): void {
    for (const file of files) {
        if (exclude) {
            selected.delete(file);
        } else {
            selected.add(file);
        }
    }
}

function resolveRelativePathSelection(
    allFiles: readonly string[],
    entries: readonly string[],
    isExactPathSelectable: (path: string, allFiles: readonly string[]) => boolean,
): string[] {
    const selected = new Set<string>();

    for (const rawToken of entries) {
        const token = rawToken.trim();
        if (!token) continue;

        const exclude = token.startsWith("!");
        const normalizedToken = normalizeRelativePath(exclude ? token.slice(1) : token);
        const pattern = normalizedToken.replace(/[\\/]+$/g, "");
        if (!isSafeRelativePath(pattern)) {
            continue;
        }

        if (hasGlobMagic(pattern)) {
            applySelection(
                selected,
                allFiles.filter((file) => matchesFilterPattern(file, pattern)),
                exclude,
            );
            continue;
        }

        const directoryFiles = selectDirectoryFiles(allFiles, pattern);
        if (directoryFiles.length > 0) {
            applySelection(selected, directoryFiles, exclude);
            continue;
        }

        if (isExactPathSelectable(pattern, allFiles)) {
            applySelection(selected, [pattern], exclude);
        }
    }

    return Array.from(selected).sort((a, b) => a.localeCompare(b));
}

// =============================================================================
// Discovery
// =============================================================================

function stripDisabledSuffix(path: string): string {
    return path.replace(/\.(ts|js)\.disabled$/i, ".$1");
}

// `.d.ts` declares types; it is never a runnable entry point.
function isExtensionEntrypointPath(path: string): boolean {
    return /\.(ts|js)$/i.test(path) && !/\.d\.ts$/i.test(path);
}

function isLocalExtensionFile(path: string): boolean {
    return /\.(ts|js)(?:\.disabled)?$/i.test(path) && !/\.d\.ts(?:\.disabled)?$/i.test(path);
}

/** Dependency and build trees never hold a toggleable extension entry point. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build"]);

async function collectLocalExtensionFiles(rootDir: string, startDir: string): Promise<string[]> {
    const collected: string[] = [];

    let entries: Dirent[];
    try {
        entries = await readdir(startDir, { withFileTypes: true });
    } catch {
        return collected;
    }

    for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) {
            continue;
        }

        const absolutePath = join(startDir, entry.name);
        if (entry.isDirectory()) {
            collected.push(...(await collectLocalExtensionFiles(rootDir, absolutePath)));
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const relativePath = normalizeRelativePath(relative(rootDir, absolutePath));
        if (isLocalExtensionFile(relativePath)) {
            collected.push(stripDisabledSuffix(relativePath));
        }
    }

    return collected;
}

async function resolveManifestLocalEntrypoints(dir: string): Promise<string[] | undefined> {
    const manifest = await readPackageManifest(dir);
    const extensions = manifest?.pi?.extensions;
    if (!Array.isArray(extensions)) {
        return undefined;
    }

    const entries = extensions.filter((value): value is string => typeof value === "string");
    const allFiles = await collectLocalExtensionFiles(dir, dir);
    return resolveRelativePathSelection(
        allFiles,
        entries,
        (path, files) => isExtensionEntrypointPath(path) && files.includes(path),
    );
}

async function toDirectoryExtensionEntry(
    root: string,
    label: string,
    scope: Scope,
    dir: string,
    extensionPath: string,
): Promise<ExtensionEntry | undefined> {
    const normalizedPath = normalizeRelativePath(extensionPath);
    const activePath = join(dir, normalizedPath);
    const disabledPath = `${activePath}${DISABLED_SUFFIX}`;

    const [active, disabled] = await Promise.all([
        fileExists(activePath),
        fileExists(disabledPath),
    ]);
    if (!active && !disabled) return undefined;

    const state: State = active ? "enabled" : "disabled";
    const summaryPath = active ? activePath : disabledPath;

    return {
        id: `${scope}:${activePath}`,
        scope,
        state,
        activePath,
        disabledPath,
        displayName: `${label}/${normalizeRelativePath(relative(root, activePath))}`,
        summary: await readSummary(summaryPath),
    };
}

async function parseDirectoryExtensions(
    root: string,
    label: string,
    scope: Scope,
    dirName: string,
): Promise<ExtensionEntry[]> {
    const dir = join(root, dirName);
    const manifestEntrypoints = await resolveManifestLocalEntrypoints(dir);

    if (manifestEntrypoints !== undefined) {
        const entries = await Promise.all(
            manifestEntrypoints.map((extensionPath) =>
                toDirectoryExtensionEntry(root, label, scope, dir, extensionPath),
            ),
        );
        return entries.filter((entry): entry is ExtensionEntry => Boolean(entry));
    }

    const fallbackEntries = await Promise.all(
        ["index.ts", "index.js"].map((extensionPath) =>
            toDirectoryExtensionEntry(root, label, scope, dir, extensionPath),
        ),
    );

    return fallbackEntries.filter((entry): entry is ExtensionEntry => Boolean(entry)).slice(0, 1);
}

function dedupeExtensions(entries: ExtensionEntry[]): ExtensionEntry[] {
    const byId = new Map<string, ExtensionEntry>();
    for (const entry of entries) {
        if (!byId.has(entry.id)) {
            byId.set(entry.id, entry);
        }
    }
    return Array.from(byId.values());
}

async function parseTopLevelFile(
    root: string,
    label: string,
    scope: Scope,
    fileName: string,
): Promise<ExtensionEntry | undefined> {
    const isEnabledTsJs = /\.(ts|js)$/i.test(fileName) && !fileName.endsWith(DISABLED_SUFFIX);
    const isDisabledTsJs = /\.(ts|js)\.disabled$/i.test(fileName);

    if (!isEnabledTsJs && !isDisabledTsJs) return undefined;

    const currentPath = join(root, fileName);
    const activePath = isDisabledTsJs ? currentPath.slice(0, -DISABLED_SUFFIX.length) : currentPath;
    const disabledPath = `${activePath}${DISABLED_SUFFIX}`;
    const state: State = isDisabledTsJs ? "disabled" : "enabled";
    const summary = await readSummary(state === "enabled" ? activePath : disabledPath);
    const relativePath = relative(root, activePath).replace(/\.disabled$/i, "");

    return {
        id: `${scope}:${activePath}`,
        scope,
        state,
        activePath,
        disabledPath,
        displayName: `${label}/${relativePath}`,
        summary,
    };
}

async function discoverInRoot(
    root: string,
    scope: Scope,
    label: string,
): Promise<ExtensionEntry[]> {
    let dirEntries: Dirent[];
    try {
        dirEntries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        console.error(`[extensions-manager] Error reading ${root}:`, error);
        return [];
    }

    const found: ExtensionEntry[] = [];

    for (const item of dirEntries) {
        const name = item.name;
        if (name.startsWith(".") || SKIPPED_DIRS.has(name)) continue;

        if (item.isFile()) {
            const entry = await parseTopLevelFile(root, label, scope, name);
            if (entry) found.push(entry);
            continue;
        }

        if (item.isDirectory()) {
            found.push(...(await parseDirectoryExtensions(root, label, scope, name)));
        }
    }

    return found;
}

async function discoverExtensions(cwd: string): Promise<ExtensionEntry[]> {
    const roots: RootConfig[] = [
        {
            root: join(homedir(), ".pi", "agent", "extensions"),
            scope: "global",
            label: "~/.pi/agent/extensions",
        },
        { root: join(cwd, ".pi", "extensions"), scope: "project", label: ".pi/extensions" },
    ];

    const all: ExtensionEntry[] = [];
    for (const root of roots) {
        all.push(...(await discoverInRoot(root.root, root.scope, root.label)));
    }

    all.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return dedupeExtensions(all);
}

async function setExtensionState(
    entry: Pick<ExtensionEntry, "activePath" | "disabledPath">,
    target: State,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        const [source, destination] =
            target === "enabled"
                ? [entry.disabledPath, entry.activePath]
                : [entry.activePath, entry.disabledPath];
        try {
            await unlink(destination);
        } catch {
            // Destination does not exist; proceed cleanly
        }
        await rename(source, destination);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// =============================================================================
// Plugins
// =============================================================================

function packageSource(entry: PackageSetting): string {
    return typeof entry === "string" ? entry : entry.source;
}

function packageName(entry: PackageSetting): string {
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

function packageState(entry: PackageSetting): PackageState {
    if (typeof entry === "string") return "enabled";
    if (entry.extensions?.length === 0) return "disabled";
    return Object.keys(entry).some((key) => key !== "source") ? "filtered" : "enabled";
}

function setPackageEnabled(entry: PackageSetting, enabled: boolean): PackageSetting {
    if (!enabled) {
        return typeof entry === "string"
            ? { source: entry, extensions: [] }
            : { ...entry, extensions: [] };
    }
    if (typeof entry === "string") return entry;

    const next: PackageObject = { ...entry };
    delete next.extensions;
    return Object.keys(next).length === 1 ? next.source : next;
}

async function readPackages(settingsPath: string): Promise<PackageSetting[]> {
    try {
        const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
        return Array.isArray(parsed.packages) ? (parsed.packages as PackageSetting[]) : [];
    } catch {
        return [];
    }
}

async function writePackages(settingsPath: string, packages: PackageSetting[]): Promise<void> {
    let raw: string;
    try {
        raw = await readFile(settingsPath, "utf8");
    } catch (error) {
        throw new Error(
            `Cannot read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.packages = packages;
    const body = JSON.stringify(parsed, null, 2);
    const content = raw.endsWith("\n") ? `${body}\n` : body;

    const tmpPath = join(
        dirname(settingsPath),
        `.settings-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
        await writeFile(tmpPath, content, "utf8");
        await rename(tmpPath, settingsPath);
    } catch (error) {
        await unlink(tmpPath).catch(() => undefined);
        throw error;
    }
}

// =============================================================================
// UI Presentation & Interaction
// =============================================================================

function settingsPath(): string {
    return join(getAgentDir(), "settings.json");
}

function shortName(entry: ExtensionEntry): string {
    const stripped = entry.displayName
        .replace(/^.*?\/extensions\//, "")
        .replace(/\/index\.(ts|js)$/, "");
    return stripped || entry.displayName;
}

function themedGlyph(theme: Theme, state: State | PackageState): string {
    return state === "disabled" ? theme.fg("muted", "○") : theme.fg("success", "●");
}

function formatEntry(entry: ExtensionEntry): string {
    const mark = entry.state === "disabled" ? "○" : "●";
    return `${mark} ${shortName(entry)} (${entry.scope}) — ${entry.summary}`;
}

function formatPlugin(entry: PackageSetting): string {
    const state = packageState(entry);
    const mark = state === "disabled" ? "○" : "●";
    return `${mark} ${packageName(entry)} — ${packageSource(entry)} · ${PLUGIN_DETAIL[state]}`;
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

async function showExtensionPicker(ctx: ExtensionCommandContext): Promise<boolean> {
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

async function showPluginPicker(ctx: ExtensionCommandContext): Promise<boolean> {
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

async function showManager(ctx: ExtensionCommandContext): Promise<void> {
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
        if (reloaded) return;
    }
}

async function formatListing(ctx: ExtensionCommandContext): Promise<string> {
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

export async function handleExtensionsCommand(
    args: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const sub = args.trim().toLowerCase();

    if (!ctx.hasUI || sub === "list") {
        ctx.ui.notify(await formatListing(ctx), "info");
        return;
    }
    if (sub === "") {
        await showManager(ctx);
        return;
    }
    if (sub === "extensions") {
        await showExtensionPicker(ctx);
        return;
    }
    if (sub === "plugins") {
        await showPluginPicker(ctx);
        return;
    }
    ctx.ui.notify(
        `Unknown subcommand "${sub}". Use /extensions, /extensions list, /extensions extensions or /extensions plugins.`,
        "warning",
    );
}
