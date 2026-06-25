import { describe, it, expect } from "vitest";
import { getReadOnlyToolNames, applyReadOnlyTools, restoreTools } from "../zz-read-only-mode.js";

// Mock pi's ExtensionAPI minimally for testing
function createMockPi(tools: string[], activeTools: string[]) {
	const active = new Set(activeTools);
	return {
		getAllTools: () => tools.map(name => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.clear();
			names.forEach(n => active.add(n));
		},
	} as any;
}

describe("getReadOnlyToolNames", () => {
	it("returns only read tools that exist", () => {
		const pi = createMockPi(["read", "bash", "write", "grep", "edit", "find", "ls"], []);
		const names = getReadOnlyToolNames(pi);
		expect(names).toEqual(["read", "grep", "find", "ls"]);
	});

	it("handles missing tools gracefully", () => {
		const pi = createMockPi(["bash", "write", "edit"], []);
		const names = getReadOnlyToolNames(pi);
		expect(names).toEqual([]);
	});

	it("handles empty tool registry", () => {
		const pi = createMockPi([], []);
		const names = getReadOnlyToolNames(pi);
		expect(names).toEqual([]);
	});
});

describe("applyReadOnlyTools", () => {
	it("sets active tools to the read-only subset", () => {
		const pi = createMockPi(["read", "bash", "write", "grep", "edit", "find", "ls"], ["read", "bash", "write"]);
		applyReadOnlyTools(pi);
		expect(pi.getActiveTools()).toEqual(["read", "grep", "find", "ls"]);
	});
});

describe("restoreTools", () => {
	it("restores previously active tools", () => {
		const pi = createMockPi(["read", "bash", "write", "grep", "find"], ["read"]);
		const before = ["read", "bash", "write"];
		restoreTools(pi, before);
		expect(pi.getActiveTools()).toEqual(["read", "bash", "write"]);
	});

	it("filters out tools that no longer exist", () => {
		const pi = createMockPi(["read", "grep", "find"], []);
		restoreTools(pi, ["read", "deleted-tool", "write"]);
		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	it("uses all tools when no previous state given", () => {
		const pi = createMockPi(["read", "bash", "write", "grep"], []);
		restoreTools(pi);
		expect(pi.getActiveTools()).toEqual(["read", "bash", "write", "grep"]);
	});
});
