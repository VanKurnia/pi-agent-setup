import { describe, it, expect } from "vitest";
import { formatToolCall } from "../subagents/src/ui.js";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

// Mock theme.fg: returns `{color}:{text}` for easy assertion
const mockFg = (color: ThemeColor, text: string): string => `${color}:${text}`;

describe("formatToolCall", () => {
	describe("bash", () => {
		it("formats bash commands with $ prefix", () => {
			const result = formatToolCall("bash", "ls -la", mockFg);
			expect(result).toBe("muted:$ toolOutput:ls -la");
		});

		it("truncates long commands", () => {
			const longCmd = "a".repeat(100);
			const result = formatToolCall("bash", longCmd, mockFg);
			expect(result).toContain("...");
			expect(result.length).toBeLessThan(longCmd.length + 50);
		});

		it("handles object args", () => {
			const result = formatToolCall("bash", { command: "npm test" }, mockFg);
			expect(result).toContain("npm test");
		});

		it("handles JSON string args", () => {
			const result = formatToolCall("bash", '{"command":"echo hello"}', mockFg);
			expect(result).toContain("echo hello");
		});
	});

	describe("read", () => {
		it("formats read with path", () => {
			const result = formatToolCall("read", "src/index.ts", mockFg);
			expect(result).toBe("muted:read accent:src/index.ts");
		});

		it("shortens home paths", () => {
			const home = require("node:os").homedir();
			const result = formatToolCall("read", `${home}/project/file.ts`, mockFg);
			expect(result).toContain("~");
			expect(result).not.toContain(home);
		});

		it("formats object args with file_path and offset/limit", () => {
			const result = formatToolCall("read", { file_path: "src/index.ts", offset: 10, limit: 20 }, mockFg);
			expect(result).toContain(":10-29");
		});

		it("formats object args with only offset (no limit)", () => {
			const result = formatToolCall("read", { file_path: "src/index.ts", offset: 10 }, mockFg);
			expect(result).toContain(":10");
		});
	});

	describe("write", () => {
		it("formats write with path", () => {
			const result = formatToolCall("write", "src/new.ts", mockFg);
			expect(result).toContain("write");
			expect(result).toContain("src/new.ts");
		});

		it("shows line count for object args with content", () => {
			const result = formatToolCall("write", { file_path: "src/new.ts", content: "a\nb\nc" }, mockFg);
			expect(result).toContain("3 lines");
		});

		it("handles single-line content without line count", () => {
			const result = formatToolCall("write", { file_path: "src/new.ts", content: "single line" }, mockFg);
			expect(result).not.toContain("lines");
		});
	});

	describe("edit", () => {
		it("formats edit with path", () => {
			const result = formatToolCall("edit", "src/index.ts", mockFg);
			expect(result).toBe("muted:edit accent:src/index.ts");
		});
	});

	describe("ls", () => {
		it("formats ls with path", () => {
			const result = formatToolCall("ls", "src/", mockFg);
			expect(result).toBe("muted:ls accent:src/");
		});
	});

	describe("find / fffind", () => {
		it("formats find with pattern", () => {
			const result = formatToolCall("find", "*.ts", mockFg);
			expect(result).toContain("find");
			expect(result).toContain("*.ts");
		});

		it("aliases fffind to find display", () => {
			const result = formatToolCall("fffind", "*.ts", mockFg);
			expect(result).toContain("find");
		});
	});

	describe("grep / ffgrep", () => {
		it("formats grep with pattern", () => {
			const result = formatToolCall("grep", "function", mockFg);
			expect(result).toContain("grep");
			expect(result).toContain("function");
		});

		it("aliases ffgrep to grep display", () => {
			const result = formatToolCall("ffgrep", "hello", mockFg);
			expect(result).toContain("grep");
		});
	});

	describe("unknown tools", () => {
		it("formats unknown tools with name and args", () => {
			const result = formatToolCall("web_search", "hello world", mockFg);
			expect(result).toContain("web_search");
			expect(result).toContain("hello world");
		});
	});

	describe("edge cases", () => {
		it("handles empty string args", () => {
			const result = formatToolCall("bash", "", mockFg);
			expect(result).toBeDefined();
		});

		it("handles empty object args", () => {
			const result = formatToolCall("bash", {}, mockFg);
			expect(result).toBeDefined();
		});
	});
});
