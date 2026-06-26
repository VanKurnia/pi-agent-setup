import { describe, it, expect } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { renderSubagentToolCall, renderSubagentToolResult } from "./render.js";

describe("renderSubagentToolCall", () => {
	it("renders agent with task preview", () => {
		const mockTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `**${text}**`,
		};
		const result = renderSubagentToolCall({
			agent: "scout",
			task: "explore the codebase",
		} as any, mockTheme);
		expect(result).toBeInstanceOf(Text);
		expect(result.render(120).join("")).toContain("scout");
	});

	it("renders chain mode with step count", () => {
		const mockTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `**${text}**`,
		};
		const result = renderSubagentToolCall({
			chain: [{ agent: "scout", task: "step1" }, { agent: "worker", task: "step2" }],
		} as any, mockTheme);
		expect(result).toBeInstanceOf(Text);
		expect(result.render(120).join("")).toContain("2 steps");
	});
});

describe("renderSubagentToolResult", () => {
	it("renders cancelled result", () => {
		const mockTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `**${text}**`,
		};
		const result = renderSubagentToolResult({
			content: [{ type: "text", text: "Cancelled" }],
		}, undefined, mockTheme);
		expect(result).toBeDefined();
	});
});