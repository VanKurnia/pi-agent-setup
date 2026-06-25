import { spawnSync } from "node:child_process";
import * as path from "node:path";

// Heuristic: a "file path" inside backticks has at least one / or \\
// plus an extension (dot followed by alphanumeric). This excludes things
// like `npm test`, `hello`, or variable names while catching both
// relative paths (extensions/foo.ts) and absolute paths (C:/Users/...).
const FILE_PATH_IN_TICKS = /`([^`]+[/\\][^`]+\.[a-zA-Z0-9_]+)`/g;

function makeRelPath(raw: string, cwd: string): string {
  // Normalize backslashes
  let p = raw.replace(/\\/g, "/");
  // If absolute Windows path (e.g. C:/Users/...), make relative to cwd
  if (p.match(/^[a-zA-Z]:\//)) {
    const rel = path.relative(cwd, p);
    // path.relative normalizes to / but may produce \\ on Windows
    return rel.replace(/\\/g, "/");
  }
  return p;
}

function extractFilePaths(output: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  // Strategy 1: bullet points in ## Changes Made section (most reliable)
  const changesMatch = output.match(/## Changes Made[\s\S]*?(?=## |$)/);
  if (changesMatch) {
    for (const line of changesMatch[0].split("\n")) {
      const m = line.match(/^-\s+`([^`]+)`/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); paths.push(m[1]); }
    }
  }

  // Strategy 2: scan all lines for backtick-wrapped file paths
  // Only if no paths found via strategy 1 (worker may not have used format)
  if (paths.length === 0) {
    for (const line of output.split("\n")) {
      if (line.startsWith("#") || line.startsWith("\`\`\`")) continue;
      const matches = line.matchAll(FILE_PATH_IN_TICKS);
      for (const m of matches) {
        if (!seen.has(m[1])) { seen.add(m[1]); paths.push(m[1]); }
      }
    }
  }

  return paths;
}

function getFileDiff(filePath: string, cwd: string): string {
  const relPath = makeRelPath(filePath, cwd);

  const check = spawnSync(`git`, [`cat-file`, `-e`, `HEAD:${relPath}`], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const isTracked = check.status === 0;

  let raw: Buffer;
  if (isTracked) {
    raw = spawnSync(`git`, [`diff`, `HEAD`, `--`, relPath], {
      cwd,
      maxBuffer: 1024 * 64,
      stdio: ["ignore", "pipe", "pipe"],
    }).stdout;
  } else {
    raw = spawnSync(`git`, [`diff`, `--no-index`, `/dev/null`, relPath], {
      cwd,
      maxBuffer: 1024 * 64,
      stdio: ["ignore", "pipe", "pipe"],
    }).stdout;
  }

  return (raw || "").toString().trim();
}

export function computeWorkerDiffs(output: string, cwd: string, ctx?: any): string {
  const filePaths = extractFilePaths(output);
  const parts: string[] = [];

  for (const filePath of filePaths) {
    try {
      const relPath = makeRelPath(filePath, cwd);
      const absPath = path.resolve(cwd, relPath);

      // Read original content from git
      const showResult = spawnSync(`git`, [`show`, `HEAD:${relPath}`], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const isTracked = showResult.status === 0;
      const originalContent = isTracked ? (showResult.stdout || "").toString().trim() : null;

      const diff = getFileDiff(filePath, cwd);
      if (diff) {
        parts.push(`### ${filePath}\n\n\`\`\`diff\n${diff}\n\`\`\``);
      }
    } catch {
      // File might have been deleted or path invalid — skip
    }
  }

  return parts.length ? `\n\n## File changes\n\n${parts.join("\n\n")}` : "";
}
