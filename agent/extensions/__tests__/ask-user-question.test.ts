import { describe, it, expect } from "vitest";
import {
	normalizeOptions,
	formatAnswerForModel,
	sortAnswers,
	buildStructuredResult,
	buildResult,
	cancelledResult,
	unavailableResult,
} from "../ask-user-question.js";

describe("normalizeOptions", () => {
	it("trims labels and values", () => {
		const result = normalizeOptions([{ label: "  Option A  ", value: "  a  " }]);
		expect(result[0].label).toBe("Option A");
		expect(result[0].value).toBe("a");
	});

	it("uses label as default value", () => {
		const result = normalizeOptions([{ label: "Option A" }]);
		expect(result[0].value).toBe("Option A");
	});

	it("filters out empty labels", () => {
		const result = normalizeOptions([{ label: "" }, { label: "Valid" }, { label: "  " }]);
		expect(result).toHaveLength(1);
	});

	it("handles undefined options", () => {
		expect(normalizeOptions(undefined)).toEqual([]);
	});

	it("handles empty options array", () => {
		expect(normalizeOptions([])).toEqual([]);
	});

	it("strips description whitespace", () => {
		const result = normalizeOptions([{ label: "A", description: "  desc  " }]);
		expect(result[0].description).toBe("desc");
	});

	it("omits empty description", () => {
		const result = normalizeOptions([{ label: "A", description: "" }]);
		expect(result[0].description).toBeUndefined();
	});
});

describe("formatAnswerForModel", () => {
	it("formats text answer", () => {
		expect(formatAnswerForModel({ type: "text", label: "hello", value: "hello" })).toBe("hello");
	});

	it("formats option answer with index", () => {
		expect(formatAnswerForModel({ type: "option", label: "Option A", value: "a", index: 1 })).toBe("1. Option A");
	});

	it("formats other answer", () => {
		expect(formatAnswerForModel({ type: "other", label: "custom", value: "custom" })).toBe("Other: custom");
	});
});

describe("sortAnswers", () => {
	it("sorts options by index, others after, text last", () => {
		const answers = [
			{ type: "text" as const, label: "abc", value: "abc" },
			{ type: "option" as const, label: "B", value: "b", index: 2 },
			{ type: "option" as const, label: "A", value: "a", index: 1 },
			{ type: "other" as const, label: "other", value: "other" },
		];
		const sorted = sortAnswers(answers);
		expect(sorted[0].label).toBe("A");
		expect(sorted[1].label).toBe("B");
		expect(sorted[2].label).toBe("other");
		expect(sorted[3].label).toBe("abc");
	});

	it("returns empty array for empty input", () => {
		expect(sortAnswers([])).toEqual([]);
	});
});

describe("buildResult", () => {
	it("builds single-select result", () => {
		const result = buildResult("Test question", undefined, "single-select", [
			{ type: "option", label: "Option A", value: "a", index: 1 },
		]);
		expect(result.content[0].text).toContain("User selected");
		expect(result.content[0].text).toContain("Option A");
		expect(result.details.status).toBe("answered");
	});

	it("builds multi-select result", () => {
		const result = buildResult("Test", undefined, "multi-select", [
			{ type: "option", label: "A", value: "a", index: 1 },
			{ type: "option", label: "B", value: "b", index: 2 },
		]);
		expect(result.content[0].text).toContain("User selected:");
		expect(result.content[0].text).toContain("A");
		expect(result.content[0].text).toContain("B");
	});

	it("builds text result", () => {
		const result = buildResult("Test", undefined, "text", [
			{ type: "text", label: "user typed this", value: "user typed this" },
		]);
		expect(result.content[0].text).toContain("User answered");
		expect(result.content[0].text).toContain("user typed this");
	});

	it("includes context in details", () => {
		const result = buildResult("Q", "some context", "text", [
			{ type: "text", label: "a", value: "a" },
		]);
		expect(result.details.context).toBe("some context");
	});
});

describe("cancelledResult", () => {
	it("returns cancelled status with message", () => {
		const result = cancelledResult("Question?", "single-select");
		expect(result.details.status).toBe("cancelled");
		expect(result.details.question).toBe("Question?");
		expect(result.content[0].text).toBe("User cancelled the question");
	});
});

describe("unavailableResult", () => {
	it("returns unavailable status with custom message", () => {
		const result = unavailableResult("Q?", "text", "No UI available");
		expect(result.details.status).toBe("unavailable");
		expect(result.content[0].text).toBe("No UI available");
	});
});
