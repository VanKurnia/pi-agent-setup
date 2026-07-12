import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveVaultRoot, isInside } from "../shared/resolve-vault.ts";

export function agentMemoryRoot(): string | null {
    const vaultRoot = resolveVaultRoot();
    if (!vaultRoot) return null;
    return join(vaultRoot, "_agent", "memory");
}

export function memoryUrl(scope: string, project?: string): string {
    if (scope === "global") return "pi://vault/_agent/memory/global";
    if (scope === "project" && project) return `pi://vault/_agent/memory/${project}`;
    return "pi://vault/_agent/memory";
}

export function scopeToFilePath(scope: "global" | "project", project?: string): string | null {
    const root = agentMemoryRoot();
    if (!root) return null;
    if (scope === "global") return join(root, "global.md");
    if (scope === "project") {
        if (!project || !/^[a-zA-Z0-9_-]+$/.test(project)) return null;
        const target = join(root, `${project}.md`);
        if (!isInside(root, target)) return null;
        return target;
    }
    return null;
}

let cliBinary: string | null = null;

export function findCliBinary(): string | null {
    if (cliBinary !== null) return cliBinary;
    if (process.env.OBSIDIAN_CLI_BINARY && existsSync(process.env.OBSIDIAN_CLI_BINARY))
        return process.env.OBSIDIAN_CLI_BINARY;
    const pathEnv = process.env.PATH || "";
    for (const dir of pathEnv.split(";").filter(Boolean)) {
        for (const name of ["obsidian.com", "Obsidian.com", "obsidian", "Obsidian.exe"]) {
            if (existsSync(join(dir, name))) {
                if (name === "Obsidian.exe") {
                    const c = join(dir, "Obsidian.com");
                    if (existsSync(c)) {
                        cliBinary = c;
                        return c;
                    }
                }
                cliBinary = join(dir, name);
                return cliBinary;
            }
        }
    }
    const f = "C:\\Program Files\\Obsidian\\Obsidian.com";
    if (existsSync(f)) {
        cliBinary = f;
        return f;
    }
    cliBinary = null;
    return null;
}

export function formatEntry(content: string, project?: string, tags?: string[]): string {
    const ts = new Date().toISOString();
    const lines: string[] = [`## ${ts}`, ""];
    if (project) lines.push(`[project: ${project}]`);
    lines.push(content);
    if (tags && tags.length > 0) lines.push(`tags: ${tags.map((t) => `#${t}`).join(" ")}`);
    lines.push("", "---", "");
    return lines.join("\n");
}

export function appendMemoryEntry(
    filePath: string,
    content: string,
    project?: string,
    tags?: string[],
): boolean {
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        if (!existsSync(filePath)) writeFileSync(filePath, "# Agent Memory\n\n", "utf-8");
        appendFileSync(filePath, formatEntry(content, project, tags), "utf-8");
        return true;
    } catch {
        return false;
    }
}

export function fsGrep(filePath: string, query: string, limit: number): string[] {
    try {
        if (!existsSync(filePath)) return [];
        return readFileSync(filePath, "utf-8")
            .split(/\n---\n/)
            .filter(Boolean)
            .filter((e) => e.toLowerCase().includes(query.toLowerCase()))
            .slice(0, limit)
            .map((e) => e.trim());
    } catch {
        return [];
    }
}

export function readLatestEntries(filePath: string, limit: number): string[] {
    try {
        if (!existsSync(filePath)) return [];
        return readFileSync(filePath, "utf-8")
            .split(/\n---\n/)
            .map((e) => e.trim())
            .filter(Boolean)
            .slice(-limit)
            .reverse();
    } catch {
        return [];
    }
}
