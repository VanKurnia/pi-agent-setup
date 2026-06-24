import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, Key, Markdown, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { registerExtensionApi } from "../subagents/src/api-registry.js";
import {
	FileChangeTracker,
	ENTRY_BASELINE,
	ENTRY_CLEAR,
	ENTRY_UNTRACK,
	normalizeToolPath,
	readTextOrNull,
} from "./tracker.js";
import type { FilechangesApi } from "../subagents/src/types.js";

function formatAddedRemovedPlain(added: number, removed: number): string {
	return `(+${added}/-${removed})`;
}

function styleAddedRemovedForList(theme: any, text: string): string {
	// File rows use "+x/-y" as description; other rows use normal sentences.
	const m = text.match(/^\+(\d+)\/\-(\d+)$/);
	if (!m) return theme.fg("muted", text);
	const added = Number(m[1]);
	const removed = Number(m[2]);

	const plus = added === 0 ? theme.fg("text", `+${added}`) : theme.fg("success", `+${added}`);
	const minus = removed === 0 ? theme.fg("text", `-${removed}`) : theme.fg("error", `-${removed}`);
	return plus + theme.fg("text", "/") + minus;
}

function formatStatus(tracker: FileChangeTracker, theme?: any): string | undefined {
	const size = tracker.getTrackedSize();
	if (size === 0) return undefined;
	let edited = 0;
	let created = 0;
	for (const t of tracker.getAllTracked()) {
		if (t.kind === "new") created++;
		else edited++;
	}
	if (!theme) {
		return `Δ ${edited}  + ${created}`;
	}
	return theme.fg("muted", `Δ ${edited}  + ${created}`);
}

function buildWidgetLines(tracker: FileChangeTracker, theme?: any): string[] | undefined {
	const size = tracker.getTrackedSize();
	if (size === 0) return undefined;
	const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
	const max = 8;
	const lines: string[] = [];

	for (const t of items.slice(0, max)) {
		const tag = t.kind === "new" ? "+" : "Δ";

		if (!theme) {
			lines.push(`${tag} ${t.displayPath} ${formatAddedRemovedPlain(t.added, t.removed)}`);
			continue;
		}

		const prefix = theme.fg("muted", `${tag} `) + theme.fg("muted", `${t.displayPath} `);
		let counts: string;
		const plus = t.added === 0 ? theme.fg("text", `+${t.added}`) : theme.fg("success", `+${t.added}`);
		const minus = t.removed === 0 ? theme.fg("text", `-${t.removed}`) : theme.fg("error", `-${t.removed}`);
		counts = theme.fg("text", "(") + plus + theme.fg("text", "/") + minus + theme.fg("text", ")");

		lines.push(prefix + counts);
	}
	if (items.length > max) {
		lines.push(theme ? theme.fg("dim", `…and ${items.length - max} more`) : `…and ${items.length - max} more`);
	}
	return lines;
}

async function ensureParentDir(absPath: string): Promise<void> {
	await mkdir(dirname(absPath), { recursive: true });
}

export default function (pi: ExtensionAPI) {
	const tracker = new FileChangeTracker();

	function updateUi(ctx: any) {
		if (!ctx?.hasUI) return;

		ctx.ui.setStatus("filechanges", formatStatus(tracker, ctx.ui.theme));
		ctx.ui.setWidget("filechanges", buildWidgetLines(tracker, ctx.ui.theme));
	}

	// ── Cross-extension API for subagent file tracking ──────────────

	registerExtensionApi<FilechangesApi>("filechanges", {
		trackFile: async (ctx: any, relPath: string, absPath: string, originalContent: string | null): Promise<void> => {
			const added = await tracker.trackFile(relPath, absPath, originalContent);
			if (added) {
				pi.appendEntry(ENTRY_BASELINE, {
					path: relPath,
					originalContent,
					timestamp: Date.now(),
				});
				updateUi(ctx);
			}
		},
	});

	async function clearLog(ctx: ExtensionCommandContext, reason: "accept" | "decline") {
		tracker.clear();
		pi.appendEntry(ENTRY_CLEAR, { timestamp: Date.now(), reason });
		updateUi(ctx);
	}

	async function declineAll(ctx: ExtensionCommandContext) {
		await ctx.waitForIdle();

		if (tracker.getTrackedSize() === 0) {
			if (ctx.hasUI) ctx.ui.notify("filechanges: nothing to decline.", "info");
			return;
		}

		const force = (ctx as any).args?.includes("force") ?? false;
		if (ctx.hasUI && !force) {
			const ok = await ctx.ui.confirm(
				"Decline pi changes?",
				"This will revert ALL currently logged pi changes (overwrite files / delete created files)."
			);
			if (!ok) return;
		} else if (!ctx.hasUI && !force) {
			throw new Error("Decline requires confirmation. Run: /filechanges-decline force");
		}

		const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
		let reverted = 0;
		const errors: string[] = [];

		for (const item of items) {
			try {
				if (item.originalContent === null) {
					// created file
					await rm(item.absPath, { force: true });
				} else {
					await ensureParentDir(item.absPath);
					await writeFile(item.absPath, item.originalContent, "utf-8");
				}
				reverted++;
			} catch (e: any) {
				errors.push(`${item.displayPath}: ${e?.message ?? String(e)}`);
			}
		}

		await clearLog(ctx, "decline");

		if (ctx.hasUI) {
			if (errors.length === 0) {
				ctx.ui.notify(`filechanges: declined changes for ${reverted} file(s).`, "info");
			} else {
				ctx.ui.notify(
					`filechanges: declined with ${errors.length} error(s). Run /filechanges to inspect; see console for details.`,
					"warning"
				);
				console.warn("[filechanges] decline errors:\n" + errors.join("\n"));
			}
		}
	}

	async function acceptAll(ctx: ExtensionCommandContext) {
		await ctx.waitForIdle();

		if (tracker.getTrackedSize() === 0) {
			if (ctx.hasUI) ctx.ui.notify("filechanges: nothing to accept.", "info");
			return;
		}

		const force = (ctx as any).args?.includes("force") ?? false;
		if (ctx.hasUI && !force) {
			const ok = await ctx.ui.confirm(
				"Accept pi changes?",
				"This will keep current files as-is and clear the modification log."
			);
			if (!ok) return;
		} else if (!ctx.hasUI && !force) {
			throw new Error("Accept requires confirmation. Run: /filechanges-accept force");
		}

		const count = tracker.getTrackedSize();
		await clearLog(ctx, "accept");
		if (ctx.hasUI) ctx.ui.notify(`filechanges: accepted changes for ${count} file(s).`, "info");
	}

	function parseCommandArgs(args: string | undefined): string[] {
		if (!args) return [];
		return args
			.split(/\s+/g)
			.map((s) => s.trim())
			.filter(Boolean);
	}

	// Commands
	pi.registerCommand("filechanges", {
		description: "Show files changed by pi and inspect diffs",
		handler: async (_args, ctx) => {
			(ctx as any).args = parseCommandArgs(_args);

			await ctx.waitForIdle();
			updateUi(ctx);

			if (!ctx.hasUI) {
				const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
				if (items.length === 0) {
					console.log("filechanges: no pi-made modifications recorded.");
					return;
				}
				const lines = buildWidgetLines(tracker) ?? [];
				console.log(lines.join("\n"));
				return;
			}

			// Interactive loop: ESC in diff view returns to the modification log.
			while (true) {
				await ctx.waitForIdle();
				updateUi(ctx);

				const items = tracker.getAllTracked().sort((a, b) => b.updatedAt - a.updatedAt);
				if (items.length === 0) {
					ctx.ui.notify("filechanges: no pi-made modifications recorded.", "info");
					return;
				}

				const selectItems: SelectItem[] = [
					{ value: "__accept__", label: "Accept changes (clear log)", description: "Keep current files" },
					{ value: "__decline__", label: "Undo changes (revert)", description: "Restore original contents" },
					{ value: "__sep__", label: "────────", description: "" },
					...items.map((t) => ({
						value: t.path,
						label: `${t.kind === "new" ? "+" : "Δ"} ${t.displayPath}`,
						description: `+${t.added}/-${t.removed}`,
					})),
				];

				const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Text(theme.fg("accent", theme.bold("File changes")), 1, 0));

					const list = new SelectList(selectItems, Math.min(14, selectItems.length), {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => styleAddedRemovedForList(theme, t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});

					list.onSelect = (item) => {
						if (item.value === "__sep__") return;
						done(item.value);
					};
					list.onCancel = () => done(null);
					container.addChild(list);

					container.addChild(
						new Text(theme.fg("dim", "↑↓ navigate • enter select • esc close"), 1, 0)
					);
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					return {
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							list.handleInput(data);
							tui.requestRender();
						},
					};
				}, { overlay: true });

				if (!picked) return;
				if (picked === "__accept__") {
					await acceptAll(ctx);
					return;
				}
				if (picked === "__decline__") {
					await declineAll(ctx);
					return;
				}

				const t = tracker.getTracked(picked);
				if (!t) {
					ctx.ui.notify("filechanges: entry not found (maybe log was cleared).", "warning");
					continue;
				}

				const md = "```diff\n" + (t.diff.trimEnd() || "(no diff)") + "\n```";
				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Text(theme.fg("accent", theme.bold(t.displayPath)), 1, 0));
					container.addChild(new Markdown(md, 1, 0, getMarkdownTheme()));
					container.addChild(new Text(theme.fg("dim", "esc to go back"), 1, 0));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					return {
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done();
							else tui.requestRender();
						},
					};
				}, { overlay: true });

				// After closing diff, loop back to the modification log.
			}
		},
	});

	pi.registerCommand("filechanges-accept", {
		description: "Accept pi-made changes (keeps files, clears log)",
		handler: async (args, ctx) => {
			(ctx as any).args = parseCommandArgs(args);
			await acceptAll(ctx);
		},
	});

	pi.registerCommand("filechanges-decline", {
		description: "Decline pi-made changes (reverts files, clears log)",
		handler: async (args, ctx) => {
			(ctx as any).args = parseCommandArgs(args);
			await declineAll(ctx);
		},
	});

	async function rebuildFromSession(ctx: any): Promise<void> {
		await tracker.rebuildFromEntries(ctx.sessionManager.getBranch(), ctx.cwd);
		updateUi(ctx);
	}

	// Rebuild state on any session/branch navigation events
	pi.on("session_start", async (_event, ctx) => {
		await rebuildFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await rebuildFromSession(ctx);
	});

	// Capture before snapshots for edit/write
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const { absPath, relPath } = normalizeToolPath(ctx.cwd, event.input.path);
			const before = await readTextOrNull(absPath);
			tracker.setPending(event.toolCallId, relPath, absPath, before);
		}
	});

	// Commit on successful results
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			tracker.deletePending(event.toolCallId);
			return;
		}

		if (!isEditToolResult(event) && !isWriteToolResult(event)) return;

		const pending = tracker.getPending(event.toolCallId);
		if (!pending) return;

		// If no baseline exists yet for this file, create one now from the successful call's snapshot.
		if (!tracker.hasBaseline(pending.path)) {
			await tracker.trackFile(pending.path, pending.absPath, pending.before);
			pi.appendEntry(ENTRY_BASELINE, {
				path: pending.path,
				originalContent: pending.before,
				timestamp: Date.now(),
			});
		} else {
			// Recompute cumulative diff against baseline
			await tracker.recomputeTrackedFile(pending.path);
		}

		// If file is back to baseline, untrack + persist
		if (tracker.hasBaseline(pending.path)) {
			const current = await readTextOrNull(pending.absPath);
			if (current !== undefined && tracker.isBackToBaseline(pending.path, current)) {
				tracker.deleteBaseline(pending.path);
				pi.appendEntry(ENTRY_UNTRACK, { path: pending.path, timestamp: Date.now() });
			}
		}

		updateUi(ctx);
	});
}
