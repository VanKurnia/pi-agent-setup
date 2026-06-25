import type { AgentConfig, SubagentsApi } from "./types.js";
import { registerExtensionApi } from "../../shared/cross-extension-api.js";

// ── Agent Discovery & Registration ────────────────────────────────────

export let agents: AgentConfig[] = [];

export function registerAgent(config: AgentConfig): void {
	if (agents.find((a) => a.name === config.name)) {
		throw new Error(`Agent already registered: ${config.name}`);
	}
	agents.push(config);
}

export function unregisterAgent(name: string): void {
	agents = agents.filter((a) => a.name !== name);
}

export function getAgents() {
    return agents;
}

export function setAgents(newAgents: AgentConfig[]) {
    agents = newAgents;
}

// Expose registration functions via the cross-extension API registry so other
// extensions (loaded via jiti, which creates separate module instances) can
// access the shared agents array.
registerExtensionApi<SubagentsApi>("subagents", { registerAgent, unregisterAgent });
