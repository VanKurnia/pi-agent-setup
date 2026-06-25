import { describe, it, expect } from "vitest";
import { executeChain } from "../subagents/src/execute.js";

describe("chain mode", () => {
	it("throws for unknown agent", async () => {
		await expect(
			executeChain(
				[{ agent: "nonexistent-subagent", task: "test task" }],
				4, "/tmp", undefined, {}, undefined,
			),
		).rejects.toThrow("Unknown agent");
	});

	it("throws for multiple unknown agents", async () => {
		await expect(
			executeChain(
				[
					{ agent: "bad-agent-a", task: "first" },
					{ agent: "bad-agent-b", task: "second" },
				],
				4, "/tmp", undefined, {}, undefined,
			),
		).rejects.toThrow("Unknown agent");
	});

	it("agent validation passes for known agents (process may still fail)", async () => {
		// If agent lookup fails, this throws "Unknown agent".
		// If lookup succeeds, runSubagent is called which returns an error result
		// (not a thrown exception) because it runs in a fork worker context.
		const result = await executeChain(
			[{ agent: "scout", task: "brief test" }],
			4, process.cwd(), undefined, {}, undefined,
		);
		// Agent validation passed — we got a result, not a thrown "Unknown agent"
		expect(result).toHaveProperty("details");
		expect(result.details.mode).toBe("chain");
		expect(result.details.results).toHaveLength(1);
	});

	it("empty chain returns empty result", async () => {
		const result = await executeChain([], 4, process.cwd(), undefined, {}, undefined);
		expect(result).toHaveProperty("details");
		expect(result.details.results).toHaveLength(0);
	});
});
