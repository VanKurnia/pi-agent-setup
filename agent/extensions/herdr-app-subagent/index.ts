import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function herdrSubagents(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description:
            "Run a subagent to complete a task. The child runs as a separate pi-bolt process in a sub-agent terminal of this session and only its final reply is returned. A read-only parent snapshot is auto-attached as reference. Requires a session started by herdr-core.",
        promptSnippet: "Run a subagent (scout/worker) for delegated tasks",
        promptGuidelines: [
            "Use subagent to delegate reasoning and decisions: codebase exploration and web research (scout), or isolated code changes (worker).",
            "Parallel tool calls are the primary parallelism mechanism; do not use subagents to parallelize simple I/O.",
            "Include only what the parent snapshot lacks: goal, constraints, and expected output format.",
            "Pass fresh: true only when the task is unrelated to what that child already holds; reuse is cheaper and keeps its context.",
        ],
        parameters: Type.Object({
            agent: Type.String({ description: "Name of the agent to invoke." }),
            task: Type.String({ description: "Task description for the subagent." }),
            fresh: Type.Optional(
                Type.Boolean({
                    description:
                        "Start over: kill the live child of this agent in this folder, permanently delete its session file and its stored memory, then launch a new child. Default false reuses the warm child.",
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
