/**
 * Local extension discovery and the enable/disable rename.
 *
 * Extensions live in a global root (`~/.pi/agent/extensions`) and an optional project root
 * (`<cwd>/.pi/extensions`). An entry is either a top-level `.ts`/`.js` file or a directory
 * whose `package.json` declares `pi.extensions` (falling back to `index.ts`/`index.js`).
 * The `.disabled` suffix on a filename is the off state.
 */

import { type Dirent } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { DISABLED_SUFFIX } from "./constants.js";
import { readPackageManifest } from "./manifest.js";
import { type ExtensionEntry, type Scope, type State } from "./types.js";
import { fileExists, readSummary } from "./fs.js";
import { normalizeRelativePath, resolveRelativePathSelection } from "./relative-path-selection.js";

interface RootConfig {
    root: string;
    scope: Scope;
    label: string;
}

/** Discover every entry in both roots, sorted by display name. */
export async function discoverExtensions(cwd: string): Promise<ExtensionEntry[]> {
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

/** Discover one root directory. A missing project root is normal, not an error. */
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

        if (name.startsWith(".")) continue;

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

/** Parse a top-level `.ts`/`.js` file, or its `.disabled` twin, as an entry. */
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

function stripDisabledSuffix(path: string): string {
    return path.replace(/\.(ts|js)\.disabled$/i, ".$1");
}

function isExtensionEntrypointPath(path: string): boolean {
    return /\.(ts|js)$/i.test(path);
}

function isLocalExtensionFile(path: string): boolean {
    return /\.(ts|js)(?:\.disabled)?$/i.test(path);
}

async function collectLocalExtensionFiles(rootDir: string, startDir: string): Promise<string[]> {
    const collected: string[] = [];

    let entries: Dirent[];
    try {
        entries = await readdir(startDir, { withFileTypes: true });
    } catch {
        return collected;
    }

    for (const entry of entries) {
        if (entry.name.startsWith(".")) {
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

/**
 * Parse a directory containing a manifest-declared entrypoint or index.ts/js file as one or more
 * extension entries.
 */
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

/** Keep the first entry per ID, so a file and its `.disabled` twin cannot both appear. */
function dedupeExtensions(entries: ExtensionEntry[]): ExtensionEntry[] {
    const byId = new Map<string, ExtensionEntry>();
    for (const entry of entries) {
        if (!byId.has(entry.id)) {
            byId.set(entry.id, entry);
        }
    }
    return Array.from(byId.values());
}

/** Toggle an extension by renaming its entry file to or from the `.disabled` suffix. */
export async function setExtensionState(
    entry: Pick<ExtensionEntry, "activePath" | "disabledPath">,
    target: State,
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        if (target === "enabled") {
            await rename(entry.disabledPath, entry.activePath);
        } else {
            await rename(entry.activePath, entry.disabledPath);
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
