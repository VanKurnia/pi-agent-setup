import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

interface ObsidianConfig {
    vaultPath: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "obsidian-config.json");

export default function (pi: ExtensionAPI) {
    // ── State ──────────────────────────────────────────────────────
    let vaultPath: string | null = null;

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

    /** Auto-detect vault path from TERMY_CONTEXT_PATH env var */
    function detectVaultFromTermy(): string | null {
        const termyPath = process.env.TERMY_CONTEXT_PATH;
        if (!termyPath || !existsSync(termyPath)) return null;
        try {
            const context = JSON.parse(readFileSync(termyPath, "utf-8"));
            return context.vaultRoot || null;
        } catch {
            return null;
        }
    }

    /** Collect vault context for system prompt injection (max ~500 tokens) */
    function collectVaultContext(vp: string): string {
        const parts: string[] = [];

        // 1. Index Vault.md summary
        const indexVaultPath = join(vp, "Index Vault.md");
        if (existsSync(indexVaultPath)) {
            const content = readFileSync(indexVaultPath, "utf-8");
            parts.push(`=== Vault Index ===\n${content.slice(0, 300)}`);
        }

        // 2. Recent log entries (last 5)
        const logPath = join(vp, ".log", "log.md");
        if (existsSync(logPath)) {
            const log = readFileSync(logPath, "utf-8");
            const entries = log
                .split(/\n#+/)
                .filter((e) => e.trim().length > 0)
                .slice(-5);
            if (entries.length > 0) {
                parts.push("=== Recent Session Log ===");
                parts.push(...entries.map((e) => `- ${e.trim().split("\n")[0]}`));
            }
        }

        // 3. Active projects (any folder under Projects/ with an Index)
        const projectsDir = join(vp, "Projects");
        if (existsSync(projectsDir)) {
            const projects = readdirSync(projectsDir).filter(
                (d) =>
                    statSync(join(projectsDir, d)).isDirectory() &&
                    existsSync(join(projectsDir, d, `Index ${d.split(" - ")[0]}.md`)),
            );
            if (projects.length > 0) {
                parts.push("=== Active Projects ===");
                projects.forEach((p) => {
                    const indexFile = join(projectsDir, p, `Index ${p.split(" - ")[0]}.md`);
                    const indexContent = existsSync(indexFile)
                        ? readFileSync(indexFile, "utf-8")
                        : "";
                    // Only extract first line after title
                    const lines = indexContent
                        .split("\n")
                        .filter((l) => l.trim().length > 0 && !l.startsWith("#"));
                    const summary =
                        lines.length > 0 ? lines[0].trim().slice(0, 100) : "(no summary)";
                    parts.push(`- ${p} — ${summary}`);
                });
            }
        }

        return parts.join("\n\n");
    }

    // ── Event: before_agent_start — Inject vault context ─────────
    pi.on("before_agent_start", async (event, ctx) => {
        // 1. Try detect vault path: config > Termy env var > ask user
        if (!vaultPath) {
            const config = loadConfig();
            if (config?.vaultPath) {
                vaultPath = config.vaultPath;
            } else {
                const termyPath = detectVaultFromTermy();
                if (termyPath) {
                    vaultPath = termyPath;
                    saveConfig({ vaultPath });
                    ctx.ui.notify("Vault detected from Termy context", "info");
                } else if (ctx.hasUI) {
                    // Ask user for vault path
                    const answer = await ctx.ui.input(
                        "Set Obsidian vault path?",
                        join(homedir(), "Documents", "Obsidian Vault"),
                    );
                    if (answer && existsSync(answer)) {
                        vaultPath = answer;
                        saveConfig({ vaultPath });
                        ctx.ui.notify(`Vault set to: ${vaultPath}`, "info");
                    }
                }
            }
        }

        // 2. If vault path known, inject context
        if (vaultPath && existsSync(vaultPath)) {
            const vaultContext = collectVaultContext(vaultPath);
            if (vaultContext) {
                return {
                    systemPrompt:
                        event.systemPrompt + `\n\n## Obsidian Vault Context\n${vaultContext}`,
                };
            }
        }
    });

    // ── Command: /obsidian-path — Set vault path ──────────────────
    pi.registerCommand("obsidian-path", {
        description: "Set Obsidian vault path. Usage: /obsidian-path <path>",
        handler: async (args, ctx) => {
            let path = args?.trim();

            if (!path) {
                // No argument — ask interactively with detected default
                const termyPath = detectVaultFromTermy();
                const defaultPath = termyPath || join(homedir(), "Documents", "Obsidian Vault");
                const answer = await ctx.ui.input("Enter vault path:", defaultPath);
                if (!answer) {
                    ctx.ui.notify("Vault path not set. Cancelled.", "warning");
                    return;
                }
                path = answer;
            }

            // Resolve and validate
            const resolved = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

            if (!existsSync(resolved)) {
                ctx.ui.notify(`Path does not exist: ${resolved}`, "error");
                return;
            }

            // Check it looks like an Obsidian vault (has .obsidian/ dir)
            if (!existsSync(join(resolved, ".obsidian"))) {
                const confirm = await ctx.ui.confirm(
                    "Not an Obsidian vault?",
                    `${resolved} doesn't have a .obsidian/ directory. Set anyway?`,
                );
                if (!confirm) return;
            }

            vaultPath = resolved;
            saveConfig(ctx.cwd, { vaultPath: resolved });
            ctx.ui.notify(`Vault path set to: ${resolved}`, "success");
        },
    });

    // ── Command: /obsidian-sync — Update log from session ─────────
    pi.registerCommand("obsidian-sync", {
        description: "Sync session to vault log. Usage: /obsidian-sync [message]",
        handler: async (args, ctx) => {
            if (!vaultPath) {
                ctx.ui.notify("Vault path not set. Use /obsidian-path first.", "error");
                return;
            }

            const logDir = join(vaultPath, ".log");
            if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

            const logFile = join(logDir, "log.md");
            const timestamp = new Date().toISOString().slice(0, 10);
            const message = args?.trim() || "(no message)";
            const entry = `\n---\n## [${timestamp}] ${message}\n`;

            writeFileSync(logFile, entry, { flag: "a" });
            ctx.ui.notify(`Logged: ${message}`, "success");
        },
    });
}
