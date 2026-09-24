import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SessionInfoEntry } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptForName } from "./helpers/picker.js";
import { fileStamp, parseSessionHeader } from "./helpers/sessions.js";

async function handleRclone(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sourceFile = ctx.sessionManager.getSessionFile();
    if (!sourceFile || !existsSync(sourceFile)) {
        ctx.ui.notify("Current session is not persisted to disk — nothing to clone.", "error");
        return;
    }
    // Unlike builtin /clone: always ask for the new name first.
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

export function registerClone(pi: ExtensionAPI): void {
    pi.registerCommand("rclone", {
        description:
            "Clone the current session into a new session file and switch to it. Unlike builtin /clone, always asks for the new session name first (an argument pre-fills the prompt).",
        handler: (args, ctx) => handleRclone(args, ctx),
    });
}
