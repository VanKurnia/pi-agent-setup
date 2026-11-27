import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

/** The tool's inputs. `tool-body.ts` takes its parameter type from here, so this is the only declaration. */
export const subagentParams = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke." }),
    task: Type.String({ description: "Task description for the subagent." }),
    fresh: Type.Optional(
        Type.Boolean({
            description:
                "Default true: kill the live child of this agent in this folder, permanently delete its session file and its stored memory, then launch a new child. Pass false only to continue that child's existing context.",
        }),
    ),
});

export type SubagentParams = Static<typeof subagentParams>;

export default function herdrSubagents(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description:
            "Run a subagent to complete a task and return only its final reply. A read-only snapshot of this session is attached as reference.",
        promptSnippet: "Run a subagent (scout/worker) for delegated tasks",
        promptGuidelines: [
            "subagent: delegate reasoning, not I/O — recon and web research (scout), or an isolated code change (worker).",
            "subagent: include only what the parent snapshot lacks — goal, constraints, and expected output format.",
        ],
        parameters: subagentParams,
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
