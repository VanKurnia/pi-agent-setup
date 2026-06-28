import { describe, it, expect } from "vitest";
import { ok, fail } from "../git-toolkit/helpers.js";

describe("ok", () => {
    it("returns a successful tool result with content", () => {
        const result = ok("test message");
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toBe("test message");
        expect(result).not.toHaveProperty("isError");
        expect(result.details).toEqual({});
    });
});

describe("fail", () => {
    it("returns an error tool result", () => {
        const result = fail("something broke");
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe("Error: something broke");
        expect(result.details).toEqual({});
    });
});
