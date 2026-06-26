import { describe, it, expect, vi } from "vitest";
import { buildSubagentExecute } from "./dispatch.js";

describe("buildSubagentExecute", () => {
	it("returns a function", () => {
		const execute = buildSubagentExecute(3);
		expect(typeof execute).toBe("function");
	});

	it("returns content for chain mode dispatch", async () => {
		const execute = buildSubagentExecute(3);
		const result = await execute("call-1", {
			chain: [{ agent: "scout", task: "find files" }],
		} as any, undefined, vi.fn(), {
			cwd: "/tmp",
			hasUI: false,
			ui: {} as any,
		} as any);
		expect(result).toHaveProperty("content");
	});

	it("returns content for single mode dispatch", async () => {
		const execute = buildSubagentExecute(3);
		const result = await execute("call-1", {
			agent: "scout",
			task: "find files",
		} as any, undefined, vi.fn(), {
			cwd: "/tmp",
			hasUI: false,
			ui: {} as any,
		} as any);
		expect(result).toHaveProperty("content");
	});
});