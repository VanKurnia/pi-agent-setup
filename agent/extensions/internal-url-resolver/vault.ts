import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { formatError, PiUrlResult } from "./types.ts";
import { resolveVaultRoot, isInside } from "../shared/resolve-vault.ts";
import { safeReadText } from "../shared/safe-read.ts";

const MAX_WIKILINK_DEPTH = 5;

function absPathToPiUrl(vaultRoot: string, absPath: string): string {
    // Normalize both paths to forward slashes, then strip the root prefix.
    const normalizedRoot = vaultRoot.replace(/\\/g, "/");
    const normalizedPath = absPath.replace(/\\/g, "/");
    const rel = normalizedPath.startsWith(normalizedRoot)
        ? normalizedPath.slice(normalizedRoot.length)
        : normalizedPath;
    const withoutExt = rel.replace(/\.md$/i, "");
    return `pi://vault${withoutExt}`;
}

/**
 * Single bounded walk building a filename index for one resolution.
 * First match wins, preserving old depth-first order for duplicates.
 * Skips hidden dirs.
 */
function buildFilenameIndex(root: string, maxDepth: number): Map<string, string> {
    const index = new Map<string, string>();
    function walk(dir: string, depthRemaining: number): void {
        if (depthRemaining < 0) return;
        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith(".")) continue; // skip hidden
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath, depthRemaining - 1);
                } else if (entry.isFile()) {
                    const key = entry.name.toLowerCase();
                    if (!index.has(key)) index.set(key, fullPath);
                }
            }
        } catch {
            // permission denied, skip
        }
    }
    walk(root, maxDepth);
    return index;
}

function resolveWikilinks(content: string, vaultRoot: string): string {
    if (!content.includes("[[")) return content;
    const linkRegex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
    const index = buildFilenameIndex(vaultRoot, MAX_WIKILINK_DEPTH);

    return content.replace(linkRegex, (_match, rawLink, displayText) => {
        let targetPath = "";
        const baseSearch = join(vaultRoot, `${rawLink}.md`);
        if (existsSync(baseSearch)) {
            targetPath = baseSearch;
        } else {
            const found = index.get(`${rawLink}.md`.toLowerCase());
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

    const rawContent = safeReadText(notePath);
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
