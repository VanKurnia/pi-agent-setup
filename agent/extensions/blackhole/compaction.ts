import { execSync } from "node:child_process";
import { relative } from "node:path";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

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
    arguments?: Record<string, unknown>;
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
            if (block?.type === "toolCall") {
                const args = block.arguments || block.args;
                if (typeof args === "object" && args !== null) {
                    const candidate = args.path || args.file || args.filePath;
                    if (typeof candidate === "string" && candidate.trim()) {
                        files.add(relative(root, candidate.trim()).replace(/\\/g, "/"));
                    }
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

export interface SessionEntryLike {
    type: string;
    message?: unknown;
    firstKeptEntryId?: string;
}

export function getUsageTokens(msg: unknown): number | undefined {
    if (typeof msg !== "object" || msg === null) return undefined;
    const record = msg as Record<string, unknown>;
    if (record.role !== "assistant") return undefined;
    if (record.stopReason === "error" || record.stopReason === "aborted") return undefined;
    if (!record.usage) return undefined;
    try {
        const tokens = calculateContextTokens(
            record.usage as Parameters<typeof calculateContextTokens>[0],
        );
        return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
            ? tokens
            : undefined;
    } catch {
        return undefined;
    }
}

export function rawTokensSinceLastCompaction(entries: SessionEntryLike[]): number {
    let compactionIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type === "compaction") {
            compactionIndex = i;
            break;
        }
    }

    const scanStart = compactionIndex === -1 ? 0 : compactionIndex + 1;
    let usageIndex = -1;
    for (let i = entries.length - 1; i >= scanStart; i--) {
        if (entries[i].type === "message" && getUsageTokens(entries[i].message) !== undefined) {
            usageIndex = i;
            break;
        }
    }

    if (usageIndex !== -1) {
        const baseline = getUsageTokens(entries[usageIndex].message) || 0;
        let postTokens = 0;
        for (let i = usageIndex + 1; i < entries.length; i++) {
            if (entries[i].type === "message" && entries[i].message) {
                postTokens += estimateTokens(
                    entries[i].message as Parameters<typeof estimateTokens>[0],
                );
            }
        }
        return baseline + postTokens;
    }

    let total = 0;
    for (let i = scanStart; i < entries.length; i++) {
        if (entries[i].type === "message" && entries[i].message) {
            total += estimateTokens(entries[i].message as Parameters<typeof estimateTokens>[0]);
        }
    }
    return total;
}
