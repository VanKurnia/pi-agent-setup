import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerExtensionApi } from "../shared/cross-extension-api.ts";
import { resolveSkillUrl } from "./skill.ts";
import { resolveVaultUrl } from "./vault.ts";
import { resolveWorkspaceUrl } from "./workspace.ts";
import { resolveHealthUrl } from "./health.ts";
import { formatError, PiUrlResult, ProtocolHandler } from "./types.ts";
import { resolveDbUrl } from "./db.ts";
import { resolveFileUrl } from "./file.ts";

function parsePiUrl(url: string): { protocol: string; path: string } | null {
    const match = url.match(/^pi:\/\/(\w+)(?:\/(.*))?$/);
    if (!match) return null;
    return { protocol: match[1], path: match[2] ?? "" };
}

// ── Dynamic protocol registry ─────────────────────────────────────
const protocolRegistry = new Map<string, ProtocolHandler>();

protocolRegistry.set("skill", { resolver: resolveSkillUrl, description: "Read a Pi Agent skill" });
protocolRegistry.set("vault", {
    resolver: resolveVaultUrl,
    description: "Read vault notes with wikilink resolution",
});
protocolRegistry.set("workspace", {
    resolver: resolveWorkspaceUrl,
    description: "Workspace info (git status, files, branch)",
});
protocolRegistry.set("health", {
    resolver: resolveHealthUrl,
    description: "Health check (vault, workspace, branch)",
});
protocolRegistry.set("file", {
    resolver: resolveFileUrl,
    description: "Resolve workspace file content by path",
});

protocolRegistry.set("db", {
    resolver: (_path, _url) => ({
        content: "Use pi://db/ via the execute handler (async)",
        mime: "text/markdown",
        protocol: "db",
        path: _path,
    }),
    description: "Database queries (tables, rows, schema)",
});

/** Register a new protocol that the URL resolver can route to. */
export function registerProtocol(name: string, handler: ProtocolHandler): void {
    protocolRegistry.set(name, handler);
}

/** List all registered protocols with descriptions. */
export function listProtocols(): { name: string; description: string }[] {
    return Array.from(protocolRegistry.entries()).map(([name, h]) => ({
        name,
        description: h.description,
    }));
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
    const handler = protocolRegistry.get(protocol);
    if (handler) {
        return handler.resolver(path, url);
    }

    return {
        content: formatError(`Unknown protocol: pi://${protocol}`, url, listProtocols()),
        mime: "text/markdown",
        protocol: "error",
        path: url,
    };
}

export default function (pi: ExtensionAPI) {
    // Expose resolver + registry to other extensions via the shared registry
    registerExtensionApi("pi-url", { resolvePiUrl, registerProtocol, listProtocols });

    // Register tool — callable by agents
    const protocolDocs = listProtocols()
        .map((p) => `- \`pi://${p.name}/\` — ${p.description}`)
        .join("\n");

    pi.registerTool({
        name: "resolve_pi_url",
        label: "Resolve Pi Agent URL",
        description: [
            "Resolve a pi:// internal URL and return its content.",
            "",
            "**Supported URLs**:",
            protocolDocs,
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
