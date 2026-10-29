import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function herdrSubagents(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description:
            "Run a subagent to complete a task. The child runs as a separate pi-bolt process in its own herdr pane and only its final reply is returned. A read-only parent snapshot is auto-attached as reference. Requires running inside herdr.",
        parameters: Type.Object({
            agent: Type.String({ description: "Name of the agent to invoke." }),
            task: Type.String({ description: "Task description for the subagent." }),
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
