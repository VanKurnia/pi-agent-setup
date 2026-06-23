import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const execAsync = promisify(exec);

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

      ctx.ui.setWidget("update-setup", [" Running update.sh..."]);

      let errors = 0;
      try {
        await execAsync(`"bash" "${updateScript}"`, { cwd: piDir });
      } catch (e: any) {
        errors++;
        console.error("[update-setup] update.sh failed:", e.message);
      }

      ctx.ui.setWidget("update-setup", []);

      if (errors > 0) {
        ctx.ui.notify(`⚠️  Update completed with ${errors} error(s)`, "warning");
      } else {
        ctx.ui.notify(`✅ Update completed successfully!`, "info");
      }

      ctx.ui.notify("🔄 Reloading pi...", "info");
      await ctx.reload();
    },
  });
}
