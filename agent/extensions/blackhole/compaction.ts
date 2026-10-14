import { execSync } from "node:child_process";
import { relative } from "node:path";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

export interface CompileInput {
    messages: Array<{ role?: string; content?: unknown }>;
    previousSummary?: string;
    cwd?: string;
    omSummary?: string;
    /** Composed-summary budget in characters. Defaults to SUMMARY_MAX_CHARS. */
    maxChars?: number;
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

/** Default composed-summary budget (~2k tokens); a caller may pass a larger one. */
export const SUMMARY_MAX_CHARS = 8000;

/** Share of the budget the memory section may take before the others yield. */
const OM_BUDGET_SHARE = 0.6;

const CARRY_MAX_LINES = 12;
const EXCERPT_MAX_CHARS = 1500;
const EXCERPT_MESSAGE_CHARS = 400;

/** Bullet lines from any summary text ("- …"), trimmed. */
function bulletLines(text: string): string[] {
    return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "));
}

/** Bounded, newest-last extractive slice of the conversation being summarized. */
function buildTranscriptExcerpt(messages: Array<{ role?: string; content?: unknown }>): string[] {
    const lines: string[] = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0 && used < EXCERPT_MAX_CHARS; i--) {
        const msg = messages[i];
        if (msg?.role !== "user" && msg?.role !== "assistant") continue;
        const text = (
            Array.isArray(msg.content)
                ? msg.content.map((c) => (c as { text?: string })?.text || "").join(" ")
                : String(msg.content || "")
        )
            .replace(/\s+/g, " ")
            .trim();
        if (text.length < 20) continue;
        const slice = text.slice(0, EXCERPT_MESSAGE_CHARS);
        lines.unshift(`- ${msg.role}: ${slice}`);
        used += slice.length;
    }
    return lines;
}

export function compileVccSummary(input: CompileInput): string {
    const budget = input.maxChars ?? SUMMARY_MAX_CHARS;
    const touched = collectTouchedFiles(input.messages, input.cwd);
    const commits = extractGitCommits(input.cwd);

    const sections: string[] = [];

    // Memory leads, but only up to its share: the structural sections below and
    // the transcript excerpt must survive the budget.
    const memory = input.omSummary?.trim() ?? "";
    if (memory) {
        const memoryBudget = Math.floor(budget * OM_BUDGET_SHARE);
        const body =
            memory.length > memoryBudget
                ? `${memory.slice(0, memoryBudget)}\n... (memory truncated)`
                : memory;
        sections.push(`### Active Context & Insights\n${body}`);
    }

    const excerpt = buildTranscriptExcerpt(input.messages);
    if (excerpt.length > 0) {
        sections.push(`### Recent Conversation\n${excerpt.join("\n")}`);
    }

    // Carry forward only decisions/insights that are not already present, capped
    // and de-duplicated — never re-embed the previous summary verbatim (that
    // ratchets the summary past pi's own context budget).
    const alreadyPresent = new Set<string>([
        ...(input.omSummary ? bulletLines(input.omSummary) : []),
        ...excerpt,
        ...touched.map((f) => `- ${f}`),
        ...commits.map((c) => `- ${c}`),
    ]);
    const carried: string[] = [];
    for (const line of bulletLines(input.previousSummary || "")) {
        if (carried.length >= CARRY_MAX_LINES) break;
        // A bare path bullet carries no decision; it must not consume the carry budget.
        if (/^- [^\s]+$/.test(line)) continue;
        if (alreadyPresent.has(line)) continue;
        alreadyPresent.add(line);
        carried.push(line);
    }
    if (carried.length > 0) {
        sections.push(`### Carried Context\n${carried.join("\n")}`);
    }

    if (touched.length > 0) {
        sections.push(`### Files Touched\n${touched.map((f) => `- ${f}`).join("\n")}`);
    }
    if (commits.length > 0) {
        sections.push(`### Recent Commits\n${commits.map((c) => `- ${c}`).join("\n")}`);
    }

    const summary = sections.join("\n\n---\n\n");
    return summary.length > budget
        ? `${summary.slice(0, budget)}\n... (summary truncated)`
        : summary;
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
