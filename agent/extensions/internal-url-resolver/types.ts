import { join } from "node:path";
import { homedir } from "node:os";

export type ProtocolResolver = (path: string, url: string) => PiUrlResult;

export interface ProtocolHandler {
    resolver: ProtocolResolver;
    description: string;
}

export interface PiUrlResult {
    content: string;
    mime: string;
    protocol: string;
    path: string;
}

export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
export const SKILLS_DIR = join(PI_AGENT_DIR, "skills");

export function formatError(
    msg: string,
    _url: string,
    protocols?: { name: string; description: string }[],
): string {
    const lines = [`**Error**: ${msg}`, "", "Supported protocols:"];
    if (protocols) {
        for (const p of protocols) {
            lines.push(`- \`pi://${p.name}/\` — ${p.description}`);
        }
    }
    return lines.join("\n");
}
