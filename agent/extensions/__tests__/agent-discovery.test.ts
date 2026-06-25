import { describe, it, expect } from "vitest";
import { discoverAgents, findNearestProjectAgentsDir, loadAgentsFromDir } from "../subagents/src/config.js";

describe("agent discovery", () => {
	it("returns agents from user directory", () => {
		const { agents } = discoverAgents(process.cwd(), "user");
		expect(agents.length).toBeGreaterThan(0);
		expect(agents.every((a) => a.name && a.description)).toBe(true);
	});

	it("finds built-in agents (scout, researcher, worker)", () => {
		const { agents } = discoverAgents(process.cwd(), "user");
		const names = agents.map((a) => a.name);
		expect(names).toContain("scout");
		expect(names).toContain("researcher");
		expect(names).toContain("worker");
	});

	it("assigns source: user to all discovered agents", () => {
		const { agents } = discoverAgents(process.cwd(), "user");
		for (const a of agents) {
			expect(a.source).toBe("user");
		}
	});

	it("project scope returns empty for non-pi projects", () => {
		const { agents } = discoverAgents("/nonexistent", "project");
		expect(agents.length).toBe(0);
	});

	it("findNearestProjectAgentsDir returns null for /tmp", () => {
		const dir = findNearestProjectAgentsDir("/tmp");
		expect(dir).toBeNull();
	});

	it("loadAgentsFromDir returns empty for non-existent directory", () => {
		const agents = loadAgentsFromDir("/nonexistent-dir-12345", "user");
		expect(agents.length).toBe(0);
	});
});
