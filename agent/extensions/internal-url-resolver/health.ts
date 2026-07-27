import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PiUrlResult } from "./types.ts";
import { resolveVaultRoot } from "../shared/resolve-vault.ts";

const execFileAsync = promisify(execFile);

export async function resolveHealthUrl(
    _path: string,
    _url: string,
    _cwd?: string,
): Promise<PiUrlResult> {
    const vaultRoot = resolveVaultRoot();
    const vaultOk = vaultRoot && existsSync(vaultRoot);
    let workspace = "unavailable";
    let branch = "unavailable";
    try {
        branch = (
            await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                encoding: "utf-8",
                timeout: 3000,
            })
        ).stdout.trim();
        workspace = process.cwd();
    } catch (e: any) {
        branch = `unavailable (${e.message?.split("\n")[0] || "unknown error"})`;
    }
    return {
        content: [
            "## Health",
            "",
            `- **Obsidian vault**: ${vaultRoot ?? "not configured"} ${vaultOk ? "✅" : "❌"}`,
            `- **Workspace**: ${workspace}`,
            `- **Branch**: ${branch}`,
        ].join("\n"),
        mime: "text/markdown",
        protocol: "health",
        path: "",
    };
}
