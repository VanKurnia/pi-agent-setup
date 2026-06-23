import { describe, it, expect } from "vitest";

describe("bash-guard", () => {
  it("should load the extension module", async () => {
    const mod = await import("./index.ts");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });
});
