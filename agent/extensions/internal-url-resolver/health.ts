import { existsSync } from "node:fs";
import { PiUrlResult } from "./types.ts";
import { resolveVaultRoot } from "../shared/resolve-vault.ts";
// Shares workspace.ts git cache (no import cycle: workspace.ts does not import health.ts).
import { getCachedGitBranch } from "./workspace.ts";

export async function resolveHealthUrl(
    _path: string,
    _url: string,
    _cwd?: string,
): Promise<PiUrlResult> {
    const vaultRoot = resolveVaultRoot();
    const vaultOk = vaultRoot && existsSync(vaultRoot);
    const workspace = _cwd ?? process.cwd();
    let branch = "unavailable";
    try {
        // Reads .git/HEAD first, then falls back to the shared ~5s TTL
        // cached `git rev-parse` (same helper workspace.ts uses).
        branch = (await getCachedGitBranch(workspace)) ?? "unavailable";
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        branch = `unavailable (${msg.split("\n")[0] || "unknown error"})`;
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
