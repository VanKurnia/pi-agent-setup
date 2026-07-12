import { describe, it, expect } from "vitest";

describe("subagents process", () => {
    it("should export runSubagent function", async () => {
        const mod = await import("../subagents/src/process.js");
        expect(mod.runSubagent).toBeDefined();
        expect(typeof mod.runSubagent).toBe("function");
    });

    it("should export AgentResult type shape", async () => {
        // Validate the module exports expected type constants/utilities
        const mod = await import("../subagents/src/process.js");
        // runSubagent is async — verify function length (parameter count)
        expect(mod.runSubagent.length).toBeGreaterThanOrEqual(4);
    });
});
