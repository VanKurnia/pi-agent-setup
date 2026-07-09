import { readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PiUrlResult, formatError } from "./types.ts";
import { resolveVaultRoot } from "../shared/resolve-vault.ts";

function execSafe(cmd: string): string | null {
    try {
        return execSync(cmd, { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
        return null;
    }
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

function workspaceInfo(): string {
    const vaultRoot = resolveVaultRoot();
    const cwd = process.cwd();
    const remote = execSafe("git config --get remote.origin.url");
    const branch = execSafe("git rev-parse --abbrev-ref HEAD");
    const workspaceKey = createHash("sha256")
        .update(remote || cwd)
        .digest("hex")
        .slice(0, 16);

    const lines: string[] = [];
    lines.push("## Workspace");
    lines.push("");
    lines.push(`- **Directory**: \`${cwd}\``);
    lines.push(`- **Branch**: ${branch ?? "unavailable"}`);
    lines.push(`- **Remote**: ${remote ?? "none"}`);
    lines.push(`- **Workspace ID**: \`${workspaceKey}\``);
    if (vaultRoot) {
        lines.push(`- **Vault**: \`${vaultRoot}\``);
    }
    return lines.join("\n");
}

function workspaceGit(): string {
    const log = execSafe("git log -1 --oneline --decorate");
    const status = execSafe("git status --porcelain");
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

function workspaceFiles(): string {
    const cwd = process.cwd();
    const maxEntries = 100;
    const results: string[] = [];
    results.push("## Workspace Files (depth ≤ 2)");
    results.push("");

    function walk(dir: string, depth: number): void {
        if (depth > 2 || results.length - 1 >= maxEntries) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            if (name.startsWith(".")) continue;
            if (results.length - 1 >= maxEntries) break;
            const full = join(dir, name);
            let stats: import("node:fs").Stats;
            try {
                stats = statSync(full);
            } catch {
                continue;
            }
            const rel = full.startsWith(cwd) ? full.slice(cwd.length).replace(/^[/\\]/, "") : full;
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

    walk(cwd, 0);
    if (results.length === 1) {
        results.push("*(no files found)*");
    }
    return results.join("\n");
}

export function resolveWorkspaceUrl(path: string, url: string): PiUrlResult {
    switch (path) {
        case "":
            return { content: workspaceInfo(), mime: "text/markdown", protocol: "workspace", path };
        case "git":
            return { content: workspaceGit(), mime: "text/markdown", protocol: "workspace", path };
        case "files":
            return {
                content: workspaceFiles(),
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
