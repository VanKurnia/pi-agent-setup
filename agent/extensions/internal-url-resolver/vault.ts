import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { formatError, PiUrlResult } from "./types.ts";
import { resolveVaultRoot, isInside } from "../shared/resolve-vault.ts";

const MAX_WIKILINK_DEPTH = 5;

function safeRead(path: string): string | null {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

function absPathToPiUrl(vaultRoot: string, absPath: string): string {
    // Normalize both paths to forward slashes for reliable string replacement
    const normalizedRoot = vaultRoot.replace(/\\/g, "/");
    const normalizedPath = absPath.replace(/\\/g, "/");
    const rel = normalizedPath.replace(normalizedRoot, "");
    const withoutExt = rel.replace(/\.md$/i, "");
    return `pi://vault${withoutExt}`;
}

/**
 * Recursively search for a file by name under root, up to maxDepth.
 * Returns absolute path or null. Skips hidden dirs.
 */
function findFile(root: string, fileName: string, maxDepth: number): string | null {
    if (maxDepth < 0) return null;
    try {
        const entries = readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue; // skip hidden
            const fullPath = join(root, entry.name);
            if (entry.isDirectory()) {
                const found = findFile(fullPath, fileName, maxDepth - 1);
                if (found) return found;
            } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
                return fullPath;
            }
        }
    } catch {
        // permission denied, skip
    }
    return null;
}

function resolveWikilinks(content: string, vaultRoot: string): string {
    const linkRegex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

    return content.replace(linkRegex, (_match, rawLink, displayText) => {
        let targetPath = "";
        const baseSearch = join(vaultRoot, `${rawLink}.md`);
        if (existsSync(baseSearch)) {
            targetPath = baseSearch;
        } else {
            const found = findFile(vaultRoot, `${rawLink}.md`, MAX_WIKILINK_DEPTH);
            if (found) targetPath = found;
        }

        const url = targetPath ? absPathToPiUrl(vaultRoot, targetPath) : "#";
        return `[${displayText || rawLink}](${url})`;
    });
}

function listDirectory(vaultRoot: string, dirPath: string, url: string): PiUrlResult {
    const absDir = join(vaultRoot, dirPath);
    try {
        const entries = readdirSync(absDir, { withFileTypes: true });
        const items = entries
            .filter((e) => !e.name.startsWith("."))
            .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            .map((e) => {
                const icon = e.isDirectory() ? "📁" : "📄";
                const linkPath = join(dirPath, e.name).replace(/\\/g, "/");
                return `${icon} [${e.name}](pi://vault/${linkPath})`;
            });

        // ── Add parent breadcrumb ──
        if (dirPath) {
            const parentPath = dirPath.split("/").slice(0, -1).join("/");
            items.unshift("📁 [..](pi://vault/" + (parentPath || "") + ")");
        }

        const header = dirPath ? `**Notes in ${dirPath}**:` : `**Obsidian Vault**: ${vaultRoot}`;
        const body = items.length ? items.join("\n") : "*No notes found.*";
        return {
            content: `${header}\n\n${body}`,
            mime: "text/markdown",
            protocol: "vault",
            path: dirPath,
        };
    } catch {
        return {
            content: formatError(`Cannot list directory: ${dirPath}`, url),
            mime: "text/markdown",
            protocol: "vault",
            path: dirPath,
        };
    }
}

export function resolveVaultUrl(path: string, url: string, _cwd?: string): PiUrlResult {
    const vaultRoot = resolveVaultRoot();

    if (!vaultRoot) {
        return {
            content: formatError("No vault root configured", url),
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }

    // Resolve relative path against vault root first
    const fullPath = resolvePath(vaultRoot, path || "");

    // Guard: reject traversal outside vault root
    if (!isInside(vaultRoot, fullPath)) {
        return {
            content: formatError(`Path traversal rejected: ${path}`, url),
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }

    // Empty path → list vault root
    if (!path) {
        return listDirectory(vaultRoot, "", url);
    }

    // Check if path is a directory
    try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            return listDirectory(vaultRoot, path, url);
        }
    } catch {
        // not a directory or doesn't exist — fall through to file check
    }

    // Try as .md file
    const notePath = join(vaultRoot, `${path}.md`);
    if (!existsSync(notePath)) {
        return {
            content: formatError(`Vault note not found: ${path}`, url),
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }

    const rawContent = safeRead(notePath);
    if (rawContent === null) {
        return {
            content: formatError(`Cannot read: ${notePath}`, url),
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }
    const renderedContent = resolveWikilinks(rawContent, vaultRoot);

    return {
        content: `### Rendered Note: ${path}\n\n${renderedContent}\n\n---\n*Note rendered with resolved wikilinks.*`,
        mime: "text/markdown",
        protocol: "vault",
        path,
    };
}
