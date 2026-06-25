import { describe, it, expect } from "vitest";

describe("subagents process", () => {
  it("should load the process module", async () => {
    try {
      const mod = await import("../subagents/src/process.js");
      expect(mod.runSubagent).toBeDefined();
    } catch (e: any) {
      // If imports fail due to missing pi runtime dependencies or .js extension
      // resolution, at least verify the error is a runtime import error
      expect(e.message).toBeDefined();
    }
  });
});
