import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const DEFAULT_BINARY = "codebase-memory-mcp";
const FALLBACK_BINARY_PATHS = ["~/.local/bin/codebase-memory-mcp"];

function expandHome(path: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return join(homedir(), path.slice(2));
    return path;
}

/** Windows cannot spawn a `.js`/`.mjs` file directly; run it through Node instead. */
export function spawnTarget(binary: string): { command: string; prefixArgs: string[] } {
    return /\.(mjs|cjs|js)$/i.test(binary)
        ? { command: process.execPath, prefixArgs: [binary] }
        : { command: binary, prefixArgs: [] };
}

async function existsExecutable(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function findOnPath(command: string): Promise<string | undefined> {
    const paths = process.env.PATH?.split(delimiter) ?? [];
    for (const dir of paths) {
        const candidate = join(dir, command);
        if (await existsExecutable(candidate)) return candidate;
    }
    return undefined;
}

export async function resolveCbmBinary(): Promise<string> {
    const configured = process.env.CODEBASE_MEMORY_MCP_BIN?.trim() || process.env.CBM_BIN?.trim();
    if (configured) {
        const path = expandHome(configured);
        if (await existsExecutable(path)) return path;
        throw new Error(`Configured codebase-memory-mcp binary does not exist: ${path}`);
    }

    const fromPath = await findOnPath(DEFAULT_BINARY);
    if (fromPath) return fromPath;

    for (const fallback of FALLBACK_BINARY_PATHS) {
        const path = expandHome(fallback);
        if (await existsExecutable(path)) return path;
    }

    throw new Error(
        "codebase-memory-mcp binary not found. Install it or set CODEBASE_MEMORY_MCP_BIN=/path/to/codebase-memory-mcp.",
    );
}

export type CbmVersion = { major: number; minor: number; patch: number };

let versionPromise: Promise<CbmVersion | undefined> | undefined;

export function parseCbmVersion(output: string): CbmVersion | undefined {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
    if (!match) return undefined;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function getCbmVersion(): Promise<CbmVersion | undefined> {
    versionPromise ??= (async () => {
        try {
            const binary = await resolveCbmBinary();
            const { command, prefixArgs } = spawnTarget(binary);
            const output = await new Promise<string>((resolve) => {
                const child = spawn(command, [...prefixArgs, "--version"], {
                    stdio: ["ignore", "pipe", "ignore"],
                    windowsHide: true,
                });
                let stdout = "";
                child.stdout?.on("data", (chunk: Buffer) => {
                    stdout += chunk.toString("utf8");
                });
                child.on("error", () => resolve(""));
                child.on("close", () => resolve(stdout));
            });
            return parseCbmVersion(output);
        } catch {
            return undefined;
        }
    })();
    return versionPromise;
}
