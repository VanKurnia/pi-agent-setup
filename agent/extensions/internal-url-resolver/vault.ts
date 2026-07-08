import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PI_AGENT_DIR, formatError, PiUrlResult } from "./types.js";

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

export function resolveVaultUrl(path: string, _url: string): PiUrlResult {
    let vaultRoot: string | null = null;

    // Try TERMY_CONTEXT_PATH first
    const contextPath = process.env.TERMY_CONTEXT_PATH;
    if (contextPath && existsSync(contextPath)) {
        try {
            const context = JSON.parse(readFileSync(contextPath, "utf-8"));
            if (context.vaultRoot) vaultRoot = context.vaultRoot;
        } catch {
            /* ignore */
        }
    }

    // Fallback to obsidian-config.json
    if (!vaultRoot) {
        const configPath = join(PI_AGENT_DIR, "obsidian-config.json");
        if (existsSync(configPath)) {
            try {
                const config = JSON.parse(readFileSync(configPath, "utf-8"));
                vaultRoot = config.vaultPath ?? null;
            } catch {
                /* ignore */
            }
        }
    }

    if (!path) {
        return {
            content: "Error: No vault path provided",
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }
    if (!vaultRoot) {
        return {
            content: formatError("No vault root configured", `pi://vault/${path}`),
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }

    const notePath = join(vaultRoot, `${path}.md`);
    if (!existsSync(notePath)) {
        return {
            content: formatError(`Vault note not found: ${path}`, `pi://vault/${path}`),
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }

    const rawContent = safeRead(notePath);
    if (rawContent === null) {
        return {
            content: formatError(`Cannot read: ${notePath}`, `pi://vault/${path}`),
            mime: "text/markdown",
            protocol: "vault",
            path,
        };
    }
    const renderedContent = resolveWikilinks(rawContent, vaultRoot!);

    return {
        content: `### Rendered Note: ${path}\n\n${renderedContent}\n\n---\n*Note rendered with resolved wikilinks.*`,
        mime: "text/markdown",
        protocol: "vault",
        path,
    };
}
