/**
 * session-ops — session cloning, working directory navigation, and rename.
 *
 * Loaded on-demand when `/rclone`, `/workdir`, or `rename_session` are used.
 */

import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
    CURRENT_SESSION_VERSION,
    getAgentDir,
    type ExtensionCommandContext,
    type SessionHeader,
    type SessionInfoEntry,
} from "@earendil-works/pi-coding-agent";
import { promptForName, showPicker } from "../shared/picker.js";
import { shortenHome } from "../shared/text-format.js";

// =============================================================================
// Path Helpers
// =============================================================================

export function normalizeDir(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
}

// =============================================================================
// Session File Primitives
// =============================================================================

export function readFileHead(filePath: string, size = 8192): string | undefined {
    let fd = -1;
    try {
        fd = openSync(filePath, "r");
        const buf = Buffer.alloc(size);
        const bytes = readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, bytes).toString("utf-8");
    } catch {
        return undefined;
    } finally {
        if (fd !== -1) {
            try {
                closeSync(fd);
            } catch {}
        }
    }
}

export function parseSessionHeader(line: string | undefined): SessionHeader | undefined {
    if (!line) return undefined;
    try {
        const header = JSON.parse(line) as Record<string, unknown>;
        if (
            header["type"] !== "session" ||
            typeof header["id"] !== "string" ||
            typeof header["cwd"] !== "string" ||
            typeof header["timestamp"] !== "string"
        )
            return undefined;
        return header as unknown as SessionHeader;
    } catch {
        return undefined;
    }
}

export function readSessionCwd(filePath: string): string | undefined {
    const head = readFileHead(filePath, 2048);
    return parseSessionHeader(head?.split("\n")[0])?.cwd;
}

export function fileStamp(iso: string): string {
    return iso.replace(/[:.]/g, "-");
}

export function listSessionFiles(dir: string): string[] {
    try {
        return readdirSync(dir)
            .filter((f) => f.endsWith(".jsonl"))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

export function sessionFolder(agentDir: string, cwd: string): string {
    const resolved = resolve(cwd);
    const folder = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(agentDir, "sessions", folder);
}

// =============================================================================
// /rclone
// =============================================================================

export async function handleRclone(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sourceFile = ctx.sessionManager.getSessionFile();
    if (!sourceFile || !existsSync(sourceFile)) {
        ctx.ui.notify("Current session is not persisted to disk — nothing to clone.", "error");
        return;
    }
    const name = await promptForName(ctx, "Name for cloned session", args.trim() || undefined);
    if (!name) {
        ctx.ui.notify("Clone cancelled.", "warning");
        return;
    }

    let raw: string;
    try {
        raw = readFileSync(sourceFile, "utf8");
    } catch {
        ctx.ui.notify(`Could not read current session file: ${sourceFile}`, "error");
        return;
    }
    const lines = raw.split("\n");
    const header = parseSessionHeader(lines[0]);
    if (!header) {
        ctx.ui.notify("Current session file has an invalid header — refusing to clone.", "error");
        return;
    }

    const newId = randomUUID();
    const now = new Date().toISOString();
    const cloneHeader = { ...header, id: newId, timestamp: now, parentSession: sourceFile };
    const nameEntry: SessionInfoEntry = {
        type: "session_info",
        id: randomUUID().slice(0, 8),
        parentId: ctx.sessionManager.getLeafId(),
        timestamp: now,
        name,
    };
    const bodyLines = lines.slice(1).filter((line) => line.trim().length > 0);
    const content = [JSON.stringify(cloneHeader), ...bodyLines, JSON.stringify(nameEntry), ""].join(
        "\n",
    );

    const destFile = join(ctx.sessionManager.getSessionDir(), `${fileStamp(now)}_${newId}.jsonl`);
    if (existsSync(destFile)) {
        ctx.ui.notify("A session file with the new id already exists — try again.", "error");
        return;
    }
    try {
        writeFileSync(destFile, content, "utf8");
    } catch {
        ctx.ui.notify(`Could not write cloned session file: ${destFile}`, "error");
        return;
    }
    try {
        await ctx.switchSession(destFile, {
            withSession: async (newCtx) => {
                newCtx.ui.notify(
                    `Cloned into "${name}" — continuing in the new session now.`,
                    "info",
                );
            },
        });
    } catch {
        ctx.ui.notify(
            `Clone saved as "${name}" (id ${newId.slice(0, 8)}…). Resume it from the session selector or with: pi --session ${newId}`,
            "info",
        );
    }
}

// =============================================================================
// /workdir
// =============================================================================

interface WorkdirEntry {
    cwd: string;
    sessions: number;
    lastActive: number;
    trustedOnly: boolean;
}

function collectWorkdirs(agentDir: string): WorkdirEntry[] {
    const sessionsRoot = join(agentDir, "sessions");
    let folders: string[] = [];
    try {
        folders = readdirSync(sessionsRoot).filter((f) => f.startsWith("--") && f.endsWith("--"));
    } catch {
        return [];
    }
    const byCwd = new Map<string, WorkdirEntry>();
    for (const folder of folders) {
        const dir = join(sessionsRoot, folder);
        const files = listSessionFiles(dir);
        if (files.length === 0) continue;
        const newest = join(dir, files[0]);
        const cwd = readSessionCwd(newest);
        if (!cwd) continue;
        let lastActive = 0;
        try {
            lastActive = statSync(newest).mtimeMs;
        } catch {}
        byCwd.set(cwd, { cwd, sessions: files.length, lastActive, trustedOnly: false });
    }
    try {
        const trust = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8")) as Record<
            string,
            unknown
        >;
        for (const [cwd, allowed] of Object.entries(trust)) {
            if (allowed && !byCwd.has(cwd)) {
                byCwd.set(cwd, { cwd, sessions: 0, lastActive: 0, trustedOnly: true });
            }
        }
    } catch {}
    return [...byCwd.values()].sort((a, b) => b.lastActive - a.lastActive);
}

function findPendingFreshFile(agentDir: string, cwd: string): string | undefined {
    const wanted = normalizeDir(resolve(cwd));
    const dir = sessionFolder(agentDir, cwd);
    for (const f of listSessionFiles(dir)) {
        const filePath = join(dir, f);
        const lines = (readFileHead(filePath) ?? "").split("\n").filter((l) => l.trim());
        if (lines.length !== 1) continue;
        const header = parseSessionHeader(lines[0]);
        if (header && normalizeDir(header.cwd) === wanted) return filePath;
    }
    return undefined;
}

function freshSessionFile(agentDir: string, cwd: string): string {
    const resolved = resolve(cwd);
    const dir = sessionFolder(agentDir, resolved);
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id,
        timestamp,
        cwd: resolved,
    };
    const filePath = join(dir, `${fileStamp(timestamp)}_${id}.jsonl`);
    writeFileSync(filePath, `${JSON.stringify(header)}\n`, "utf-8");
    return filePath;
}

function describe(entry: WorkdirEntry): string {
    if (entry.trustedOnly) return "trusted · no sessions yet";
    const date = entry.lastActive ? new Date(entry.lastActive).toLocaleDateString() : "unknown";
    return `${entry.sessions} session${entry.sessions === 1 ? "" : "s"} · ${date}`;
}

interface WorkdirNode {
    entry: WorkdirEntry;
    children: WorkdirNode[];
}

function findParent(cwd: string, candidates: WorkdirEntry[]): WorkdirEntry | undefined {
    const norm = normalizeDir(cwd);
    let best: WorkdirEntry | undefined;
    let bestLen = -1;
    for (const c of candidates) {
        if (c.cwd === cwd) continue;
        const n = normalizeDir(c.cwd);
        if (n.length < norm.length && norm.startsWith(`${n}/`) && n.length > bestLen) {
            best = c;
            bestLen = n.length;
        }
    }
    return best;
}

function subtreeLatest(node: WorkdirNode): number {
    let latest = node.entry.lastActive;
    for (const child of node.children) latest = Math.max(latest, subtreeLatest(child));
    return latest;
}

function buildForest(entries: WorkdirEntry[]): WorkdirNode[] {
    const nodes = new Map<string, WorkdirNode>();
    for (const e of entries) nodes.set(e.cwd, { entry: e, children: [] });
    const roots: WorkdirNode[] = [];
    for (const node of nodes.values()) {
        const parent = findParent(node.entry.cwd, entries);
        const parentNode = parent && nodes.get(parent.cwd);
        if (parentNode) parentNode.children.push(node);
        else roots.push(node);
    }
    const byRecent = (a: WorkdirNode, b: WorkdirNode) => subtreeLatest(b) - subtreeLatest(a);
    roots.sort(byRecent);
    for (const n of nodes.values()) n.children.sort(byRecent);
    return roots;
}

/** Child segment of `cwd` under `parentCwd`; parent must be a path prefix of child. */
function displayName(cwd: string, parentCwd: string): string {
    return cwd.slice(normalizeDir(parentCwd).length + 1);
}

function flattenForest(
    roots: WorkdirNode[],
    guide: (text: string) => string,
): { entry: WorkdirEntry; label: string }[] {
    const rows: { entry: WorkdirEntry; label: string }[] = [];
    const walkChildren = (node: WorkdirNode, base: string) => {
        node.children.forEach((child, i) => {
            const last = i === node.children.length - 1;
            rows.push({
                entry: child.entry,
                label: `${base}${guide(last ? "└─ " : "├─ ")}${displayName(child.entry.cwd, node.entry.cwd)}`,
            });
            walkChildren(child, base + (last ? "  " : guide("│ ")));
        });
    };
    for (const r of roots) {
        rows.push({ entry: r.entry, label: shortenHome(r.entry.cwd) });
        walkChildren(r, "");
    }
    return rows;
}

export async function handleWorkdirCommand(
    _args: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const agentDir = getAgentDir();
    const entries = collectWorkdirs(agentDir).filter((e) => e.cwd !== ctx.cwd);
    if (entries.length === 0) {
        ctx.ui.notify("No previous workdirs found", "info");
        return;
    }
    const dirPicked = await showPicker(
        ctx,
        "Back to workdir:",
        "type to filter • ↑↓ navigate • enter select • esc close",
        (theme) => {
            const guide = (s: string) => theme.fg("dim", s);
            return flattenForest(buildForest(entries), guide).map((r) => ({
                value: r.entry.cwd,
                label: r.label,
                description: describe(r.entry),
            }));
        },
    );
    if (!dirPicked) return;
    const targetFile =
        findPendingFreshFile(agentDir, dirPicked) ?? freshSessionFile(agentDir, dirPicked);
    await ctx.switchSession(targetFile);
}
