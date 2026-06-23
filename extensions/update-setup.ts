import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Known bash locations on Windows — Git Bash paths first to avoid WSL bash
const BASH_CANDIDATES = [
  join("C:", "Program Files", "Git", "bin", "bash.exe"),
  join("C:", "Program Files (x86)", "Git", "bin", "bash.exe"),
  "bash",
  "/usr/bin/bash",
];

function findBash(): string | null {
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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("update-setup", {
    description: "Install extensions and dependencies for the .pi workspace",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const piDir = join(homedir(), ".pi");
      const updateScript = join(piDir, "update.sh");

      if (!existsSync(updateScript)) {
        ctx.ui.notify(`update.sh not found at ${updateScript}`, "error");
        return;
      }

      const bashExe = findBash();
      if (!bashExe) {
        ctx.ui.notify("Could not find bash (tried PATH, Git Bash)", "error");
        return;
      }

      // Show the last N meaningful lines as a "rolling window"
      const MAX_VISIBLE_LINES = 16;
      const allLines: string[] = [];
      const WIDGET_ID = "update-setup-output";
      let lastScreen: string[] | null = null;

      // Strip ANSI escape codes
      const stripAnsi = (str: string) =>
        str.replace(/[\u001b\u009b][[()#;?]*.?[0-9]*[a-zA-Z]/g, "");

      const updateWidget = () => {
        // Take the last MAX_VISIBLE_LINES
        const start = Math.max(0, allLines.length - MAX_VISIBLE_LINES);
        const visible = allLines.slice(start);
        // Only call setWidget if the visible portion actually changed
        const key = visible.join("\n");
        if (key !== lastScreen?.join("\n")) {
          lastScreen = visible;
          ctx.ui.setWidget(WIDGET_ID, visible);
        }
      };

      ctx.ui.setWidget(WIDGET_ID, ["⚙️  Starting workspace update..."]);

      const processChunk = (raw: string) => {
        try {
          const cleaned = stripAnsi(raw);
          const lines = cleaned.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) allLines.push(trimmed);
          }
          updateWidget();
        } catch (e: any) {
          allLines.push(`[parse error: ${e.message}]`);
          updateWidget();
        }
      };

      // Run bash from piDir with just the filename
      const child = spawn(bashExe, ["update.sh"], {
        cwd: piDir,
        windowsHide: true,
      });

      child.stdout!.on("data", (data: Buffer) => {
        processChunk(data.toString());
      });

      child.stderr!.on("data", (data: Buffer) => {
        try {
          const cleaned = stripAnsi(data.toString());
          const lines = cleaned.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) allLines.push(`  ${trimmed}`);
          }
          updateWidget();
        } catch {
          // ignore
        }
      });

      const exitCode: number | null = await new Promise((resolve) => {
        let resolved = false;
        child.on("error", (err: Error) => {
          allLines.push(`Failed to start: ${err.message}`);
          updateWidget();
          if (!resolved) { resolved = true; resolve(-1); }
        });
        child.on("exit", (code) => {
          if (!resolved) { resolved = true; resolve(code); }
        });
        child.on("close", (code) => {
          if (!resolved) { resolved = true; resolve(code); }
        });
      });

      // Append final status
      allLines.push("");
      if (exitCode === null) {
        allLines.push("⚠️  Script was terminated by a signal");
      } else if (exitCode !== 0) {
        allLines.push(`⚠️  Update script exited with code ${exitCode}`);
      } else {
        allLines.push("✅ Update script completed successfully");
      }
      updateWidget();

      if (exitCode !== 0) {
        ctx.ui.notify(`⚠️  Update completed with exit code ${exitCode}`, "warning");
      } else {
        ctx.ui.notify("✅ Update completed successfully", "info");
      }

      ctx.ui.notify("🔄 Reloading pi...", "info");
      await ctx.reload();
    },
  });
}
