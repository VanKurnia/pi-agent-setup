import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileChangeTracker } from "./tracker.js";

// Mock readFile from node:fs/promises to control file content in tests
const mockReadFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
	readFile: mockReadFile,
}));

describe("FileChangeTracker", () => {
	let tracker: FileChangeTracker;

	beforeEach(() => {
		tracker = new FileChangeTracker();
		mockReadFile.mockReset();
	});

	describe("trackFile", () => {
		it("should add a baseline for a new file", async () => {
			mockReadFile.mockResolvedValue("new file content");

			const added = await tracker.trackFile("src/new.ts", "/abs/src/new.ts", null);

			expect(added).toBe(true);
			expect(tracker.hasBaseline("src/new.ts")).toBe(true);
		});

		it("should return false when the file is already tracked", async () => {
			mockReadFile.mockResolvedValue("content");

			await tracker.trackFile("src/file.ts", "/abs/src/file.ts", null);
			const added = await tracker.trackFile("src/file.ts", "/abs/src/file.ts", null);

			expect(added).toBe(false);
		});

		it("should track a new file with kind 'new'", async () => {
			mockReadFile.mockResolvedValue("new file content");

			await tracker.trackFile("src/new.ts", "/abs/src/new.ts", null);

			const tracked = tracker.getTracked("src/new.ts");
			expect(tracked).toBeDefined();
			expect(tracked!.kind).toBe("new");
			expect(tracked!.currentContent).toBe("new file content");
		});

		it("should track an edited file with kind 'edited'", async () => {
			mockReadFile.mockResolvedValue("modified content");

			await tracker.trackFile("src/edit.ts", "/abs/src/edit.ts", "original content");

			const tracked = tracker.getTracked("src/edit.ts");
			expect(tracked).toBeDefined();
			expect(tracked!.kind).toBe("edited");
			expect(tracked!.originalContent).toBe("original content");
			expect(tracked!.currentContent).toBe("modified content");
		});

		it("should not track a file whose content matches baseline", async () => {
			mockReadFile.mockResolvedValue("same content");

			await tracker.trackFile("src/unchanged.ts", "/abs/src/unchanged.ts", "same content");

			expect(tracker.getTrackedSize()).toBe(0);
		});
	});

	describe("recomputeTrackedFile", () => {
		it("should update tracked state when file content changes", async () => {
			mockReadFile.mockResolvedValue("v1");
			await tracker.trackFile("src/file.ts", "/abs/src/file.ts", "original");
			expect(tracker.getTrackedSize()).toBe(1);

			mockReadFile.mockResolvedValue("v2 (updated)");
			await tracker.recomputeTrackedFile("src/file.ts");

			const tracked = tracker.getTracked("src/file.ts");
			expect(tracked).toBeDefined();
			expect(tracked!.currentContent).toBe("v2 (updated)");
		});

		it("should remove tracked entry when file reverts to original", async () => {
			mockReadFile.mockResolvedValue("modified");
			await tracker.trackFile("src/file.ts", "/abs/src/file.ts", "original");
			expect(tracker.getTrackedSize()).toBe(1);

			mockReadFile.mockResolvedValue("original");
			await tracker.recomputeTrackedFile("src/file.ts");

			expect(tracker.getTrackedSize()).toBe(0);
		});

		it("should handle file deletion for an originally-existing file", async () => {
			mockReadFile.mockResolvedValue("modified");
			await tracker.trackFile("src/file.ts", "/abs/src/file.ts", "original");
			expect(tracker.getTrackedSize()).toBe(1);

			mockReadFile.mockRejectedValue(new Error("ENOENT"));
			await tracker.recomputeTrackedFile("src/file.ts");

			const tracked = tracker.getTracked("src/file.ts");
			expect(tracked).toBeDefined();
			expect(tracked!.currentContent).toBe("");
			expect(tracked!.kind).toBe("edited");
		});

		it("should handle newly-created file that gets deleted", async () => {
			mockReadFile.mockResolvedValue("new content");
			await tracker.trackFile("src/new.ts", "/abs/src/new.ts", null);
			expect(tracker.getTrackedSize()).toBe(1);

			mockReadFile.mockRejectedValue(new Error("ENOENT"));
			await tracker.recomputeTrackedFile("src/new.ts");

			expect(tracker.getTrackedSize()).toBe(0);
		});
	});

	describe("pending snapshots", () => {
		it("should store, retrieve, and auto-delete a pending snapshot", () => {
			tracker.setPending("call-1", "src/file.ts", "/abs/src/file.ts", "before content");

			const p = tracker.getPending("call-1");
			expect(p).toBeDefined();
			expect(p!.path).toBe("src/file.ts");
			expect(p!.absPath).toBe("/abs/src/file.ts");
			expect(p!.before).toBe("before content");

			// Should be removed after getPending
			expect(tracker.getPending("call-1")).toBeUndefined();
		});

		it("should delete a pending snapshot without retrieving it", () => {
			tracker.setPending("call-2", "path", "/abs/path", "before");
			tracker.deletePending("call-2");
			expect(tracker.getPending("call-2")).toBeUndefined();
		});

		it("should return undefined for non-existent pending", () => {
			expect(tracker.getPending("nope")).toBeUndefined();
			expect(() => tracker.deletePending("nope")).not.toThrow();
		});
	});

	describe("baseline management", () => {
		it("should report hasBaseline correctly", async () => {
			mockReadFile.mockResolvedValue("content");
			expect(tracker.hasBaseline("f.ts")).toBe(false);

			await tracker.trackFile("f.ts", "/abs/f.ts", null);
			expect(tracker.hasBaseline("f.ts")).toBe(true);
		});

		it("should return baseline via getBaseline", async () => {
			mockReadFile.mockResolvedValue("content");
			await tracker.trackFile("f.ts", "/abs/f.ts", "original");

			const b = tracker.getBaseline("f.ts");
			expect(b).toBeDefined();
			expect(b!.path).toBe("f.ts");
			expect(b!.absPath).toBe("/abs/f.ts");
			expect(b!.originalContent).toBe("original");
		});

		it("should delete baseline and stop tracking", async () => {
			mockReadFile.mockResolvedValue("modified");
			await tracker.trackFile("f.ts", "/abs/f.ts", "original");
			expect(tracker.hasBaseline("f.ts")).toBe(true);
			expect(tracker.getTrackedSize()).toBe(1);

			tracker.deleteBaseline("f.ts");
			expect(tracker.hasBaseline("f.ts")).toBe(false);
			// Note: tracked entry remains until recompute is called
		});

		it("should list all baselines", async () => {
			mockReadFile.mockResolvedValue("content");
			await tracker.trackFile("a.ts", "/abs/a.ts", null);
			await tracker.trackFile("b.ts", "/abs/b.ts", "orig");
			mockReadFile.mockResolvedValue("other");
			await tracker.trackFile("c.ts", "/abs/c.ts", "original");

			const all = tracker.getAllBaselines();
			expect(all).toHaveLength(3);
			expect(all.map((b) => b.path).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
		});
	});

	describe("tracked file access", () => {
		it("should return correct size and entries", async () => {
			mockReadFile.mockResolvedValue("modified");
			await tracker.trackFile("a.ts", "/abs/a.ts", "original");
			await tracker.trackFile("b.ts", "/abs/b.ts", null);

			expect(tracker.getTrackedSize()).toBe(2);

			const all = tracker.getAllTracked();
			expect(all).toHaveLength(2);
			expect(all.map((t) => t.path).sort()).toEqual(["a.ts", "b.ts"]);
		});

		it("should get a specific tracked file by path", async () => {
			mockReadFile.mockResolvedValue("modified");
			await tracker.trackFile("target.ts", "/abs/target.ts", "original");

			const t = tracker.getTracked("target.ts");
			expect(t).toBeDefined();
			expect(t!.absPath).toBe("/abs/target.ts");
		});

		it("should return undefined for non-tracked path", () => {
			expect(tracker.getTracked("nonexistent.ts")).toBeUndefined();
		});

		it("should return 0 size for empty tracker", () => {
			expect(tracker.getTrackedSize()).toBe(0);
			expect(tracker.getAllTracked()).toEqual([]);
		});
	});

	describe("clear", () => {
		it("should clear all state", async () => {
			mockReadFile.mockResolvedValue("modified");
			await tracker.trackFile("a.ts", "/abs/a.ts", "original");
			await tracker.trackFile("b.ts", "/abs/b.ts", null);
			tracker.setPending("call-1", "x.ts", "/x.ts", "before");

			expect(tracker.getTrackedSize()).toBe(2);
			expect(tracker.getAllBaselines()).toHaveLength(2);
			expect(tracker.getPending("call-1")).toBeDefined();

			tracker.clear();

			expect(tracker.getTrackedSize()).toBe(0);
			expect(tracker.getAllBaselines()).toHaveLength(0);
			expect(tracker.getPending("call-1")).toBeUndefined();
		});
	});

	describe("isBackToBaseline", () => {
		it("should return true when content matches original for existing file", async () => {
			mockReadFile.mockResolvedValue("modified");
			await tracker.trackFile("f.ts", "/abs/f.ts", "original");

			expect(tracker.isBackToBaseline("f.ts", "original")).toBe(true);
			expect(tracker.isBackToBaseline("f.ts", "modified")).toBe(false);
		});

		it("should return true when new file does not exist (null content)", async () => {
			mockReadFile.mockResolvedValue("new");
			await tracker.trackFile("new.ts", "/abs/new.ts", null);

			expect(tracker.isBackToBaseline("new.ts", null)).toBe(true);
			expect(tracker.isBackToBaseline("new.ts", "still exists")).toBe(false);
		});

		it("should return false when no baseline exists", () => {
			expect(tracker.isBackToBaseline("none.ts", "content")).toBe(false);
		});
	});

	describe("rebuildFromEntries", () => {
		const makeEntry = (customType: string, data: any) => ({
			type: "custom" as const,
			customType,
			data,
		});

		it("should restore baselines from baseline entries", async () => {
			mockReadFile.mockResolvedValue("current content");

			const entries = [
				makeEntry("filechanges:baseline", { path: "src/a.ts", originalContent: "original" }),
				makeEntry("filechanges:baseline", { path: "src/b.ts", originalContent: null }),
			];

			await tracker.rebuildFromEntries(entries, "/workspace");

			expect(tracker.hasBaseline("src/a.ts")).toBe(true);
			expect(tracker.hasBaseline("src/b.ts")).toBe(true);
			expect(tracker.getBaseline("src/a.ts")!.originalContent).toBe("original");
			expect(tracker.getBaseline("src/b.ts")!.originalContent).toBe(null);
		});

		it("should clear baselines on clear entry", async () => {
			mockReadFile.mockResolvedValue("content");

			const entries = [
				makeEntry("filechanges:baseline", { path: "a.ts", originalContent: "orig" }),
				makeEntry("filechanges:clear", { timestamp: 100 }),
				makeEntry("filechanges:baseline", { path: "b.ts", originalContent: "orig2" }),
			];

			await tracker.rebuildFromEntries(entries, "/workspace");

			expect(tracker.hasBaseline("a.ts")).toBe(false);
			expect(tracker.hasBaseline("b.ts")).toBe(true);
		});

		it("should handle untrack entries", async () => {
			mockReadFile.mockResolvedValue("content");

			const entries = [
				makeEntry("filechanges:baseline", { path: "a.ts", originalContent: "orig" }),
				makeEntry("filechanges:baseline", { path: "b.ts", originalContent: "orig2" }),
				makeEntry("filechanges:untrack", { path: "a.ts" }),
			];

			await tracker.rebuildFromEntries(entries, "/workspace");

			expect(tracker.hasBaseline("a.ts")).toBe(false);
			expect(tracker.hasBaseline("b.ts")).toBe(true);
		});

		it("should recompute tracked files from baselines", async () => {
			mockReadFile.mockResolvedValue("current content");

			const entries = [
				makeEntry("filechanges:baseline", { path: "f.ts", originalContent: "original" }),
			];

			await tracker.rebuildFromEntries(entries, "/workspace");

			expect(tracker.getTrackedSize()).toBe(1);
			const t = tracker.getTracked("f.ts");
			expect(t).toBeDefined();
			expect(t!.currentContent).toBe("current content");
		});

		it("should skip non-custom and unknown entries", async () => {
			const entries = [
				{ type: "message", customType: "something" },
				makeEntry("filechanges:baseline", { path: "f.ts", originalContent: "orig" }),
				{ type: "custom", customType: "unknown:type", data: {} },
			];

			mockReadFile.mockResolvedValue("current");
			await tracker.rebuildFromEntries(entries, "/workspace");

			expect(tracker.hasBaseline("f.ts")).toBe(true);
		});
	});

	describe("diff computation", () => {
		it("should produce a valid diff for an edited file", async () => {
			mockReadFile.mockResolvedValue("line1\nline2\nline3");

			await tracker.trackFile("f.ts", "/abs/f.ts", "line1\nlineX\nline3");

			const t = tracker.getTracked("f.ts");
			expect(t).toBeDefined();
			expect(t!.diff).toContain("@@");
			expect(t!.added).toBeGreaterThanOrEqual(1);
			expect(t!.removed).toBeGreaterThanOrEqual(1);
		});

		it("should produce a diff for a new file", async () => {
			mockReadFile.mockResolvedValue("brand new content");

			await tracker.trackFile("new.ts", "/abs/new.ts", null);

			const t = tracker.getTracked("new.ts");
			expect(t).toBeDefined();
			expect(t!.diff).toContain("@@");
			expect(t!.added).toBeGreaterThan(0);
		});
	});
});
