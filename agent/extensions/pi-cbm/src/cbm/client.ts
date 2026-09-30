import { spawn } from "node:child_process";
import { errorText, formatSize } from "../shared/strings.js";
import { getCbmVersion, resolveCbmBinary, spawnTarget } from "./binary.js";
import type { CbmVersion } from "./binary.js";
import { parseCbmEnvelope, parseMaybeJson } from "./envelope.js";
import type { CbmCallOptions, CbmCallResult } from "./result.js";
import { DEFAULT_QUERY_TIMEOUT_MS } from "./timeouts.js";

const MAX_STDIO_BYTES = 50 * 1024 * 1024;

// Upstream tools that declare no `format` parameter; sending one is an error.
// Confirm with `codebase-memory-mcp cli <tool> --help` before editing this list.
const TOOLS_WITHOUT_FORMAT_PARAM = new Set([
    "index_repository",
    "delete_project",
    "compare_graphs",
    "ingest_traces",
]);

// Retry profile for a binary that predates the `format` parameter.
const PRE_FORMAT_VERSION: CbmVersion = { major: 0, minor: 9, patch: 0 };

// `format` exists from 0.10.0 onwards. Before that the payload was JSON already,
// so the parameter must not be sent.
export function supportsJsonFormatParameter(version: CbmVersion | undefined): boolean {
    return version === undefined || version.major > 0 || version.minor >= 10;
}

function buildArgPayload(
    toolName: string,
    args: Record<string, unknown>,
    version: CbmVersion | undefined,
): string {
    // A caller-supplied `format` always wins over the default.
    if (TOOLS_WITHOUT_FORMAT_PARAM.has(toolName) || !supportsJsonFormatParameter(version))
        return JSON.stringify(args);
    return JSON.stringify({ format: "json", ...args });
}

/**
 * An unresolved version is probed optimistically as modern, so a binary that
 * predates `format` needs exactly one retry without it. A caller-supplied
 * `format` is the caller's choice and is never rewritten.
 */
function shouldRetryWithoutFormat(
    toolName: string,
    args: Record<string, unknown>,
    version: CbmVersion | undefined,
    error: unknown,
): boolean {
    if (version !== undefined || TOOLS_WITHOUT_FORMAT_PARAM.has(toolName) || "format" in args)
        return false;
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("format");
}

export class CbmClient {
    async findGitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
        const child = spawn("git", ["rev-parse", "--show-toplevel"], {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });

        const kill = () => {
            if (!child.killed) child.kill("SIGTERM");
        };
        signal?.addEventListener("abort", kill, { once: true });

        try {
            const output = await new Promise<string>((resolveOutput) => {
                let stdout = "";
                child.stdout?.on("data", (chunk: Buffer) => {
                    stdout += chunk.toString("utf8");
                });
                child.on("error", () => resolveOutput(""));
                child.on("close", (code) => resolveOutput(code === 0 ? stdout.trim() : ""));
            });

            return output || undefined;
        } finally {
            signal?.removeEventListener("abort", kill);
        }
    }

    async gitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
        return (await this.findGitRoot(cwd, signal)) ?? cwd;
    }

    async callTool(
        toolName: string,
        args: Record<string, unknown>,
        options: CbmCallOptions = {},
    ): Promise<CbmCallResult> {
        const binary = await resolveCbmBinary();
        const version = await getCbmVersion();
        try {
            return await this.callToolOnce(
                binary,
                toolName,
                buildArgPayload(toolName, args, version),
                options,
            );
        } catch (error) {
            if (!shouldRetryWithoutFormat(toolName, args, version, error)) throw error;
            return await this.callToolOnce(
                binary,
                toolName,
                buildArgPayload(toolName, args, PRE_FORMAT_VERSION),
                options,
            );
        }
    }

    private async callToolOnce(
        binary: string,
        toolName: string,
        payload: string,
        options: CbmCallOptions,
    ): Promise<CbmCallResult> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
        const { command, prefixArgs } = spawnTarget(binary);
        const child = spawn(command, [...prefixArgs, "cli", "--json", toolName], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });

        // A child that exits before draining stdin makes the write fail with EPIPE.
        // Without a listener that is an unhandled 'error' event that would take the
        // session down; the call result is still decided by exit code and stdout.
        child.stdin?.on("error", () => {});
        child.stdin?.end(payload);

        let stdout = "";
        let stderr = "";
        let settled = false;

        const kill = () => {
            if (!settled && !child.killed) child.kill("SIGTERM");
        };

        const timeout = setTimeout(kill, timeoutMs);
        options.signal?.addEventListener("abort", kill, { once: true });

        try {
            const { code, signal } = await new Promise<{
                code: number | null;
                signal: NodeJS.Signals | null;
            }>((resolve, reject) => {
                child.stdout?.on("data", (chunk: Buffer) => {
                    stdout += chunk.toString("utf8");
                    if (Buffer.byteLength(stdout, "utf8") > MAX_STDIO_BYTES) {
                        reject(
                            new Error(
                                `codebase-memory-mcp stdout exceeded ${formatSize(MAX_STDIO_BYTES)}`,
                            ),
                        );
                        kill();
                    }
                });
                child.stderr?.on("data", (chunk: Buffer) => {
                    stderr += chunk.toString("utf8");
                    if (Buffer.byteLength(stderr, "utf8") > MAX_STDIO_BYTES) {
                        stderr = `${stderr.slice(0, MAX_STDIO_BYTES)}\n[stderr truncated]`;
                    }
                });
                child.on("error", reject);
                child.on("close", (code, signal) => resolve({ code, signal }));
            });

            settled = true;

            if (options.signal?.aborted)
                throw new Error(`codebase-memory-mcp ${toolName} cancelled`);
            if (signal) throw new Error(`codebase-memory-mcp ${toolName} terminated by ${signal}`);
            if (code !== 0 && !stdout.trim()) {
                throw new Error(
                    `codebase-memory-mcp ${toolName} failed with exit code ${code}: ${stderr.trim()}`,
                );
            }

            const { envelope, text, structured } = parseCbmEnvelope(stdout);
            const data = structured ?? parseMaybeJson(text);
            const ok = envelope.isError !== true;
            if (!ok && !options.allowError) throw new Error(errorText(data));

            return { ok, data, rawText: text, stderr };
        } finally {
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", kill);
        }
    }
}
