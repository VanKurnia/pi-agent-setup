import { readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath, sep, basename } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let _cachedVault: { root: string | null; mtimeMs: number } | null = null;

export function resolveVaultRoot(): string | null {
    let configPath: string;
    try {
        configPath = join(getAgentDir(), "obsidian-config.json");
    } catch {
        return null;
    }
    let mtimeMs: number;
    try {
        mtimeMs = statSync(configPath).mtimeMs;
    } catch {
        _cachedVault = { root: null, mtimeMs: 0 };
        return null;
    }
    if (_cachedVault && _cachedVault.mtimeMs === mtimeMs) {
        return _cachedVault.root;
    }
    try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        const root = config.vaultPath ? resolvePath(config.vaultPath) : null;
        _cachedVault = { root, mtimeMs };
        return root;
    } catch {
        _cachedVault = { root: null, mtimeMs };
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
