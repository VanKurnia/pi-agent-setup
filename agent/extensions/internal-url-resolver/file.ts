import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { formatError, PiUrlResult } from "./types.ts";
import { isInside } from "../shared/resolve-vault.ts";

// 512KB read cap (524288 bytes) to avoid unbounded reads on message-hot paths.
const MAX_FILE_BYTES = 512 * 1024;

export function resolveFileUrl(path: string, url: string, cwd?: string): PiUrlResult {
    const dir = cwd ?? process.cwd();
    if (!path) {
        return {
            content: formatError("File path is required. Usage: pi://file/<relative-path>", url),
            mime: "text/markdown",
            protocol: "file",
            path,
        };
    }

    const fullPath = resolvePath(dir, path);

    if (!isInside(dir, fullPath)) {
        return {
            content: formatError(`Path traversal rejected: ${path}`, url),
            mime: "text/markdown",
            protocol: "file",
            path,
        };
    }

    let fileSize = 0;
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
        fileSize = stats.size;
    } catch {
        return {
            content: formatError(`File not found: ${path}`, url),
            mime: "text/markdown",
            protocol: "file",
            path,
        };
    }

    let content: string;
    let truncated = false;
    try {
        if (fileSize > MAX_FILE_BYTES) {
            const fd = openSync(fullPath, "r");
            try {
                const buf = Buffer.alloc(MAX_FILE_BYTES);
                const bytesRead = readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
                content = buf.subarray(0, bytesRead).toString("utf-8");
            } finally {
                try {
                    closeSync(fd);
                } catch {
                    // Ignore close errors; read result stands.
                }
            }
            truncated = true;
        } else {
            content = readFileSync(fullPath, "utf-8");
        }
    } catch {
        return {
            content: formatError(`Cannot read: ${path}`, url),
            mime: "text/markdown",
            protocol: "file",
            path,
        };
    }
    if (truncated) {
        content += `\n\n[truncated to 512KB (${MAX_FILE_BYTES} bytes) — file is ${fileSize} bytes; showing first ${MAX_FILE_BYTES} bytes]`;
    }
    const isMarkdown = path.endsWith(".md");
    return {
        content,
        mime: isMarkdown ? "text/markdown" : "text/plain",
        protocol: "file",
        path,
    };
}
