import { describe, it, expect, vi } from "vitest";
import registerSubagent from "./register.js";

describe("registerSubagent", () => {
	it("registers a tool with the expected shape", () => {
		const mockPi = {
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
		};
		registerSubagent(mockPi as any);
		expect(mockPi.registerTool).toHaveBeenCalledTimes(1);
		const toolDef = mockPi.registerTool.mock.calls[0][0];
		expect(toolDef).toHaveProperty("name", "subagent");
		expect(toolDef).toHaveProperty("execute");
		expect(toolDef).toHaveProperty("renderCall");
		expect(toolDef).toHaveProperty("renderResult");
		expect(toolDef).toHaveProperty("parameters");
	});

	it("registers the reload-agents command", () => {
		const mockPi = {
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
		};
		registerSubagent(mockPi as any);
		expect(mockPi.registerCommand).toHaveBeenCalledWith(
			"reload-agents",
			expect.objectContaining({
				description: expect.any(String),
				handler: expect.any(Function),
			}),
		);
	});

	it("exports SubagentParams schema", async () => {
		const { SubagentParams } = await import("./register.js");
		expect(SubagentParams).toBeDefined();
	});
});