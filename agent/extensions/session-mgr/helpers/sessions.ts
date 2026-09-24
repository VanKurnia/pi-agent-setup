/**
 * Shared session-file primitives for session-mgr commands.
 *
 * Session files are JSONL: line 1 is the SessionHeader, the rest are entries.
 * Helpers here read only what they need (chunked head reads) instead of
 * loading whole files — session files can be large.
 */

import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";

/** Read the first chunk of a file without loading the whole file. */
export function readFileHead(filePath: string, size = 8192): string | undefined {
    let fd = -1;
    try {
        fd = openSync(filePath, "r");
        const buf = Buffer.alloc(size);
        const bytes = readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, bytes).toString("utf-8");
    } catch {
        return undefined;
    } finally {
        if (fd !== -1) closeSync(fd);
    }
}

/** Parse a candidate header line. Requires id, cwd, and timestamp. */
export function parseSessionHeader(line: string | undefined): SessionHeader | undefined {
    if (!line) return undefined;
    try {
        const header = JSON.parse(line) as Record<string, unknown>;
        if (
            header["type"] !== "session" ||
            typeof header["id"] !== "string" ||
            typeof header["cwd"] !== "string" ||
            typeof header["timestamp"] !== "string"
        )
            return undefined;
        return header as unknown as SessionHeader;
    } catch {
        return undefined;
    }
}

/** Read the cwd from a session file's header without loading the whole file. */
export function readSessionCwd(filePath: string): string | undefined {
    const head = readFileHead(filePath, 2048);
    return parseSessionHeader(head?.split("\n")[0])?.cwd;
}

/** Encode an ISO timestamp for a session filename, matching pi's own format. */
export function fileStamp(iso: string): string {
    return iso.replace(/[:.]/g, "-");
}

/** Newest-first *.jsonl listing. Empty array when the dir is unreadable. */
export function listSessionFiles(dir: string): string[] {
    try {
        return readdirSync(dir)
            .filter((f) => f.endsWith(".jsonl"))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

/**
 * Pi's session folder for a cwd. The encoding is lossy, so never decode a
 * folder name back into a cwd — read SessionHeader.cwd instead.
 */
export function sessionFolder(agentDir: string, cwd: string): string {
    const resolved = resolve(cwd);
    const folder = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(agentDir, "sessions", folder);
}
