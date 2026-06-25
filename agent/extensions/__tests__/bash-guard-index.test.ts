import { describe, it, expect } from "vitest";

describe("bash-guard", () => {
  it("should load the extension module", { timeout: 15000 }, async () => {
    const mod = await import("../bash-guard/index.js");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });
});
