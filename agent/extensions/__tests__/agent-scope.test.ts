import { describe, it, expect } from "vitest";
import { discoverAgents, findNearestProjectAgentsDir } from "../subagents/src/config.js";

describe("agent scope", () => {
	it("user scope returns user agents", () => {
		const { agents } = discoverAgents(process.cwd(), "user");
		expect(agents.every((a) => a.source === "user" || a.source === undefined)).toBe(true);
	});

	it("project scope returns empty for non-pi projects", () => {
		const { agents } = discoverAgents("/nonexistent", "project");
		expect(agents.length).toBe(0);
	});

	it("findNearestProjectAgentsDir returns null in /tmp", () => {
		const dir = findNearestProjectAgentsDir("/tmp");
		expect(dir).toBeNull();
	});

	it("both scope includes user agents for standard paths", () => {
		const { agents } = discoverAgents(process.cwd(), "both");
		// Should find at least the built-in agents
		expect(agents.length).toBeGreaterThan(0);
	});

	it("discovery result includes projectAgentsDir field", () => {
		const result = discoverAgents(process.cwd(), "user");
		expect(result).toHaveProperty("projectAgentsDir");
	});
});
