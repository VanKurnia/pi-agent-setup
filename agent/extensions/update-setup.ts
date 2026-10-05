import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerExtensionApi } from "./shared/cross-extension-api.js";
import { stripAnsi } from "./shared/strip-ansi.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Known bash locations on Windows — Git Bash paths first to avoid WSL bash
const BASH_CANDIDATES = [
    join("C:", "Program Files", "Git", "bin", "bash.exe"),
    join("C:", "Program Files (x86)", "Git", "bin", "bash.exe"),
    "bash",
    "/usr/bin/bash",
];

// .script/update.sh does the whole update (fresh clone + installs);
// this extension only finds bash, runs it, and renders the output.
const SCRIPT_ABS = (piDir: string) => join(piDir, ".script", "update.sh");
const piDir = () => join(homedir(), process.env.PI_CONFIG_DIR || ".pi");

function findBash(): string | null {
    // 1. Try pi's configured shellPath from settings.json first
    const settingsPath = resolve(piDir(), "agent", "settings.json");
    try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (settings.shellPath && existsSync(settings.shellPath)) {
            return settings.shellPath;
        }
    } catch {
        /* settings may not exist */
    }

    // 2. Fallback to hardcoded candidates
    for (const candidate of BASH_CANDIDATES) {
        try {
            const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
            if (result.status === 0) return candidate;
        } catch {
            // Try next candidate
        }
    }
    return null;
}

// Shared preflight for both surfaces: locate checkout, script, and bash.
function prepare(): { dir: string; bash: string } | { error: string } {
    const dir = piDir();
    const script = SCRIPT_ABS(dir);
    if (!existsSync(script)) return { error: `.script/update.sh not found at ${script}` };
    const bash = findBash();
    if (!bash) return { error: "Could not find bash (tried PATH, Git Bash)" };
    return { dir, bash };
}

// Run .script/update.sh once; stream every output line to onData.
// Stderr lines arrive pre-indented by feed; consumers treat all lines alike.
function runScript(
    bashExe: string,
    dir: string,
    onData: (line: string) => void,
): Promise<number | null> {
    return new Promise((resolvePromise) => {
        let resolved = false;
        const done = (code: number | null) => {
            if (!resolved) {
                resolved = true;
                resolvePromise(code);
            }
        };
        const feed = (raw: string, isStderr: boolean) => {
            for (const line of stripAnsi(raw).split("\n")) {
                const trimmed = line.trim();
                if (trimmed) onData(isStderr ? `  ${trimmed}` : trimmed);
            }
        };
        const child = spawn(bashExe, [SCRIPT_ABS(dir), dir], { cwd: dir, windowsHide: true });
        child.stdout?.on("data", (d: Buffer) => feed(d.toString(), false));
        child.stderr?.on("data", (d: Buffer) => feed(d.toString(), true));
        child.on("error", (e: Error) => {
            onData(`Failed to start: ${e.message}`);
            done(-1);
        });
        // Resolve on close (not exit): exit fires before stdio drains,
        // which could drop trailing lines and race ctx.reload().
        child.on("close", done);
    });
}

async function runUpdate(): Promise<string> {
    const ready = prepare();
    if ("error" in ready) return ready.error;
    const { dir, bash: bashExe } = ready;

    const lines: string[] = ["Running .script/update.sh..."];
    const exitCode = await runScript(bashExe, dir, (line) => lines.push(line));
    if (exitCode === null) lines.push("Script terminated by signal");
    else if (exitCode !== 0) lines.push(`Script exited with code ${exitCode}`);
    else lines.push("Update completed successfully");
    return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
    registerExtensionApi("update-setup", { runUpdate });
    pi.registerCommand("update-setup", {
        description: "Fresh-clone update of the .pi workspace (.script/update.sh)",
        async handler(_args: string, ctx: ExtensionCommandContext) {
            const ready = prepare();
            if ("error" in ready) {
                ctx.ui.notify(ready.error, "error");
                return;
            }
            const { dir, bash: bashExe } = ready;

            // Show the last N meaningful lines as a "rolling window"
            const MAX_VISIBLE_LINES = 16;
            const WIDGET_ID = "update-setup-output";
            const allLines: string[] = ["⚙️  Starting workspace update..."];
            let lastKey: string | null = null;
            const updateWidget = () => {
                const visible = allLines.slice(Math.max(0, allLines.length - MAX_VISIBLE_LINES));
                const key = visible.join("\n");
                if (key !== lastKey) {
                    lastKey = key;
                    ctx.ui.setWidget(WIDGET_ID, visible);
                }
            };
            updateWidget();

            const exitCode = await runScript(bashExe, dir, (line) => {
                allLines.push(line);
                updateWidget();
            });

            allLines.push("");
            if (exitCode === null) allLines.push("⚠️  Script was terminated by a signal");
            else if (exitCode !== 0)
                allLines.push(`⚠️  Update script exited with code ${exitCode}`);
            else allLines.push("✅ Update script completed successfully");
            updateWidget();

            if (exitCode !== 0) {
                ctx.ui.notify(`⚠️  Update completed with exit code ${exitCode}`, "warning");
            } else {
                ctx.ui.notify("✅ Update completed successfully", "info");
                if (!existsSync(join(dir, ".env"))) {
                    allLines.push("⚠️  .env not found — copy .env.example to .env and edit it");
                    updateWidget();
                }
                if (!existsSync(join(dir, "agent", "auth.json"))) {
                    allLines.push("⚠️  No auth.json found — run /login inside pi to authenticate");
                    updateWidget();
                }
            }

            ctx.ui.notify("🔄 Reloading pi...", "info");
            await ctx.reload();
        },
    });
}
