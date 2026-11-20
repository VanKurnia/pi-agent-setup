import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function herdrSubagents(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description:
            "Run a subagent to complete a task. The child runs as a separate pi-bolt process in a sub-agent terminal of this session and only its final reply is returned. A read-only parent snapshot is auto-attached as reference. Each dispatch starts a fresh child unless fresh is false. Requires a session started by herdr-core.",
        promptSnippet: "Run a subagent (scout/worker) for delegated tasks",
        promptGuidelines: [
            "Use subagent to delegate reasoning and decisions: codebase exploration and web research (scout), or isolated code changes (worker).",
            "Parallel tool calls are the primary parallelism mechanism; do not use subagents to parallelize simple I/O.",
            "Include only what the parent snapshot lacks: goal, constraints, and expected output format.",
            "Every dispatch starts a fresh child by default. Pass fresh: false only when the task continues what this parent already gave that agent — a revision, or a follow-up on the same work.",
        ],
        parameters: Type.Object({
            agent: Type.String({ description: "Name of the agent to invoke." }),
            task: Type.String({ description: "Task description for the subagent." }),
            fresh: Type.Optional(
                Type.Boolean({
                    description:
                        "Default true: kill the live child of this agent in this folder, permanently delete its session file and its stored memory, then launch a new child. Pass false only to continue that child's existing context.",
                }),
            ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const { runSubagentTool } = await import("./tool-body.ts");
            return runSubagentTool(params, signal, ctx);
        },
    });
    pi.registerCommand("herdr-subagent:settings", {
        description: "Configure herdr subagent settings (model and thinking level per agent)",
        handler: async (_args, ctx) => {
            const { runSettingsCommand } = await import("./settings-command.ts");
            await runSettingsCommand(ctx);
        },
    });
}
