/**
 * Session manager — one extension for everything session-related.
 *
 * Registers:
 *   /rclone        — clone current session, always asks for new name first
 *   rename_session — model-callable tool to set the session display name
 *   /workdir       — searchable picker of previous working directories
 *   /session-mgr   — settings menu (cleanup threshold + clean now) + startup auto-clean prompt
 *
 * Command implementations and cleanup logic are loaded on demand.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function sessionMgr(pi: ExtensionAPI): void {
    // ---- rename_session (tool) ----
    pi.registerTool({
        name: "rename_session",
        label: "Rename session",
        description: "Set the display name of the current session (shown in the session selector).",
        promptSnippet: "Rename the current session with rename_session",
        parameters: Type.Object({
            name: Type.String({ description: "New display name for the current session." }),
        }),
        async execute(_toolCallId, params) {
            const name = params.name.trim();
            if (name.length === 0) {
                return {
                    content: [{ type: "text" as const, text: "Name cannot be empty." }],
                    details: {},
                };
            }
            pi.setSessionName(name);
            return {
                content: [{ type: "text" as const, text: `Session renamed to "${name}".` }],
                details: {},
            };
        },
    });

    // ---- /rclone (command) ----
    pi.registerCommand("rclone", {
        description:
            "Clone the current session into a new session file and switch to it. Unlike builtin /clone, always asks for the new session name first.",
        handler: async (args, ctx) => {
            const { handleRclone } = await import("./session-ops.js");
            await handleRclone(args, ctx);
        },
    });

    // ---- /workdir (command) ----
    pi.registerCommand("workdir", {
        description: "Jump back to a previous working directory (searchable)",
        handler: async (args, ctx) => {
            const { handleWorkdirCommand } = await import("./session-ops.js");
            await handleWorkdirCommand(args, ctx);
        },
    });

    // ---- /session-mgr (command) ----
    pi.registerCommand("session-mgr", {
        description: "Session manager settings (cleanup…)",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify(
                    "Session manager: no dialog available in headless mode — use /session-mgr from interactive TUI.",
                    "error",
                );
                return;
            }
            const { handleSessionMgr } = await import("./cleanup.js");
            await handleSessionMgr(getAgentDir(), ctx);
        },
    });

    // ---- session_start (auto-cleanup hook) ----
    pi.on("session_start", async (event, ctx) => {
        if (event.reason !== "startup" || !ctx.hasUI) return;
        const { handleAutoCleanupOnStart } = await import("./cleanup.js");
        await handleAutoCleanupOnStart(ctx);
    });
}
