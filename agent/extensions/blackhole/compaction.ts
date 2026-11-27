import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import {
    calculateContextTokens,
    estimateTokens,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateChars } from "../shared/text-format.ts";

/** One message as the summary reads it; the cross-extension seam accepts plain objects. */
export type SummaryMessage = { role?: string; content?: unknown };

export interface CompileInput {
    messages: SummaryMessage[];
    previousSummary?: string;
    cwd?: string;
    omSummary?: string;
    /** Composed-summary budget in characters. Defaults to SUMMARY_MAX_CHARS. */
    maxChars?: number;
}

export function extractGitCommits(cwd?: string): string[] {
    try {
        const output = execFileSync("git", ["log", "-n", "5", "--oneline"], {
            cwd: cwd || process.cwd(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return output.trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

/** A tool-call block carries its arguments under `arguments` (pi-ai `ToolCall`). */
interface ToolCallBlock {
    type?: string;
    arguments?: Record<string, unknown>;
}

export function collectTouchedFiles(messages: SummaryMessage[], cwd?: string): string[] {
    const files = new Set<string>();
    const root = cwd || process.cwd();
    for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const rawBlock of msg.content) {
            const block = rawBlock as ToolCallBlock | undefined;
            if (block?.type !== "toolCall" || !block.arguments) continue;
            const candidate =
                block.arguments.path || block.arguments.file || block.arguments.filePath;
            if (typeof candidate === "string" && candidate.trim()) {
                files.add(relative(root, candidate.trim()).replace(/\\/g, "/"));
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
function buildTranscriptExcerpt(messages: SummaryMessage[]): string[] {
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
        const slice = truncateChars(text, EXCERPT_MESSAGE_CHARS);
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
        const memoryHead = truncateChars(memory, memoryBudget);
        const body = memoryHead === memory ? memory : `${memoryHead}\n... (memory truncated)`;
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
    const head = truncateChars(summary, budget);
    return head === summary ? summary : `${head}\n... (summary truncated)`;
}

/** Context tokens an entry reported, when it holds a usable assistant response. */
function usageTokens(entry: SessionEntry): number | undefined {
    if (entry.type !== "message") return undefined;
    const message = entry.message;
    if (message.role !== "assistant") return undefined;
    if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
    const tokens = calculateContextTokens(message.usage);
    return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

export function rawTokensSinceLastCompaction(entries: SessionEntry[]): number {
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
        if (usageTokens(entries[i]) !== undefined) {
            usageIndex = i;
            break;
        }
    }

    if (usageIndex !== -1) {
        const baseline = usageTokens(entries[usageIndex]) || 0;
        let postTokens = 0;
        for (let i = usageIndex + 1; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.type === "message") postTokens += estimateTokens(entry.message);
        }
        return baseline + postTokens;
    }

    let total = 0;
    for (let i = scanStart; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === "message") total += estimateTokens(entry.message);
    }
    return total;
}
