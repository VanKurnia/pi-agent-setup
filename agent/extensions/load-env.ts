/**
 * load-env: Bootstrap extension that loads ~/.pi/.env at import time,
 * BEFORE any other extension initializes. This ensures env vars like
 * PI_FFF_MODE are available when extensions read process.env during init.
 *
 * This must be listed FIRST in settings.json packages so it runs before
 * extensions like pi-fff that depend on env vars at import time.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const piConfigDir = process.env.PI_CONFIG_DIR || ".pi";
const envPath = join(homedir(), piConfigDir, ".env");

if (existsSync(envPath)) {
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      let val = trimmed.slice(index + 1).trim();
      // Strip inline comments: only outside of quotes
      // If not quoted, strip everything after first " #"
      const unquoted = !val.startsWith('"') && !val.startsWith("'");
      if (unquoted) {
        const commentIdx = val.indexOf(" #");
        if (commentIdx !== -1) val = val.slice(0, commentIdx);
      }
      // Strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      // Always set — .env is the single source of truth
      process.env[key] = val;
    }
  } catch {
    // Silent fail — .env loading is best-effort
  }
}

export default function (_pi: any) {
  // No-op extension — env loading happens at import time above
}
