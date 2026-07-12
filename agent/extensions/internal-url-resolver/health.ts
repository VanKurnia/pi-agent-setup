import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { PiUrlResult } from "./types.ts";
import { resolveVaultRoot } from "../shared/resolve-vault.ts";

export function resolveHealthUrl(_path: string, _url: string): PiUrlResult {
    const vaultRoot = resolveVaultRoot();
    const vaultOk = vaultRoot && existsSync(vaultRoot);
    let workspace = "unavailable";
    let branch = "unavailable";
    try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
            encoding: "utf-8",
            timeout: 3000,
        }).trim();
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
