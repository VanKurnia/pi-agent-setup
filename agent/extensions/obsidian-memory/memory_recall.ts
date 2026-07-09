import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    agentMemoryRoot,
    scopeToFilePath,
    fsGrep,
    readLatestEntries,
    findCliBinary,
} from "./io.ts";
import { execSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let probeDone = false;
let cliAvailable = false;

function ensureProbe(): void {
    if (probeDone) return;
    probeDone = true;
    const binary = findCliBinary();
    if (binary) {
        try {
            cliAvailable =
                execSync(`"${binary}" version`, { encoding: "utf-8", timeout: 4000 }).trim()
                    .length > 0;
        } catch {
            cliAvailable = false;
        }
    }
}

function cliSearch(query: string): string | null {
    if (!cliAvailable) return null;
    const binary = findCliBinary();
    if (!binary) return null;
    try {
        return execSync(`"${binary}" search:context query="${query.replace(/"/g, '\\"')}"`, {
            encoding: "utf-8",
            timeout: 5000,
        }).trim();
    } catch {
        return null;
    }
}

function collectFilePaths(scope: string, project?: string): string[] {
    const root = agentMemoryRoot();
    if (!root) return [];
    if (scope === "global") {
        const p = scopeToFilePath("global");
        return p && existsSync(p) ? [p] : [];
    }
    if (scope === "project") {
        if (!project) return [];
        const p = scopeToFilePath("project", project);
        return p && existsSync(p) ? [p] : [];
    }
    if (!existsSync(root)) return [];
    try {
        return readdirSync(root)
            .filter((f: string) => f.endsWith(".md"))
            .map((f: string) => join(root, f));
    } catch {
        return [];
    }
}

export function registerMemoryRecall(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "memory_recall",
        label: "Recall Memory",
        description: [
            "Search agent memory entries. Use when you need to recall past context, conversations, or decisions. Prefer this over guessing or assuming.",
            "",
            "- query kosong → return most recent entries (timeline)",
            "- scope=global → only user-level facts from global.md",
            "- scope=project → only project entries",
        ].join("\n"),
        parameters: Type.Object({
            query: Type.Optional(
                Type.String({
                    description: "Search query. Empty → return N latest entries (timeline).",
                }),
            ),
            scope: Type.Optional(
                Type.Union([Type.Literal("all"), Type.Literal("global"), Type.Literal("project")]),
            ),
            project: Type.Optional(
                Type.String({ description: "Project name (required if scope=project)." }),
            ),
            limit: Type.Optional(Type.Number({ default: 10, description: "Max results. Max 50." })),
        }),
        async execute(_id, params, _signal, _onUpdate) {
            ensureProbe(); // lazy — blocks only on first tool call, not at registration
            const query = params.query?.trim() || "";
            const scope = params.scope || "all";
            const limit = Math.min(params.limit || 10, 50);
            const root = agentMemoryRoot();
            if (!root)
                return {
                    content: [
                        {
                            type: "text",
                            text: "Cannot find Obsidian vault. Check ~/.pi/agent/obsidian-config.json",
                        },
                    ],
                    details: {},
                };

            if (!query) {
                const paths = collectFilePaths(scope, params.project?.trim());
                if (paths.length === 0)
                    return {
                        content: [
                            { type: "text", text: "No memory entries yet. Write something first." },
                        ],
                        details: {},
                    };
                const entries: string[] = [];
                for (const p of paths) {
                    const latest = readLatestEntries(p, limit);
                    entries.push(...latest);
                    if (entries.length >= limit) break;
                }
                if (entries.length === 0)
                    return {
                        content: [
                            { type: "text", text: "No memory entries yet. Write something first." },
                        ],
                        details: {},
                    };
                return {
                    content: [{ type: "text", text: entries.slice(0, limit).join("\n\n---\n\n") }],
                    details: {},
                };
            }

            const cliResult = cliSearch(query);
            if (cliResult !== null)
                return { content: [{ type: "text", text: cliResult }], details: {} };

            const paths = collectFilePaths(scope, params.project?.trim());
            const results: string[] = [];
            for (const p of paths) {
                const matches = fsGrep(p, query, limit);
                results.push(...matches);
                if (results.length >= limit) break;
            }
            if (results.length === 0)
                return {
                    content: [
                        {
                            type: "text",
                            text: `No results for '${query}'. Try different keywords, shorter query, or broader scope.`,
                        },
                    ],
                    details: {},
                };
            return {
                content: [{ type: "text", text: results.slice(0, limit).join("\n\n---\n\n") }],
                details: {},
            };
        },
    });
}
