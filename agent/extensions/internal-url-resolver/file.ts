import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { formatError, PiUrlResult } from "./types.ts";

function isInside(root: string, target: string): boolean {
    const r = resolvePath(root);
    const t = resolvePath(target);
    return t === r || t.startsWith(r + sep);
}

export function resolveFileUrl(path: string, url: string): PiUrlResult {
    const cwd = process.cwd();
    if (!path) {
        return {
            content: formatError("File path is required. Usage: pi://file/<relative-path>", url),
            mime: "text/markdown",
            protocol: "file",
            path,
        };
    }

    const fullPath = resolvePath(cwd, path);

    if (!isInside(cwd, fullPath)) {
        return {
            content: formatError(`Path traversal rejected: ${path}`, url),
            mime: "text/markdown",
            protocol: "file",
            path,
        };
    }

    try {
        const stats = statSync(fullPath);
        if (!stats.isFile()) {
            return {
                content: formatError(`Not a file: ${path}`, url),
                mime: "text/markdown",
                protocol: "file",
                path,
            };
        }
    } catch {
        return {
            content: formatError(`File not found: ${path}`, url),
            mime: "text/markdown",
            protocol: "file",
            path,
        };
    }

    const content = readFileSync(fullPath, "utf-8");
    const isMarkdown = path.endsWith(".md");
    return {
        content,
        mime: isMarkdown ? "text/markdown" : "text/plain",
        protocol: "file",
        path,
    };
}
