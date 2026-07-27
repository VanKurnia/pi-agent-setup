import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath, sep, basename } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function resolveVaultRoot(): string | null {
    const configPath = join(getAgentDir(), "obsidian-config.json");
    if (!existsSync(configPath)) return null;
    try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        return config.vaultPath ? resolvePath(config.vaultPath) : null;
    } catch {
        return null;
    }
}

export function vaultName(root: string): string {
    return process.env.OBSIDIAN_VAULT || basename(root);
}

export function isInside(root: string, target: string): boolean {
    const r = resolvePath(root);
    const t = resolvePath(target);
    return t === r || t.startsWith(r + sep);
}
