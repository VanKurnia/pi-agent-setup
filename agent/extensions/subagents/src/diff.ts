import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { resolve } from "node:path";
import { getExtensionApi } from "../../shared/cross-extension-api.js";
import type { FilechangesApi } from "../src/types.js";

const execAsync = promisify(exec);

// Heuristic: a "file path" inside backticks has at least one / or \\
// plus an extension (dot followed by alphanumeric). This excludes things
// like `npm test`, `hello`, or variable names while catching both
// relative paths (extensions/foo.ts) and absolute paths (C:/Users/...).
const FILE_PATH_IN_TICKS = /`([^`]+[/\\][^`]+\.[a-zA-Z0-9_]+)`/g;

function makeRelPath(raw: string, cwd: string): string {
    // Normalize backslashes
    const p = raw.replace(/\\/g, "/");
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
            if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                paths.push(m[1]);
            }
        }
    }

    // Strategy 2: scan all lines for backtick-wrapped file paths
    // Only if no paths found via strategy 1 (worker may not have used format)
    if (paths.length === 0) {
        for (const line of output.split("\n")) {
            if (line.startsWith("#") || line.startsWith("\`\`\`")) continue;
            const matches = line.matchAll(FILE_PATH_IN_TICKS);
            for (const m of matches) {
                if (!seen.has(m[1])) {
                    seen.add(m[1]);
                    paths.push(m[1]);
                }
            }
        }
    }

    return paths;
}

async function getFileDiff(filePath: string, cwd: string): Promise<string> {
    const relPath = makeRelPath(filePath, cwd);

    let isTracked = false;
    try {
        await execAsync(`git cat-file -e HEAD:${relPath}`, { cwd });
        isTracked = true;
    } catch {}

    let raw: string;
    if (isTracked) {
        const { stdout } = await execAsync(`git diff HEAD -- "${relPath}"`, {
            cwd,
            maxBuffer: 1024 * 64,
        });
        raw = stdout;
    } else {
        const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
        const { stdout } = await execAsync(`git diff --no-index ${nullDevice} "${relPath}"`, {
            cwd,
            maxBuffer: 1024 * 64,
        });
        raw = stdout;
    }

    return (raw || "").trim();
}

export async function computeWorkerDiffs(output: string, cwd: string, ctx?: any): Promise<string> {
    const filePaths = extractFilePaths(output);
    const parts: string[] = [];

    const filechanges = getExtensionApi<FilechangesApi>("filechanges");

    for (const filePath of filePaths) {
        try {
            const relPath = makeRelPath(filePath, cwd);
            const absPath = resolve(cwd, relPath);

            // Register with filechanges so users can accept/decline the
            // worker's modifications. We read the pre-worker baseline from git
            // because computeWorkerDiffs runs *after* the worker finished.
            if (filechanges) {
                try {
                    const isTracked = await execAsync(`git cat-file -e HEAD:${relPath}`, { cwd })
                        .then(() => true)
                        .catch(() => false);
                    // originalContent for tracked files = git HEAD;
                    // for new files = null (didn't exist before)
                    const orig = isTracked
                        ? (
                              await execAsync(`git show HEAD:"${relPath}"`, { cwd }).then(
                                  (r) => r.stdout,
                              )
                          ).trimEnd()
                        : null;
                    await filechanges.trackFile(ctx, relPath, absPath, orig);
                } catch {
                    /* non-fatal */
                }
            }

            const diff = await getFileDiff(filePath, cwd);
            if (diff) {
                parts.push(`### ${filePath}

\`\`\`diff
${diff}
\`\`\``);
            }
        } catch {
            // File might have been deleted or path invalid — skip
        }
    }

    return parts.length
        ? `

## File changes

${parts.join("\n\n")}`
        : "";
}
