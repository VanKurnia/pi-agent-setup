import { discoverAgents } from "./src/config.js";
import { getAgents } from "./src/registry.js";
import { executeChain, executeHybrid, executeParallel, executeSingle } from "./src/execute.js";
import type { AgentScope } from "./src/types.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "./src/settings.js";

/** Built-in thinking default per agent. Unlisted agents inherit the model default. */
export function defaultThinkingForAgent(name: string): ThinkingLevel | undefined {
    if (name === "worker") return "high";
    if (name === "scout") return "low";
    return undefined;
}

export function buildSubagentExecute(maxConcurrency: number, settings?: SettingsManager) {
    return async (
        _toolCallId: string,
        params: any,
        signal: AbortSignal | undefined,
        onUpdate: any,
        ctx: any,
    ) => {
        const cwd = ctx.cwd;
        const agentScope: AgentScope = params.agentScope ?? "user";
        const confirmProjectAgents = params.confirmProjectAgents ?? true;

        // Discover agents once, share across confirmation + dispatch
        let { agents } = discoverAgents(ctx.cwd, agentScope);

        // Merge dynamically registered agents (from cross-extension API)
        // Dynamic registrations intentionally override file-based agents
        const dynamicAgents = getAgents();
        if (dynamicAgents.length > 0) {
            const agentMap = new Map<string, any>();
            for (const a of agents) agentMap.set(a.name, a);
            for (const a of dynamicAgents) agentMap.set(a.name, a);
            agents = Array.from(agentMap.values());
        }

        // Apply per-agent model and thinking overrides from settings
        if (settings) {
            settings.load();
            const overrides = settings.getAllAgentModels();
            const agentThinking = settings.getAllAgentThinking();
            if (Object.keys(overrides).length > 0 || Object.keys(agentThinking).length > 0) {
                agents = agents.map((a) => ({
                    ...a,
                    model: overrides[a.name] ?? a.model,
                    thinkingLevel:
                        agentThinking[a.name] ?? defaultThinkingForAgent(a.name) ?? a.thinkingLevel,
                }));
            } else {
                agents = agents.map((a) => ({
                    ...a,
                    thinkingLevel: defaultThinkingForAgent(a.name) ?? a.thinkingLevel,
                }));
            }
        }

        // Confirm project agents if needed
        if (
            (agentScope === "project" || agentScope === "both") &&
            confirmProjectAgents &&
            ctx.hasUI
        ) {
            const requestedAgentNames = new Set<string>();
            if (params.chain) for (const s of params.chain) requestedAgentNames.add(s.agent);
            if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
            if (params.agent) requestedAgentNames.add(params.agent);
            if (params.hybrid) {
                for (const phase of params.hybrid) {
                    if (phase.mode === "single") {
                        requestedAgentNames.add(phase.agent);
                    } else {
                        for (const t of phase.tasks) {
                            requestedAgentNames.add(t.agent);
                        }
                    }
                }
            }

            if (requestedAgentNames.size > 0) {
                const projectAgentsRequested = Array.from(requestedAgentNames)
                    .map((name) => agents.find((a) => a.name === name))
                    .filter((a): a is any => a?.source === "project");

                if (projectAgentsRequested.length > 0) {
                    const names = projectAgentsRequested.map((a: any) => a.name).join(", ");
                    const ok = await ctx.ui.confirm(
                        "Run project-local agents?",
                        `Agents: ${names}\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
                    );
                    if (!ok) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Canceled: project-local agents not approved.",
                                },
                            ],
                            details: { mode: "single" as const, results: [], agentScope },
                        };
                    }
                }
            }
        }

        // Dispatch: hybrid, chain, parallel, single.
        // Read concurrency live: the wizard can change it after registration.
        const effectiveConcurrency = settings?.maxConcurrent ?? maxConcurrency;
        if (params.hybrid && params.hybrid.length > 0) {
            return executeHybrid(
                params.hybrid,
                effectiveConcurrency,
                cwd,
                signal,
                ctx,
                onUpdate,
                agentScope,
                agents,
            );
        } else if (params.chain && params.chain.length > 0) {
            return executeChain(
                params.chain,
                effectiveConcurrency,
                cwd,
                signal,
                ctx,
                onUpdate,
                agentScope,
                agents,
            );
        } else if (params.tasks && params.tasks.length > 0) {
            return executeParallel(
                params.tasks,
                effectiveConcurrency,
                cwd,
                signal,
                ctx,
                onUpdate,
                agentScope,
                agents,
            );
        } else if (params.agent && params.task) {
            return executeSingle(
                params.agent,
                params.task,
                params.cwd ?? cwd,
                signal,
                ctx,
                onUpdate,
                agentScope,
                agents,
                params.title,
            );
        } else {
            const available = agents.map((a) => a.name).join(", ") || "none";
            throw new Error(
                `Provide hybrid[], chain[], agent+task (single), or tasks[] (parallel). Available agents: ${available}`,
            );
        }
    };
}
