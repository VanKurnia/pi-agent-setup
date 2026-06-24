import { createTwoFilesPatch } from "diff";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

// ── Types ──────────────────────────────────────────────

export type Baseline = {
	path: string;
	absPath: string;
	originalContent: string | null;
	createdAt: number;
};

export type TrackedFile = {
	path: string;
	absPath: string;
	displayPath: string;
	originalContent: string | null;
	currentContent: string;
	diff: string;
	added: number;
	removed: number;
	kind: "new" | "edited";
	updatedAt: number;
};

type PendingSnapshot = {
	path: string;
	absPath: string;
	before: string | null;
};

// ── Entry type constants ───────────────────────────────

export const ENTRY_BASELINE = "filechanges:baseline";
export const ENTRY_CLEAR = "filechanges:clear";
export const ENTRY_UNTRACK = "filechanges:untrack";

// ── Helpers ────────────────────────────────────────────

function stripAtPrefix(p: string): string {
	return p.startsWith("@") ? p.slice(1) : p;
}

function normalizeToolPath(cwd: string, raw: string): { absPath: string; relPath: string } {
	const cleaned = stripAtPrefix(raw);
	const absPath = resolve(cwd, cleaned);
	const rel = relative(cwd, absPath).replace(/\\/g, "/");
	const cleanedNormalized = cleaned.replace(/\\/g, "/");
	const relPath = rel && !rel.startsWith("..") && rel !== "" ? rel : cleanedNormalized;
	return { absPath, relPath };
}

async function readTextOrNull(absPath: string): Promise<string | null> {
	try {
		return await readFile(absPath, "utf-8");
	} catch {
		return null;
	}
}

function countDiffLines(unifiedDiff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of unifiedDiff.split("\n")) {
		if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function patchFromBaseline(displayPath: string, original: string | null, current: string): string {
	return createTwoFilesPatch(displayPath, displayPath, original ?? "", current, "", "", { context: 3 });
}

// ── FileChangeTracker class ────────────────────────────

export class FileChangeTracker {
	private baselines = new Map<string, Baseline>();
	private tracked = new Map<string, TrackedFile>();
	private pendingByToolCallId = new Map<string, PendingSnapshot>();

	// ── Pending snapshot management ──

	setPending(toolCallId: string, path: string, absPath: string, before: string | null): void {
		this.pendingByToolCallId.set(toolCallId, { path, absPath, before });
	}

	/** Returns the pending snapshot and removes it from the map. */
	getPending(toolCallId: string): PendingSnapshot | undefined {
		const p = this.pendingByToolCallId.get(toolCallId);
		this.pendingByToolCallId.delete(toolCallId);
		return p;
	}

	deletePending(toolCallId: string): void {
		this.pendingByToolCallId.delete(toolCallId);
	}

	// ── Baseline access ──

	hasBaseline(relPath: string): boolean {
		return this.baselines.has(relPath);
	}

	getBaseline(relPath: string): Baseline | undefined {
		return this.baselines.get(relPath);
	}

	getAllBaselines(): Baseline[] {
		return [...this.baselines.values()];
	}

	deleteBaseline(relPath: string): void {
		this.baselines.delete(relPath);
	}

	// ── Tracked file access ──

	getTracked(relPath: string): TrackedFile | undefined {
		return this.tracked.get(relPath);
	}

	getAllTracked(): TrackedFile[] {
		return [...this.tracked.values()];
	}

	getTrackedSize(): number {
		return this.tracked.size;
	}

	// ── Core operations ──

	/**
	 * Adds a baseline for the given file and recomputes the tracked diff.
	 * Returns true if a new baseline was created, false if already tracked.
	 */
	async trackFile(relPath: string, absPath: string, originalContent: string | null): Promise<boolean> {
		if (this.baselines.has(relPath)) return false;

		this.baselines.set(relPath, {
			path: relPath,
			absPath,
			originalContent,
			createdAt: Date.now(),
		});

		await this.recomputeTrackedFile(relPath);
		return true;
	}

	/**
	 * Re-reads the file from disk and recomputes the diff against its baseline.
	 */
	async recomputeTrackedFile(relPath: string): Promise<void> {
		const baseline = this.baselines.get(relPath);
		if (!baseline) return;

		const current = await readTextOrNull(baseline.absPath);

		if (baseline.originalContent === null) {
			// File was created (did not exist before)
			if (current === null) {
				this.tracked.delete(relPath);
				return;
			}
			const displayPath = baseline.path;
			const diff = patchFromBaseline(displayPath, null, current);
			const { added, removed } = countDiffLines(diff);
			this.tracked.set(relPath, {
				path: baseline.path,
				absPath: baseline.absPath,
				displayPath,
				originalContent: null,
				currentContent: current,
				diff,
				added,
				removed,
				kind: "new",
				updatedAt: Date.now(),
			});
			return;
		}

		// File existed before
		if (current === null) {
			// Deleted outside of tracked tools (or manually)
			const displayPath = baseline.path;
			const diff = patchFromBaseline(displayPath, baseline.originalContent, "");
			const { added, removed } = countDiffLines(diff);
			this.tracked.set(relPath, {
				path: baseline.path,
				absPath: baseline.absPath,
				displayPath,
				originalContent: baseline.originalContent,
				currentContent: "",
				diff,
				added,
				removed,
				kind: "edited",
				updatedAt: Date.now(),
			});
			return;
		}

		if (current === baseline.originalContent) {
			// Back to original; untrack
			this.tracked.delete(relPath);
			return;
		}

		const displayPath = baseline.path;
		const diff = patchFromBaseline(displayPath, baseline.originalContent, current);
		const { added, removed } = countDiffLines(diff);
		this.tracked.set(relPath, {
			path: baseline.path,
			absPath: baseline.absPath,
			displayPath,
			originalContent: baseline.originalContent,
			currentContent: current,
			diff,
			added,
			removed,
			kind: "edited",
			updatedAt: Date.now(),
		});
	}

	/** Clear all state (baselines, tracked files, pending snapshots). */
	clear(): void {
		this.baselines.clear();
		this.tracked.clear();
		this.pendingByToolCallId.clear();
	}

	/**
	 * Rebuild state from an array of session entries (custom entries).
	 * This is used when loading a session or navigating the session tree.
	 */
	async rebuildFromEntries(entries: any[], cwd: string): Promise<void> {
		this.clear();

		for (const entry of entries) {
			if (entry.type !== "custom") continue;

			if (entry.customType === ENTRY_CLEAR) {
				this.baselines.clear();
				this.tracked.clear();
				continue;
			}

			if (entry.customType === ENTRY_BASELINE) {
				const data = entry.data as any;
				if (!data?.path) continue;
				const { absPath, relPath } = normalizeToolPath(cwd, data.path);
				this.baselines.set(relPath, {
					path: relPath,
					absPath,
					originalContent: typeof data.originalContent === "string" ? data.originalContent : null,
					createdAt: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
				});
				continue;
			}

			if (entry.customType === ENTRY_UNTRACK) {
				const data = entry.data as any;
				if (!data?.path) continue;
				const { relPath } = normalizeToolPath(cwd, data.path);
				this.baselines.delete(relPath);
				this.tracked.delete(relPath);
				continue;
			}
		}

		// Recompute current diffs
		for (const relPath of this.baselines.keys()) {
			await this.recomputeTrackedFile(relPath);
		}
	}

	/** Check whether the file at relPath is back to its baseline content. */
	isBackToBaseline(relPath: string, currentContent: string | null): boolean {
		const baseline = this.baselines.get(relPath);
		if (!baseline) return false;
		return (
			(baseline.originalContent !== null && currentContent === baseline.originalContent) ||
			(baseline.originalContent === null && currentContent === null)
		);
	}
}

// Re-export helper for external use
export { normalizeToolPath, readTextOrNull, countDiffLines, patchFromBaseline };
