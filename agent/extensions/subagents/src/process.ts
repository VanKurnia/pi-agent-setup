import * as fs from "node:fs";
import * as path from "node:path";
import {
    createAgentSession,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    truncateTail,
    getAgentDir,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentProgress, AgentResult } from "./types.js";
import { throttle } from "./utils.js";

function extractTextFromContent(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
    }
    return "";
}

function extractToolArgsPreview(args: Record<string, unknown>): string {
    if (args.command) return String(args.command).slice(0, 100);
    if (args.path) return String(args.path);
    if (args.query) return `"${String(args.query).slice(0, 80)}"`;
    if (args.url) return String(args.url);
    if (args.pattern) return String(args.pattern);
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

export async function runSubagent(
    agent: AgentConfig,
    task: string,
    cwd: string,
    signal: AbortSignal | undefined,
    onUpdate?: (progress: AgentProgress) => void,
    _ctx?: any,
): Promise<AgentResult> {
    const agentDir = getAgentDir();

    // Build model object directly, bypassing ModelRegistry.
    // ModelRegistry.resolveModel() triggers _refreshCurrentModelFromRegistry()
    // via pi-9router-ext's registerProvider call during session startup, which
    // replaces the Agent's model object. Direct construction avoids this.
    let resolvedModel = undefined;
    if (agent.model) {
        const provider = agent.model.slice(0, agent.model.lastIndexOf('/'));
        const id = agent.model.slice(agent.model.lastIndexOf('/') + 1);
        // Read provider config from models.json to get baseUrl and api type
        const modelsJsonPath = path.join(agentDir, 'models.json');
        let providerCfg: any = undefined;
        try {
            const modelsData = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
            if (modelsData.providers?.[provider]) {
                providerCfg = modelsData.providers[provider];
                // Find the specific model definition (may include extra metadata)
                const modelDef = providerCfg.models?.find((m: any) => m.id === id);
                if (modelDef) {
                    resolvedModel = {
                        id,
                        provider,
                        api: providerCfg.api || 'openai-completions',
                        baseUrl: providerCfg.baseUrl,
                        input: modelDef.input || ['text'],
                        contextWindow: modelDef.contextWindow || 128000,
                        maxTokens: modelDef.maxTokens || 64000,
                        reasoning: modelDef.reasoning ?? false,
                    };
                }
            }
        } catch {}
        if (!resolvedModel) {
            // Fallback: construct from string alone
            resolvedModel = {
                id,
                provider,
                api: 'openai-completions',
                baseUrl: 'http://localhost:20128/v1',
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 64000,
                reasoning: false,
            };
        }
    }

    const result: AgentResult = {
        agent: agent.name,
        task,
        output: "",
        exitCode: 0,
        model: agent.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        progress: {
            agent: agent.name,
            status: "running",
            task,
            recentTools: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
            lastMessage: "",
        },
    };

    const startTime = Date.now();
    const progress = result.progress;
    const fireUpdate = throttle(() => {
        progress.durationMs = Date.now() - startTime;
        onUpdate?.(progress);
    }, 150);

    // Create in-process session
    let session: AgentSession;
    try {
        const sessionResult = await createAgentSession({
            cwd,
            agentDir,
            tools: agent.tools.length > 0 ? agent.tools : undefined,
            model: resolvedModel,
            sessionManager: SessionManager.inMemory(cwd), // ponytail: subagents are one-shot, never resumed — in-memory avoids orphaned session .jsonl files
        });
        session = sessionResult.session;
    } catch (err: any) {
        result.exitCode = 1;
        progress.error = `Failed to create session: ${err?.message || String(err)}`;
        progress.status = "failed";
        progress.durationMs = Date.now() - startTime;
        return result;
    }

    // Subscribe to session events for progress
    const unsubscribe = session.subscribe((event) => {
        progress.durationMs = Date.now() - startTime;

        switch (event.type) {
            case "tool_execution_start": {
                progress.toolCount++;
                progress.currentTool = event.toolName;
                progress.currentToolArgs = extractToolArgsPreview(
                    (event.args || {}) as Record<string, unknown>,
                );
                progress.currentToolArgsObj = (event.args || {}) as Record<string, unknown>;
                fireUpdate();
                break;
            }
            case "tool_execution_end": {
                if (progress.currentTool) {
                    progress.recentTools.push({
                        tool: progress.currentTool,
                        args: progress.currentToolArgs || "",
                        argsObj: progress.currentToolArgsObj,
                    });
                    if (progress.recentTools.length > 20) {
                        progress.recentTools.splice(0, progress.recentTools.length - 20);
                    }
                }
                progress.currentTool = undefined;
                progress.currentToolArgs = undefined;
                progress.currentToolArgsObj = undefined;
                fireUpdate();
                break;
            }
            case "agent_end": {
                // Final output from agent
                const lastMsg = event.messages?.[event.messages.length - 1];
                if (lastMsg) {
                    const text = extractTextFromContent((lastMsg as any).content);
                    if (text) result.output = text;
                }
                break;
            }
            case "message_end": {
                if ((event.message as any)?.role === "assistant") {
                    const msg = event.message as any;
                    result.usage.turns++;
                    const u = msg.usage;
                    if (u) {
                        result.usage.input += u.input || 0;
                        result.usage.output += u.output || 0;
                        result.usage.cacheRead += u.cacheRead || 0;
                        result.usage.cacheWrite += u.cacheWrite || 0;
                        result.usage.cost += u.cost?.total || 0;
                        progress.tokens = result.usage.input + result.usage.output;
                    }
                    if (msg.model) result.model = msg.model;
                    if (msg.errorMessage) progress.error = msg.errorMessage;
                    const text = extractTextFromContent(msg.content);
                    if (text) {
                        result.output = text;
                        const proseLines: string[] = [];
                        let inCodeBlock = false;
                        for (const line of text.split("\n")) {
                            if (line.trimStart().startsWith("```")) {
                                inCodeBlock = !inCodeBlock;
                                continue;
                            }
                            if (!inCodeBlock && line.trim()) proseLines.push(line.trim());
                        }
                        if (proseLines.length > 0)
                            progress.lastMessage = proseLines.slice(0, 3).join(" ");
                    }
                }
                fireUpdate();
                break;
            }
        }
    });

    // Wire up abort signal to abort the session
    const abortSession = () => {
        session.abort().catch(() => {});
    };
    if (signal?.aborted) abortSession();
    else signal?.addEventListener("abort", abortSession, { once: true });

    try {
        // Run the agent with the task as prompt
        await session.prompt(task);
    } catch (err: any) {
        result.exitCode = 1;
        progress.error = err?.message || String(err);
        progress.status = "failed";
    } finally {
        unsubscribe();
        signal?.removeEventListener("abort", abortSession);
        session.dispose();
    }

    // Handle abort signal
    if (signal?.aborted) {
        result.exitCode = 1;
        progress.status = "failed";
        progress.error = "Aborted";
    }

    // Determine final status
    if (progress.status !== "failed") {
        progress.status = result.exitCode === 0 && !progress.error ? "completed" : "failed";
    }
    progress.durationMs = Date.now() - startTime;

    // Truncate output if very large
    if (result.output.length > DEFAULT_MAX_BYTES) {
        const trunc = truncateTail(result.output, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
        });
        result.output = trunc.content;
        if (trunc.truncated) {
            result.output = "[Output truncated \u2014 beginning omitted]\n\n" + result.output;
        }
    }

    return result;
}
