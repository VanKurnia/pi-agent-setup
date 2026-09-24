import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok } from "../git-toolkit/helpers.js";

export function registerRename(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "rename_session",
        label: "Rename session",
        description: "Set the display name of the current session (shown in the session selector).",
        promptSnippet: "Rename the current session with rename_session",
        parameters: Type.Object({
            name: Type.String({ description: "New display name for the current session." }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const name = params.name.trim();
            if (name.length === 0) return ok("Name cannot be empty.");
            pi.setSessionName(name);
            return ok(`Session renamed to "${name}".`);
        },
    });
}
