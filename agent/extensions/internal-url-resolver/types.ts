import { join } from "node:path";
import { homedir } from "node:os";

export interface PiUrlResult {
    content: string;
    mime: string;
    protocol: string;
    path: string;
}

export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
export const SKILLS_DIR = join(PI_AGENT_DIR, "skills");

export function formatError(msg: string, _url: string): string {
    return [
        `**Error**: ${msg}`,
        "",
        "Supported protocols:",
        "- `pi://skill/<name>` — read a skill",
        "- `pi://skill/<name>/reference/<doc>` — read a skill reference",
        "- `pi://vault/<path>` — read a vault note with wikilink resolution",
    ].join("\n");
}
