// Shared context/view types + common helpers for the boxed tool renderers.

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../../shared/box.js";
import {
	boxedToolWidthKey,
	clearCompactBoxedFooter,
	formatBoxedFooter,
	formatBoxedFooterFromValues,
	getTextOutput,
	renderCompactBoxedFooter,
	renderCompactBoxedToolCall,
	resolveRelativePath,
	shortenPath,
	themeCacheKey,
} from "../../../shared/box.js";
import {
	getStateElapsedMs,
	getToolsRenderCacheSignature,
	isResultSeen,
	markResultSeen,
	recordExecutionEnded,
	recordExecutionStarted,
	startElapsedTicker,
	stopElapsedTicker,
} from "./session-config.js";

/** Renderer context delivered by Pi's ToolExecutionComponent (getRenderContext). */
export interface BoxedToolContext {
	readonly args: Record<string, unknown>;
	readonly toolCallId: string;
	readonly invalidate: () => void;
	readonly state: Record<string, unknown>;
	readonly cwd: string;
	readonly executionStarted: boolean;
	readonly argsComplete: boolean;
	readonly isPartial: boolean;
	readonly expanded: boolean;
	readonly showImages: boolean;
	readonly isError: boolean;
	readonly lastComponent?: unknown;
}

/** Result view delivered to result renderers: { content, details }. */
export interface BoxedToolResult {
	readonly content?: readonly unknown[];
	readonly details?: unknown;
}

export type BoxedCallRenderer = (
	args: Record<string, unknown>,
	theme: BoxTheme,
	context: BoxedToolContext,
) => Component;
export type BoxedResultRenderer = (
	result: BoxedToolResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
) => Component;

export interface BoxedToolDefinition {
	readonly call: BoxedCallRenderer;
	readonly result: BoxedResultRenderer;
}

export function pendingFlag(context: BoxedToolContext): boolean {
	return Boolean(context.isPartial);
}

/** Normalized display path: shortens HOME and resolves relative to the session cwd. */
export function displayPath(rawPath: string, context: BoxedToolContext): string {
	const path = String(rawPath ?? "");
	if (!path) return "(unknown)";
	return shortenPath(resolveRelativePath(path, context.cwd));
}

export function pathRangeDetail(rawPath: string, offset: unknown, limit: unknown, context: BoxedToolContext): string {
	const path = displayPath(rawPath, context);
	let range = "";
	if (offset !== undefined || limit !== undefined) {
		const start = offset ?? 1;
		const end = limit !== undefined ? Number(start) + Number(limit) - 1 : "";
		range = `:${start}${end ? `-${end}` : ""}`;
	}
	return path ? `${path}${range}` : "(unknown)";
}

/** Compact boxed call header for summary-style tools (read/write/ls/find/grep). */
export function compactCall(
	theme: BoxTheme,
	toolName: string,
	detailLine: string,
	options: { detailKey: string; context: BoxedToolContext },
): Component {
	return renderCompactBoxedToolCall(theme, toolName, detailLine, {
		widthKey: boxedToolWidthKey(toolName, options.detailKey),
		state: options.context.state,
		isError: Boolean(options.context.isError),
		isPartial: Boolean(options.context.isPartial),
		isPending: pendingFlag(options.context),
		running: Boolean(options.context.executionStarted),
	});
}

/** Record wall-clock start when execution begins (first render with executionStarted). */
export function noteExecutionStart(context: BoxedToolContext): void {
	recordExecutionStarted(context.state, context.executionStarted);
}

/**
 * Keep running/ended execution state in sync from a call renderer pass. While
 * the tool runs, a 1s re-render ticker keeps live elapsed labels current; once
 * the call renders in its terminal form the elapsed freezes.
 */
export function noteBoxedCallState(context: BoxedToolContext): void {
	if (!context.executionStarted) return;
	if (context.isPartial) startElapsedTicker(context.state, context.invalidate);
	else {
		recordExecutionEnded(context.state);
		stopElapsedTicker(context.state);
	}
}

/**
 * Record a result renderer pass and keep the ticker/ended state in sync.
 * Returns whether this is the first result pass for the call, so renderers can
 * render nothing while the pending/running call card stands alone.
 */
export function noteBoxedResultPhase(context: BoxedToolContext, isPartial: boolean): boolean {
	const firstResultPass = !isResultSeen(context.state);
	markResultSeen(context.state);
	if (isPartial) startElapsedTicker(context.state, context.invalidate);
	else {
		recordExecutionEnded(context.state);
		stopElapsedTicker(context.state);
	}
	return firstResultPass;
}

export function stateElapsedMs(context: BoxedToolContext): number | undefined {
	return getStateElapsedMs(context.state);
}

/** State slot a diff result renderer publishes its stats into so the call
 *  renderer can append them to the box header (`path · +3 -0`) on the same
 *  paint. One slot suffices: renderer state is per tool call, and a call never
 *  renders two diffs. */
const DIFF_HEADER_STATS_KEY = "__piStyleDiffHeaderStats";

/** Publish diff stats for the call header (called by settled result renderers). */
export function noteDiffHeaderStats(context: BoxedToolContext, stats: { additions: number; removals: number }): void {
	context.state[DIFF_HEADER_STATS_KEY] = { additions: stats.additions, removals: stats.removals };
}

/** Drop published diff stats (error / no-diff results keep the header clean). */
export function clearDiffHeaderStats(context: BoxedToolContext): void {
	delete context.state[DIFF_HEADER_STATS_KEY];
}

/** Colored `+N -M` diff stats pair: diff colors when nonzero, dim zeros. */
export function formatDiffStatsPair(theme: BoxTheme, additions: number, removals: number): string {
	const plus = additions > 0 ? theme.fg("toolDiffAdded", `+${additions}`) : theme.fg("dim", "+0");
	const minus = removals > 0 ? theme.fg("toolDiffRemoved", `-${removals}`) : theme.fg("dim", "-0");
	return `${plus} ${minus}`;
}

/** ` · +3 -0` header suffix with diff colors, or "" while no stats are
 *  published (pending call / error result). */
export function diffHeaderStatsSuffix(theme: BoxTheme, context: BoxedToolContext): string {
	const stats = context.state[DIFF_HEADER_STATS_KEY] as { additions?: unknown; removals?: unknown } | undefined;
	if (!stats || typeof stats !== "object") return "";
	const additions = Number(stats.additions);
	const removals = Number(stats.removals);
	if (!Number.isFinite(additions) || !Number.isFinite(removals)) return "";
	return ` · ${formatDiffStatsPair(theme, additions, removals)}`;
}

/** Footer parts with state-based elapsed when result.details lacks timing. */
export function boxedFooterWithState(
	theme: BoxTheme,
	result: BoxedToolResult | undefined,
	context: BoxedToolContext,
	extraParts: string[] = [],
): string {
	return formatBoxedFooterFromValues(theme, stateElapsedMs(context), getTextOutput(result), extraParts);
}

export function compactFooterWithState(
	theme: BoxTheme,
	result: BoxedToolResult,
	context: BoxedToolContext,
	options: { isError?: boolean; isPartial?: boolean } = {},
): Component {
	const elapsedMs = stateElapsedMs(context);
	return renderCompactBoxedFooter(theme, result, {
		state: context.state,
		isError: Boolean(options.isError ?? context.isError),
		isPartial: Boolean(options.isPartial ?? context.isPartial),
		...(elapsedMs === undefined ? {} : { elapsedMs }),
	});
}

export function resultFooterLines(
	theme: BoxTheme,
	result: BoxedToolResult,
	context: BoxedToolContext,
	extraParts: string[] = [],
): string[] {
	return [formatBoxedFooter(theme, result, extraParts, stateElapsedMs(context))];
}

type StateComponentCacheEntry = {
	key: string;
	component: Component;
};

/** Cache-key string parts at or below this length join verbatim; longer ones
 *  collapse to `length:hash` so the joined key length stays bounded regardless
 *  of raw output size. */
const CACHE_KEY_LONG_PART_THRESHOLD = 64;

/** 32-bit FNV-1a hash of a string as 8 lowercase hex digits. Local mirror of the
 *  compatibility probe's fingerprint hashing (the pi/ layer stays unreachable
 *  from features): deterministic, collision-safe for cache identity. */
function fnv1aHex(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** Fold one join part: strings longer than CACHE_KEY_LONG_PART_THRESHOLD
 *  collapse to `length:hash`; numbers/booleans pass through unchanged. */
function boundedCacheKeyPart(part: string | number | boolean): string | number | boolean {
	if (typeof part !== "string" || part.length <= CACHE_KEY_LONG_PART_THRESHOLD) return part;
	return `${part.length}:${fnv1aHex(part)}`;
}

export function getRenderCacheKey(prefix: string, theme: BoxTheme, ...parts: Array<string | number | boolean>): string {
	const pieces: Array<string | number | boolean> = [prefix, themeCacheKey(theme), getToolsRenderCacheSignature()];
	for (const part of parts) pieces.push(boundedCacheKeyPart(part));
	return pieces.join("|");
}

export function memoizedStateComponent(
	state: Record<string, unknown> | undefined,
	slot: string,
	key: string,
	build: () => Component,
): Component {
	if (!state || typeof state !== "object") return build();
	const cached = state[slot] as StateComponentCacheEntry | undefined;
	if (cached && cached.key === key) return cached.component;
	const component = build();
	state[slot] = { key, component } satisfies StateComponentCacheEntry;
	return component;
}

export function clearFooterState(context: BoxedToolContext): void {
	clearCompactBoxedFooter(context.state);
}

/** Result-details truncation line count when the native tool truncated output. */
export function truncationOutputLines(result: BoxedToolResult | undefined): number | undefined {
	if (!result) return undefined;
	const details = result.details as { truncation?: { outputLines?: number } } | undefined;
	const value = details?.truncation?.outputLines;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Result-details grep match-limit reached counter. */
export function matchLimitReached(result: BoxedToolResult | undefined): number | undefined {
	if (!result) return undefined;
	const details = result.details as { matchLimitReached?: number } | undefined;
	const value = details?.matchLimitReached;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export { boxedToolWidthKey, getTextOutput, resolveRelativePath, shortenPath };
