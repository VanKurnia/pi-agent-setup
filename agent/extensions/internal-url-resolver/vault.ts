import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { formatError, PiUrlResult } from "./types.ts";
import { resolveVaultRoot, isInside } from "../shared/resolve-vault.ts";

function safeRead(path: string): string | null {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

const VECTORS = ["Projects", "Scratchpad", "Ideas"];

function resolveWikilinks(content: string, vaultRoot: string): string {
    const linkRegex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

    return content.replace(linkRegex, (_match, rawLink, displayText) => {
        let targetPath = "";
        const baseSearch = join(vaultRoot, `${rawLink}.md`);
        if (existsSync(baseSearch)) {
            targetPath = baseSearch;
        } else {
            // naive search in top-level known vectors
            for (const vec of VECTORS) {
                const p = join(vaultRoot, vec, `${rawLink}.md`);
                if (existsSync(p)) {
                    targetPath = p;
                    break;
                }
            }
        }

        return `[${displayText || rawLink}](${targetPath ? `file:///${targetPath.replace(/\\/g, "/")}` : "#"})`;
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

export function resolveVaultUrl(path: string, url: string): PiUrlResult {
    const vaultRoot = resolveVaultRoot();

    if (!vaultRoot) {
        return {
            content: formatError("No vault root configured", url),
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }

    // Guard: reject traversal outside vault root
    const resolvedTarget = resolvePath(vaultRoot, path || "");
    if (!isInside(vaultRoot, resolvedTarget)) {
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
    const fullPath = resolvePath(vaultRoot, path);
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
