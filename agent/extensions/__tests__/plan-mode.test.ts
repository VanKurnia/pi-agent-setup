import { describe, it, expect } from "vitest";
import {
	isSafeCommand,
	extractTodoItems,
	markCompletedSteps,
	extractDoneSteps,
	cleanStepText,
} from "../plan-mode/utils.js";
import type { TodoItem } from "../plan-mode/utils.js";

describe("isSafeCommand", () => {
	it('allows "ls -la"', () => {
		expect(isSafeCommand("ls -la")).toBe(true);
	});

	it('allows "cat file.ts"', () => {
		expect(isSafeCommand("cat file.ts")).toBe(true);
	});

	it('allows "grep -r \'foo\' src/"', () => {
		expect(isSafeCommand("grep -r 'foo' src/")).toBe(true);
	});

	it('blocks "rm -rf node_modules"', () => {
		expect(isSafeCommand("rm -rf node_modules")).toBe(false);
	});

	it('blocks "sudo apt update"', () => {
		expect(isSafeCommand("sudo apt update")).toBe(false);
	});

	it('blocks "npm install express"', () => {
		expect(isSafeCommand("npm install express")).toBe(false);
	});

	it('allows "git status"', () => {
		expect(isSafeCommand("git status")).toBe(true);
	});

	it('blocks "git add ."', () => {
		expect(isSafeCommand("git add .")).toBe(false);
	});

	it('allows "npm list"', () => {
		expect(isSafeCommand("npm list")).toBe(true);
	});

	it('blocks "mv file dest"', () => {
		expect(isSafeCommand("mv file dest")).toBe(false);
	});

	it('blocks "cp -r src dest"', () => {
		expect(isSafeCommand("cp -r src dest")).toBe(false);
	});

	it('blocks "mkdir newdir"', () => {
		expect(isSafeCommand("mkdir newdir")).toBe(false);
	});

	it('allows "pwd"', () => {
		expect(isSafeCommand("pwd")).toBe(true);
	});

	it('allows "echo hello"', () => {
		expect(isSafeCommand("echo hello")).toBe(true);
	});

	it('allows "whoami"', () => {
		expect(isSafeCommand("whoami")).toBe(true);
	});

	it('allows "diff file1 file2"', () => {
		expect(isSafeCommand("diff file1 file2")).toBe(true);
	});

	it('allows "curl https://example.com"', () => {
		expect(isSafeCommand("curl https://example.com")).toBe(true);
	});

	it('allows "jq . file.json"', () => {
		expect(isSafeCommand("jq . file.json")).toBe(true);
	});

	it('blocks "git commit -m msg"', () => {
		expect(isSafeCommand("git commit -m msg")).toBe(false);
	});

	it('blocks "git push origin main"', () => {
		expect(isSafeCommand("git push origin main")).toBe(false);
	});

	it('allows "git log --oneline"', () => {
		expect(isSafeCommand("git log --oneline")).toBe(true);
	});

	it('allows "git diff"', () => {
		expect(isSafeCommand("git diff")).toBe(true);
	});

	it('allows "npm ls"', () => {
		expect(isSafeCommand("npm ls")).toBe(true);
	});

	it('allows "npm view express"', () => {
		expect(isSafeCommand("npm view express")).toBe(true);
	});

	it('allows "tree src/"', () => {
		expect(isSafeCommand("tree src/")).toBe(true);
	});

	it('allows "which node"', () => {
		expect(isSafeCommand("which node")).toBe(true);
	});

	it('allow "sed -n \'1,5p\' file"', () => {
		expect(isSafeCommand("sed -n '1,5p' file")).toBe(true);
	});

	it('blocks "sed -i \'s/foo/bar/\' file"', () => {
		// sed -i should NOT match the safe pattern (only sed -n is safe)
		expect(isSafeCommand("sed -i 's/foo/bar/' file")).toBe(false);
	});

	it('blocks "vim file.ts"', () => {
		expect(isSafeCommand("vim file.ts")).toBe(false);
	});

	it('blocks "code ."', () => {
		expect(isSafeCommand("code .")).toBe(false);
	});
});

describe("cleanStepText", () => {
	it("removes markdown bold", () => {
		expect(cleanStepText("**Do something**")).toBe("Do something");
	});

	it("removes leading verbs", () => {
		expect(cleanStepText("Run the tests")).toBe("The tests");
	});

	it("removes leading 'Use'", () => {
		expect(cleanStepText("Use the API")).toBe("The API");
	});

	it("capitalizes first letter", () => {
		expect(cleanStepText("check the output")).toBe("Check the output");
	});

	it("truncates long text to 50 chars", () => {
		const long = "a".repeat(100);
		const result = cleanStepText(long);
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result.endsWith("...")).toBe(true);
	});
});

describe("extractDoneSteps", () => {
	it("extracts single DONE markers", () => {
		expect(extractDoneSteps("[DONE:1]")).toEqual([1]);
	});

	it("extracts multiple DONE markers", () => {
		expect(extractDoneSteps("[DONE:1] and [DONE:3]")).toEqual([1, 3]);
	});

	it("returns empty array for no markers", () => {
		expect(extractDoneSteps("no markers here")).toEqual([]);
	});

	it("is case-insensitive", () => {
		expect(extractDoneSteps("[done:2]")).toEqual([2]);
	});
});

describe("extractTodoItems", () => {
	it("extracts items from standard Plan section", () => {
		const msg = "Let me analyze this.\n\nPlan:\n1. First do this\n2. Then do that\n3. Finally do the other";
		const items = extractTodoItems(msg);
		expect(items).toHaveLength(3);
		expect(items[0].step).toBe(1);
		expect(items[0].text).toBeTruthy();
		expect(items[0].completed).toBe(false);
		expect(items[1].step).toBe(2);
		expect(items[2].step).toBe(3);
	});

	it("returns empty array when no Plan header", () => {
		const msg = "Just some text without a plan.";
		expect(extractTodoItems(msg)).toEqual([]);
	});

	it("handles markdown bold in Plan header", () => {
		const msg = "**Plan:**\n1. **Do the thing**\n2. Check results";
		const items = extractTodoItems(msg);
		expect(items).toHaveLength(2);
	});

	it("handles plan items with closing bold", () => {
		const msg = "Plan:\n1. **Install dependencies**\n2. Run **build**";
		const items = extractTodoItems(msg);
		expect(items).toHaveLength(2);
		// Cleaned text should not have markdown bold
		expect(items[0].text).not.toContain("**");
	});

	it("filters out short items", () => {
		const msg = "Plan:\n1. Hi\n2. A longer meaningful step here";
		const items = extractTodoItems(msg);
		expect(items).toHaveLength(1);
	});

	it("filters out items starting with /", () => {
		const msg = "Plan:\n1. /command\n2. A real step";
		const items = extractTodoItems(msg);
		expect(items).toHaveLength(1);
	});
});

describe("markCompletedSteps", () => {
	it("marks steps as completed based on DONE markers", () => {
		const items: TodoItem[] = [
			{ step: 1, text: "First step", completed: false },
			{ step: 2, text: "Second step", completed: false },
			{ step: 3, text: "Third step", completed: false },
		];
		const count = markCompletedSteps("Completed [DONE:1] and [DONE:3]", items);
		expect(count).toBe(2);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(false);
		expect(items[2].completed).toBe(true);
	});

	it("returns 0 for text with no markers", () => {
		const items: TodoItem[] = [
			{ step: 1, text: "First step", completed: false },
		];
		const count = markCompletedSteps("Some response without markers", items);
		expect(count).toBe(0);
		expect(items[0].completed).toBe(false);
	});

	it("does not double-count already completed items", () => {
		const items: TodoItem[] = [
			{ step: 1, text: "First step", completed: true },
		];
		const count = markCompletedSteps("[DONE:1]", items);
		expect(count).toBe(0);
	});

	it("handles no items gracefully", () => {
		const items: TodoItem[] = [];
		const count = markCompletedSteps("[DONE:1]", items);
		expect(count).toBe(0);
	});
});
