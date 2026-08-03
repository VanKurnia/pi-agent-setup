/**
 * Boot Audit Extension for Pi Agent
 *
 * Records Pi startup metrics to ~/.pi/agent/boot-audit.json on every session
 * boot, for auditing and performance tracking.
 *
 * Two capture layers:
 *  1. Always-on: total boot duration (module import -> session_start),
 *     memory usage, node version, platform, cwd.
 *  2. Optional: per-extension load times, when PI_TIMING=1 is set in the
 *     shell environment before pi launches. This extension hooks console.error
 *     at import time and intercepts the "Startup Timings: extensions" block
 *     that pi emits at the end of boot, parsing each extension's import +
 *     factory durations without touching pi core code.
 *
 * Usage:
 *   /boot-audit              -> show recent audit entries
 *   PI_TIMING=1 pi          -> also record per-extension load times
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Captured as early as this module is imported (2nd in packages list,
// right after load-env.ts).
const highResStartTime = performance.now();

export interface ExtLoadTime {
  path: string;
  importMs: number;
  factoryMs: number;
  totalMs: number;
}

export interface BootAuditEntry {
  id: string;
  timestamp: string;
  bootDurationMs: number;
  memoryUsageMb: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
  };
  nodeVersion: string;
  platform: string;
  cwd: string;
  /** Present only when PI_TIMING=1 was enabled for this boot. */
  extensionLoadTimes?: ExtLoadTime[];
  totalExtensionLoadMs?: number;
}

function getAuditFilePath(): string {
  const piConfigDir = process.env.PI_CONFIG_DIR || ".pi";
  return join(homedir(), piConfigDir, "agent", "boot-audit.json");
}

function readAuditEntry(filePath: string): BootAuditEntry | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as BootAuditEntry) : null;
  } catch {
    return null;
  }
}

function saveAuditLogs(filePath: string, entry: BootAuditEntry): void {
  try {
    writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
  } catch (err) {
    console.error("[boot-audit] Failed to write audit log:", err);
  }
}

// ---------------------------------------------------------------------------
// Per-extension timing capture (optional, needs PI_TIMING=1 in env at launch)
// ---------------------------------------------------------------------------

/**
 * Parse a "Startup Timings: extensions" block from console.error into a list
 * of per-extension load times. Each line looks like:
 *   <path> module import: <ms>ms
 *   <path> factory: <ms>ms
 */
function parseExtensionTimings(block: string): ExtLoadTime[] {
  const byPath = new Map<string, { importMs: number; factoryMs: number }>();
  const lineRe = /^(.*?)\s+(module import|factory):\s*(\d+)ms$/;
  for (const line of block.split("\n")) {
    const m = lineRe.exec(line.trim());
    if (!m) continue;
    const [, path, phase, ms] = m;
    const cur = byPath.get(path) ?? { importMs: 0, factoryMs: 0 };
    if (phase === "module import") cur.importMs = Number(ms);
    else cur.factoryMs = Number(ms);
    byPath.set(path, cur);
  }
  return [...byPath.entries()]
    .map(([path, t]) => ({
      path,
      importMs: t.importMs,
      factoryMs: t.factoryMs,
      totalMs: t.importMs + t.factoryMs,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

// Only intercept timing output if PI_TIMING was enabled before we loaded.
// (timings.js captures ENABLED at pi main.js import time, before extensions,
//  so we must set PI_TIMING=1 in the shell environment, not from here.)
let timingBlockBuffer = "";
let sawExtensionsHeader = false;

const originalError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  // Forward everything first so pi's own logging is unaffected.
  originalError(...args);
  try {
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      if (arg.includes("Startup Timings: extensions")) {
        sawExtensionsHeader = true;
        timingBlockBuffer = "";
        continue;
      }
      if (sawExtensionsHeader) {
        const isSectionEnd =
          arg.trim().startsWith("---") && arg.trim().endsWith("---");
        if (isSectionEnd || arg.includes("Startup Timings: main")) {
          sawExtensionsHeader = false;
          continue;
        }
        if (arg.includes("TOTAL:")) continue;
        timingBlockBuffer += arg + "\n";
      }
    }
  } catch {
    // Never let the hook break pi's console output
  }
};

export default function bootAuditExtension(pi: any) {
  pi.on("session_start", (_event: any, ctx: any) => {
    const sessionStartTime = Date.now();
    const durationMs = Math.round(performance.now() - highResStartTime);
    const mem = process.memoryUsage();

    const entry: BootAuditEntry = {
      id: Math.random().toString(36).substring(2, 10),
      timestamp: new Date(sessionStartTime).toISOString(),
      bootDurationMs: durationMs,
      memoryUsageMb: {
        rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
        heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      },
      nodeVersion: process.version,
      platform: process.platform,
      cwd: ctx?.cwd || process.cwd(),
    };

    // If we captured per-extension timings this boot, attach them.
    if (timingBlockBuffer.trim().length > 0) {
      const loads = parseExtensionTimings(timingBlockBuffer);
      if (loads.length > 0) {
        entry.extensionLoadTimes = loads;
        entry.totalExtensionLoadMs = loads.reduce((acc, l) => acc + l.totalMs, 0);
      }
    }
    timingBlockBuffer = "";
    sawExtensionsHeader = false;

    // Single-latest-boot storage: overwrite the audit file each boot.
    saveAuditLogs(getAuditFilePath(), entry);
  });

  // Slash command to inspect the latest boot audit entry
  pi.registerCommand("boot-audit", {
    description: "Display the latest boot timing and performance audit entry",
    handler: async (_args: string, ctx: any) => {
      const filePath = getAuditFilePath();
      const log = readAuditEntry(filePath);

      if (!log) {
        ctx.ui.notify("info", "No boot audit entry found yet.");
        return;
      }

      let output = `=== Latest Pi Boot Audit ===\n`;
      output += `Timestamp: ${log.timestamp}\n`;
      output += `Boot Duration: ${log.bootDurationMs}ms\n`;
      output += `Memory: heap ${log.memoryUsageMb.heapUsed}MB / rss ${log.memoryUsageMb.rss}MB\n`;
      output += `Node: ${log.nodeVersion} | Platform: ${log.platform}\n`;
      output += `Cwd: ${log.cwd}\n`;

      if (log.extensionLoadTimes?.length) {
        output += `\nExtension Load Times (${log.extensionLoadTimes.length} total, ${log.totalExtensionLoadMs}ms combined):\n`;
        for (const load of log.extensionLoadTimes.slice(0, 10)) {
          output += ` • ${load.totalMs}ms  ${load.path}\n`;
        }
      }

      ctx.ui.notify("info", `Last boot: ${log.bootDurationMs}ms`);
      ctx.ui.appendMessage({
        role: "assistant",
        content: output,
      });
    },
  });
}
