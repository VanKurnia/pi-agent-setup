import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerExtensionApi } from "../shared/cross-extension-api.ts";
import { resolveSkillUrl } from "./skill.ts";
import { resolveVaultUrl } from "./vault.ts";
import { resolveWorkspaceUrl } from "./workspace.ts";
import { resolveHealthUrl } from "./health.ts";
import { formatError, PiUrlResult } from "./types.ts";
import { resolveDbUrl } from "./db.ts";

function parsePiUrl(url: string): { protocol: string; path: string } | null {
    const match = url.match(/^pi:\/\/(\w+)(?:\/(.*))?$/);
    if (!match) return null;
    return { protocol: match[1], path: match[2] ?? "" };
}

export function resolvePiUrl(url: string): PiUrlResult {
    const parsed = parsePiUrl(url);
    if (!parsed) {
        return {
            content: formatError(`Invalid pi:// URL: ${url}`, url),
            mime: "text/markdown",
            protocol: "error",
            path: url,
        };
    }

    const { protocol, path } = parsed;

    switch (protocol) {
        case "skill":
            return resolveSkillUrl(path, url);
        case "vault":
            return resolveVaultUrl(path, url);
        case "workspace":
            return resolveWorkspaceUrl(path, url);
        case "health":
            return resolveHealthUrl(path, url);
        case "db":
            return {
                content: "Use pi://db/ via the execute handler (async)",
                mime: "text/markdown",
                protocol: "db",
                path,
            };
        default:
            return {
                content: formatError(`Unknown protocol: pi://${protocol}`, url),
                mime: "text/markdown",
                protocol: "error",
                path: url,
            };
    }
}

export default function (pi: ExtensionAPI) {
    // Expose resolver to other extensions via the shared registry
    registerExtensionApi("pi-url", { resolvePiUrl });

    // Register tool — callable by agents
    pi.registerTool({
        name: "resolve_pi_url",
        label: "Resolve Pi Agent URL",
        description: [
            "Resolve a pi:// internal URL and return its content.",
            "",
            "**Supported URLs**:",
            "- `pi://skill/<name>` — read a Pi Agent skill",
            "- `pi://skill/<name>/reference/<doc>` — read a skill reference doc",
            "- `pi://vault/<path>` — read and render a vault note with resolved wikilinks, or list a directory",
            "- `pi://workspace/` — workspace info (git status, files, branch)",
            "- `pi://workspace/git` — detailed git status",
            "- `pi://workspace/files` — list workspace files (depth ≤ 2)",
            "- `pi://health` — health check (vault, workspace, branch)",
            "- `pi://db/` — list database tables for the current project",
            "- `pi://db/<table>` — query table (first 20 rows)",
            "- `pi://db/<table>/schema` — describe table schema",
            "- `pi://db/connections` — list all configured connections",
        ].join("\n"),
        parameters: Type.Object({
            url: Type.String({ description: 'A pi:// URL, e.g. "pi://skill/orchestrator"' }),
        }),
        async execute(_id, params, _signal, _onUpdate) {
            const url = params.url;
            const parsed = parsePiUrl(url);
            if (parsed && parsed.protocol === "db") {
                const result = await resolveDbUrl(parsed.path, url);
                return {
                    content: [{ type: "text", text: result.content }],
                    details: { protocol: result.protocol, path: result.path, mime: result.mime },
                };
            }
            const result = resolvePiUrl(url);
            return {
                content: [{ type: "text", text: result.content }],
                details: { protocol: result.protocol, path: result.path, mime: result.mime },
            };
        },
    });

    // Register command — interactive use
    pi.registerCommand("pi-url", {
        description:
            "Resolve a pi:// URL and show its content in the editor. Usage: /pi-url pi://skill/orchestrator",
        handler: async (args, ctx) => {
            const url = args.trim();
            if (!url) {
                ctx.ui.notify("Usage: /pi-url <pi:// URL>", "error");
                return;
            }
            const result = resolvePiUrl(url);
            if (result.protocol === "error") {
                ctx.ui.notify(result.content, "error");
                return;
            }
            const summary = `${result.protocol}://${result.path}`;
            ctx.ui.setEditorText(result.content);
            ctx.ui.notify(`Resolved: pi://${summary}`, "info");
        },
    });
}
