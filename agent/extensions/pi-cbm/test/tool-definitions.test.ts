import { describe, expect, it } from "vitest";
import { toolDefinitions } from "../src/pi-tools/definitions.js";

describe("tool definitions", () => {
    it("exposes get_file_outline", () => {
        expect(toolDefinitions.map((d) => d.name)).toContain("get_file_outline");
    });

    it("has unique tool names and non-empty guidelines", () => {
        const names = toolDefinitions.map((d) => d.name);
        expect(new Set(names).size).toBe(names.length);
        expect(toolDefinitions.length).toBe(15);
        for (const definition of toolDefinitions) {
            expect(definition.promptGuidelines.length).toBeGreaterThan(0);
            expect(definition.description.length).toBeGreaterThan(20);
        }
    });

    it("never declares a format parameter", () => {
        for (const definition of toolDefinitions) {
            const properties =
                (definition.parameters as { properties?: Record<string, unknown> }).properties ??
                {};
            expect(Object.keys(properties)).not.toContain("format");
        }
    });
});
