
import type { AgentConfig } from "./types.js";

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

// Expose registration functions globally so other extensions loaded via jiti
// (which creates separate module instances) can access the shared agents array.
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent };
