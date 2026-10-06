import { execSync } from "node:child_process";
import { relative } from "node:path";

export interface CompileInput {
    messages: Array<{ role?: string; content?: unknown }>;
    previousSummary?: string;
    cwd?: string;
    omSummary?: string;
}

export function extractGitCommits(cwd?: string): string[] {
    try {
        const output = execSync("git log -n 5 --oneline", {
            cwd: cwd || process.cwd(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return output.trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

interface ToolCallBlock {
    type?: string;
    args?: Record<string, unknown>;
}

export function collectTouchedFiles(
    messages: Array<{ role?: string; content?: unknown }>,
    cwd?: string,
): string[] {
    const files = new Set<string>();
    const root = cwd || process.cwd();
    for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const rawBlock of content) {
            const block = rawBlock as ToolCallBlock | undefined;
            if (
                block?.type === "toolCall" &&
                typeof block.args === "object" &&
                block.args !== null
            ) {
                const candidate = block.args.path || block.args.file || block.args.filePath;
                if (typeof candidate === "string" && candidate.trim()) {
                    files.add(relative(root, candidate.trim()));
                }
            }
        }
    }
    return Array.from(files).filter(Boolean);
}

export function compileVccSummary(input: CompileInput): string {
    const sections: string[] = [];

    // 1. Files & Changes
    const touched = collectTouchedFiles(input.messages, input.cwd);
    if (touched.length > 0) {
        sections.push(`### Files Touched\n${touched.map((f) => `- ${f}`).join("\n")}`);
    }

    // 2. Git Commits
    const commits = extractGitCommits(input.cwd);
    if (commits.length > 0) {
        sections.push(`### Recent Commits\n${commits.map((c) => `- ${c}`).join("\n")}`);
    }

    // 3. Observational Memory (if provided)
    if (input.omSummary?.trim()) {
        sections.push(`### Active Context & Insights\n${input.omSummary.trim()}`);
    }

    // 4. Carry over previous summary sections if available
    if (input.previousSummary?.trim()) {
        sections.push(`### Previous Context\n${input.previousSummary.trim()}`);
    }

    return sections.join("\n\n---\n\n");
}
