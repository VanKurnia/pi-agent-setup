import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";

const execAsync = promisify(exec);

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let _spin = 0;
function nextSpin(): string {
  return SPINNER[_spin++ % SPINNER.length];
}

function progressBar(percent: number, width = 12): string {
  const filled = Math.round((percent * width) / 100);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function findPackageJson(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.name === "package.json") results.push(fullPath);
      }
    } catch {}
  }
  walk(dir);
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("update-setup", {
    description: "Install extensions and dependencies for the .pi workspace",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const piDir = join(homedir(), ".pi");
      const extDir = join(piDir, "extensions");
      let errors = 0;

      // Count total work
      const extNames: string[] = [];
      if (existsSync(extDir)) {
        for (const e of readdirSync(extDir, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          extNames.push(e.name);
        }
      }
      const pkgPaths = findPackageJson(piDir);
      const total = extNames.length + pkgPaths.length;
      let done = 0;

      function showProgress(label: string) {
        const pct = total > 0 ? Math.min(100, Math.round((done * 100) / total)) : 0;
        ctx.ui.setWidget("update-setup", [
          ` ${nextSpin()}  ${progressBar(pct)}  ${pct}%`,
          `     ${label}`,
        ]);
      }

      showProgress("Starting...");

      // Phase 1: Register extensions
      for (const name of extNames) {
        showProgress(`Installing ${name}...`);
        try {
          await execAsync(`pi install "${join(extDir, name)}"`);
        } catch {
          errors++;
        }
        done++;
      }

      // Phase 2: NPM install
      for (const pkgPath of pkgPaths) {
        const dir = pkgPath.replace(/\\/g, "/").replace(/\/package\.json$/, "");
        const name = basename(dir) || dir;
        showProgress(`npm install: ${name}...`);
        try {
          const npmCmd = process.platform === "win32"
            ? `cd /d "${dir}" && npm install --no-audit --no-fund`
            : `cd "${dir}" && npm install --no-audit --no-fund`;
          const shellOpt = process.platform === "win32" ? "cmd.exe" : undefined;
          await execAsync(npmCmd, { shell: shellOpt });
        } catch {}
        done++;
      }

      ctx.ui.setWidget("update-setup", []);

      if (errors > 0) {
        ctx.ui.notify(`⚠️  Update completed with ${errors} error(s)`, "warning");
      } else {
        ctx.ui.notify(`✅ Update completed successfully!`, "success");
      }

      ctx.ui.notify("🔄 Reloading pi...", "info");
      await ctx.reload();
    },
  });
}
