import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendMemoryEntry, scopeToFilePath, agentMemoryRoot, memoryUrl } from "./io.ts";

export function registerMemoryWrite(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "memory_write",
        label: "Write Memory Entry",
        description: [
            "Write a memory entry. Use when you learn something new, make a decision, or want to remember context for later. Entries are timestamped automatically.",
            "",
            "- scope=global → saved in global.md (user facts, preferences)",
            "- scope=project → saved in <project>.md (project decisions, context)",
            "- project name: letters, numbers, hyphens, underscores only",
        ].join("\n"),
        parameters: Type.Object({
            content: Type.String({ description: "What to remember. Max 2000 characters." }),
            scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
            project: Type.Optional(Type.String({ description: "Required if scope=project." })),
            tags: Type.Optional(
                Type.Array(Type.String(), { description: "Optional tags. Max 5." }),
            ),
        }),
        async execute(_id, params, _signal, _onUpdate) {
            const content = params.content?.trim();
            if (!content)
                return {
                    content: [
                        {
                            type: "text",
                            text: "Content cannot be empty. Write what you want to remember.",
                        },
                    ],
                    details: {},
                };
            if (content.length > 2000)
                return {
                    content: [
                        {
                            type: "text",
                            text: `Content too long (${content.length} chars). Max 2000. Split into multiple entries.`,
                        },
                    ],
                    details: {},
                };
            const scope = params.scope || "project";
            const project = params.project?.trim();
            if (scope === "project" && (!project || !/^[a-zA-Z0-9_-]+$/.test(project)))
                return {
                    content: [
                        {
                            type: "text",
                            text: `Invalid project name '${project || ""}'. Use only letters, numbers, hyphens, and underscores.`,
                        },
                    ],
                    details: {},
                };
            const tags = params.tags || [];
            if (tags.length > 5)
                return {
                    content: [
                        {
                            type: "text",
                            text: `Too many tags (${tags.length}). Max 5 tags per entry.`,
                        },
                    ],
                    details: {},
                };
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
            const filePath =
                scope === "project"
                    ? scopeToFilePath("project", project)
                    : scopeToFilePath("global");
            if (!filePath)
                return {
                    content: [{ type: "text", text: "Cannot resolve memory file path." }],
                    details: {},
                };
            if (
                !appendMemoryEntry(
                    filePath,
                    content,
                    scope === "project" ? project : undefined,
                    tags,
                )
            )
                return {
                    content: [
                        {
                            type: "text",
                            text: "Failed to write memory entry. Check file permissions.",
                        },
                    ],
                    details: {},
                };
            const mUrl = memoryUrl(scope, project);
            return {
                content: [
                    {
                        type: "text",
                        text: `Memory written to \`_agent/memory/${scope === "project" ? `${project}.md` : "global.md"}\`. Ready for recall.\n\n📍 See full file: \`resolve_pi_url("${mUrl}")\``,
                    },
                ],
                details: {},
            };
        },
    });
}
