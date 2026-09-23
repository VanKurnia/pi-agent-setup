import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { PiUrlResult, formatError } from "./types.ts";
import { resolveVaultRoot } from "../shared/resolve-vault.ts";

const execFileAsync = promisify(execFile);

async function execSafe(cmd: string, args: string[], cwd?: string): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(cmd, args, {
            encoding: "utf-8",
            timeout: 3000,
            cwd,
        });
        return stdout.trim();
    } catch {
        return null;
    }
}

// ~5s TTL cache for git probes, keyed by cwd + argv. Staleness within
// the window is accepted; beyond it is a bug.
const GIT_PROBE_TTL_MS = 5000;
const GIT_PROBE_CACHE_MAX = 50;
const gitProbeCache = new Map<string, { at: number; value: string | null }>();

async function cachedExecSafe(cmd: string, args: string[], cwd?: string): Promise<string | null> {
    const dir = cwd ?? process.cwd();
    const key = JSON.stringify([dir, cmd, ...args]);
    const now = Date.now();
    const hit = gitProbeCache.get(key);
    if (hit && now - hit.at < GIT_PROBE_TTL_MS) return hit.value;
    const value = await execSafe(cmd, args, cwd);
    if (gitProbeCache.size >= GIT_PROBE_CACHE_MAX) gitProbeCache.clear();
    gitProbeCache.set(key, { at: now, value });
    return value;
}

function readHeadBranch(dir: string): string | null {
    try {
        const head = readFileSync(join(dir, ".git", "HEAD"), "utf-8").trim();
        const m = head.match(/^ref:\s*refs\/heads\/(.+)\s*$/);
        if (m?.[1]) return m[1];
        if (/^[0-9a-f]{4,40}$/i.test(head)) return head;
        return null;
    } catch {
        return null;
    }
}

export async function getCachedGitBranch(cwd?: string): Promise<string | null> {
    const dir = cwd ?? process.cwd();
    const fileBranch = readHeadBranch(dir);
    if (fileBranch) return fileBranch;
    return cachedExecSafe("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

const BINARY_EXTS = new Set([
    ".exe",
    ".dll",
    ".so",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);

async function workspaceInfo(cwd?: string): Promise<string> {
    const vaultRoot = resolveVaultRoot();
    const dir = cwd ?? process.cwd();
    const [remote, branch] = await Promise.all([
        cachedExecSafe("git", ["config", "--get", "remote.origin.url"], dir),
        getCachedGitBranch(dir),
    ]);
    const workspaceKey = createHash("sha256")
        .update(remote || dir)
        .digest("hex")
        .slice(0, 16);

    const lines: string[] = [];
    lines.push("## Workspace");
    lines.push("");
    lines.push(`- **Directory**: \`${dir}\``);
    lines.push(`- **Branch**: ${branch ?? "unavailable"}`);
    lines.push(`- **Remote**: ${remote ?? "none"}`);
    lines.push(`- **Workspace ID**: \`${workspaceKey}\``);
    if (vaultRoot) {
        lines.push(`- **Vault**: \`${vaultRoot}\``);
    }
    return lines.join("\n");
}

async function workspaceGit(cwd?: string): Promise<string> {
    const [log, status] = await Promise.all([
        cachedExecSafe("git", ["log", "-1", "--oneline", "--decorate"], cwd),
        cachedExecSafe("git", ["status", "--porcelain"], cwd),
    ]);
    const lines: string[] = [];
    lines.push("## Git Status");
    lines.push("");
    if (log) {
        lines.push(`**HEAD**: ${log}`);
        lines.push("");
    } else {
        lines.push("Not a git repository or git unavailable.");
        lines.push("");
        return lines.join("\n");
    }
    if (status) {
        const changes = status.split("\n").filter(Boolean);
        lines.push(`**Uncommitted**: ${changes.length} file(s)`);
        lines.push("");
        for (const ch of changes.slice(0, 50)) {
            lines.push(`- \`${ch}\``);
        }
    } else {
        lines.push("**Clean working tree**");
    }
    return lines.join("\n");
}

function workspaceFiles(cwd?: string): string {
    const dir = cwd ?? process.cwd();
    const maxEntries = 100;
    const results: string[] = [];
    results.push("## Workspace Files (depth ≤ 2)");
    results.push("");

    function walk(root: string, depth: number): void {
        if (depth > 2 || results.length - 1 >= maxEntries) return;
        let entries: string[];
        try {
            entries = readdirSync(root);
        } catch {
            return;
        }
        for (const name of entries) {
            if (name.startsWith(".")) continue;
            if (results.length - 1 >= maxEntries) break;
            const full = join(root, name);
            let stats: import("node:fs").Stats;
            try {
                stats = statSync(full);
            } catch {
                continue;
            }
            const rel = full.startsWith(dir) ? full.slice(dir.length).replace(/^[/\\]/, "") : full;
            if (stats.isDirectory()) {
                if (SKIP_DIRS.has(basename(full))) continue;
                results.push(`📁 \`${rel}/\``);
                walk(full, depth + 1);
            } else if (stats.isFile()) {
                const ext = extname(name).toLowerCase();
                if (BINARY_EXTS.has(ext)) continue;
                results.push(`📄 \`${rel}\``);
            }
        }
    }

    walk(dir, 0);
    if (results.length === 1) {
        results.push("*(no files found)*");
    }
    return results.join("\n");
}

export async function resolveWorkspaceUrl(
    path: string,
    url: string,
    cwd?: string,
): Promise<PiUrlResult> {
    switch (path) {
        case "":
            return {
                content: await workspaceInfo(cwd),
                mime: "text/markdown",
                protocol: "workspace",
                path,
            };
        case "git":
            return {
                content: await workspaceGit(cwd),
                mime: "text/markdown",
                protocol: "workspace",
                path,
            };
        case "files":
            return {
                content: workspaceFiles(cwd),
                mime: "text/markdown",
                protocol: "workspace",
                path,
            };
        default:
            return {
                content: formatError(`Unknown workspace path: ${path}`, url),
                mime: "text/markdown",
                protocol: "workspace",
                path,
            };
    }
}
