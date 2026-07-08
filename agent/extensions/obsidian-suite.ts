import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

interface ObsidianConfig {
    vaultPath: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "obsidian-config.json");

export default function (pi: ExtensionAPI) {
    // ── State ──────────────────────────────────────────────────────
    let vaultPath: string | null = null;
    /** Set after vault context is injected as a persistent message */
    let hasInjectedVault = false;

    // ── Helpers ────────────────────────────────────────────────────

    function loadConfig(): ObsidianConfig | null {
        if (!existsSync(CONFIG_PATH)) return null;
        try {
            return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ObsidianConfig;
        } catch {
            return null;
        }
    }

    function saveConfig(config: ObsidianConfig): void {
        const dir = dirname(CONFIG_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    }

    /** Collect vault context (~500 tokens) */
    function collectVaultContext(vp: string): string {
        const parts: string[] = [];

        // 1. Index Vault.md summary
        const indexVaultPath = join(vp, "Index Vault.md");
        if (existsSync(indexVaultPath)) {
            const content = readFileSync(indexVaultPath, "utf-8");
            parts.push(`=== Vault Index ===\n${content.slice(0, 2000)}`);
        }

        // 2. Active projects from Index Projects.md
        const idxProjectsPath = join(vp, "Projects", "Index Projects.md");
        if (existsSync(idxProjectsPath)) {
            const content = readFileSync(idxProjectsPath, "utf-8");
            parts.push(`=== Active Projects ===\n${content.slice(0, 2000)}`);
        }

        // 3. Memory reminder + token hint
        parts.push("Memory: before answering technical questions, ffgrep vault first.");
        parts.push("Vault context: ~500 tokens, injected once per session.");

        return parts.join("\n\n");
    }

    // ── session_start: reset injection flag ────────────────────────
    pi.on("session_start", async () => {
        hasInjectedVault = false;
    });

    // ── before_agent_start: inject vault context once per session ──
    pi.on("before_agent_start", async (event, ctx) => {
        if (hasInjectedVault) return;

        // 1. Detect vault path from config (no auto-prompt)
        if (!vaultPath) {
            const config = loadConfig();
            if (config?.vaultPath) {
                vaultPath = config.vaultPath;
            }
        }

        // 2. Inject as persistent message (once per session)
        if (vaultPath && existsSync(vaultPath)) {
            const vaultContext = collectVaultContext(vaultPath);
            if (vaultContext) {
                hasInjectedVault = true;
                return {
                    // Persistent message — stored in session, survives across turns
                    // LLM sees it every turn without re-injection
                    message: {
                        customType: "obsidian-vault",
                        content: `## Obsidian Vault Context\n${vaultContext}`,
                        display: false, // hidden from TUI, still sent to LLM
                    },
                };
            }
        }
    });

    // ── Command: /obsidian-status — Show vault state ─────────────
    pi.registerCommand("obsidian-status", {
        description: "Show Obsidian vault connection status and stats.",
        handler: async (_args, ctx) => {
            const vp = vaultPath ?? loadConfig()?.vaultPath;
            if (!vp || !existsSync(vp)) {
                ctx.ui.notify("No vault configured. Use `/obsidian-path` to set one.", "warning");
                return;
            }

            // Count .md files recursively
            let noteCount = 0;
            function walk(dir: string): void {
                try {
                    for (const entry of readdirSync(dir, { withFileTypes: true })) {
                        const full = join(dir, entry.name);
                        if (entry.isDirectory() && !entry.name.startsWith(".")) walk(full);
                        else if (entry.isFile() && entry.name.endsWith(".md")) noteCount++;
                    }
                } catch {
                    /* skip unreadable dirs */
                }
            }
            walk(vp);

            // Count project directories under Projects/
            const projectsDir = join(vp, "Projects");
            let projectCount = 0;
            if (existsSync(projectsDir)) {
                try {
                    projectCount = readdirSync(projectsDir, { withFileTypes: true }).filter((e) =>
                        e.isDirectory(),
                    ).length;
                } catch {
                    /* ignore */
                }
            }

            ctx.ui.notify(
                `Vault: ${vp}\nNotes: ${noteCount}\nProjects: ${projectCount}\n` +
                    `Context: injected via persistent message (~500t, once/session)\n` +
                    `ffgrep-first: active (obsidian-navigator Level 0)`,
                "info",
            );
        },
    });

    // ── Command: /obsidian-path — Set vault path ──────────────────
    pi.registerCommand("obsidian-path", {
        description: "Set Obsidian vault path. Usage: /obsidian-path <path>",
        handler: async (args, ctx) => {
            let path = args?.trim();

            if (!path) {
                const defaultPath = join(homedir(), "Documents", "Obsidian Vault");
                const answer = await ctx.ui.input("Enter vault path:", defaultPath);
                if (!answer) {
                    ctx.ui.notify("Vault path not set. Cancelled.", "warning");
                    return;
                }
                path = answer;
            }

            const resolved = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

            if (!existsSync(resolved)) {
                ctx.ui.notify(`Path does not exist: ${resolved}`, "error");
                return;
            }

            if (!existsSync(join(resolved, ".obsidian"))) {
                const confirm = await ctx.ui.confirm(
                    "Not an Obsidian vault?",
                    `${resolved} doesn't have a .obsidian/ directory. Set anyway?`,
                );
                if (!confirm) return;
            }

            vaultPath = resolved;
            // Reset flag so next turn re-injects with fresh vault context
            hasInjectedVault = false;
            saveConfig({ vaultPath: resolved });
            ctx.ui.notify(`Vault path set to: ${resolved}`, "info");
        },
    });
}
