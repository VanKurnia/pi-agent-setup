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
        "- `pi://vault/<path>` — read/list vault notes and directories",
        "- `pi://workspace` — workspace info",
        "- `pi://workspace/git` — git status",
        "- `pi://workspace/files` — workspace file listing",
        "- `pi://health` — health check",
        "- `pi://db/` — database queries (tables, rows, schema)",
        "- `pi://db/connections` — list all configured connections",
    ].join("\n");
}
