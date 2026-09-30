// Per-session render configuration for boxed tool presentation.
//
// Set once per session by the compatibility coordinator; read inside renderers.
// Kept out of the render path (no filesystem/config reads during render).

export interface ToolsRenderConfig {
	maxCollapsedLines: number;
	maxExpandedLines: number;
	dimOutput: boolean;
	showElapsed: boolean;
	/** Open-tree glyph for the done batch header (nerd `\u{F111}` / unicode `●`). */
	batchOpenGlyph: string;
	/** Nerd Font mode is active: file-type icons render in output trees. */
	nerdFonts: boolean;
	/** Collapse a completed turn's tool blocks into one summary line (ADR 0007). */
	collapseAfterTurn: boolean;
	/** Also collapse mutating tools (edit/write/…) into the summary; off keeps them visible. */
	collapseMutatingTools: boolean;
}

let sessionToolsConfig: ToolsRenderConfig = {
	maxCollapsedLines: 10,
	maxExpandedLines: 50,
	dimOutput: false,
	showElapsed: true,
	batchOpenGlyph: "●",
	nerdFonts: false,
	collapseAfterTurn: true,
	collapseMutatingTools: false,
};

export function setToolsRenderConfig(config: Partial<ToolsRenderConfig>): void {
	sessionToolsConfig = { ...sessionToolsConfig, ...config };
}

export function getToolsRenderConfig(): ToolsRenderConfig {
	return sessionToolsConfig;
}

export function getToolsRenderCacheSignature(): string {
	return [
		sessionToolsConfig.maxCollapsedLines,
		sessionToolsConfig.maxExpandedLines,
		sessionToolsConfig.dimOutput ? 1 : 0,
		sessionToolsConfig.showElapsed ? 1 : 0,
		sessionToolsConfig.batchOpenGlyph,
		sessionToolsConfig.nerdFonts ? 1 : 0,
		sessionToolsConfig.collapseAfterTurn ? 1 : 0,
		sessionToolsConfig.collapseMutatingTools ? 1 : 0,
	].join("|");
}

// Wall-clock elapsed tracking through the renderer context state (no tool
// re-registration, so result.details has no execution timing).
//
// Elapsed is computed live from the recorded start on every read, so a running
// tool keeps growing its displayed time. The value only freezes once the
// execution end is recorded (terminal result), which keeps the completed footer
// stable across later re-renders (expand toggles, terminal resizes).

const STARTED_AT_KEY = "__piStyleStartedAt";
const ENDED_AT_KEY = "__piStyleEndedAt";
const RESULT_SEEN_KEY = "__piStyleResultSeen";
const TICKER_KEY = "__piStyleElapsedTicker";

export function recordExecutionStarted(state: Record<string, unknown> | undefined, executionStarted: boolean): void {
	if (!executionStarted || !state || typeof state !== "object") return;
	if (typeof state[STARTED_AT_KEY] !== "number") state[STARTED_AT_KEY] = performance.now();
}

/** Freeze the elapsed at the first terminal render (idempotent). */
export function recordExecutionEnded(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	if (typeof state[ENDED_AT_KEY] !== "number") state[ENDED_AT_KEY] = performance.now();
}

export function getStateElapsedMs(state: Record<string, unknown> | undefined): number | undefined {
	if (!state || typeof state !== "object") return undefined;
	const started = state[STARTED_AT_KEY];
	if (typeof started !== "number") return undefined;
	const ended = state[ENDED_AT_KEY];
	if (typeof ended === "number") return Math.max(0, ended - started);
	return Math.max(0, performance.now() - started);
}

/** Whether a result renderer already produced a continuation for this call. */
export function isResultSeen(state: Record<string, unknown> | undefined): boolean {
	return Boolean(state && typeof state === "object" && state[RESULT_SEEN_KEY] === true);
}

/** Record that a result renderer ran for this call (streaming or final). */
export function markResultSeen(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	state[RESULT_SEEN_KEY] = true;
}

type TickerHandle = ReturnType<typeof setInterval>;

type ElapsedTickerEntry = {
	invalidate: () => void;
};

/** States currently subscribed to the shared elapsed-render ticker. */
const tickerEntries = new Map<Record<string, unknown>, ElapsedTickerEntry>();
let sharedTickerHandle: TickerHandle | undefined;

function ensureSharedTicker(): void {
	if (sharedTickerHandle !== undefined || tickerEntries.size === 0) return;
	sharedTickerHandle = setInterval(() => {
		for (const { invalidate } of tickerEntries.values()) invalidate();
	}, 100) as unknown as TickerHandle;
}

function stopSharedTickerIfIdle(): void {
	if (sharedTickerHandle === undefined || tickerEntries.size > 0) return;
	clearInterval(sharedTickerHandle);
	sharedTickerHandle = undefined;
}

/**
 * While a tool is running, re-render ten times per second so live elapsed labels
 * tick in milliseconds without any output events. Idempotent per state.
 */
export function startElapsedTicker(state: Record<string, unknown> | undefined, invalidate: () => void): void {
	if (!state || typeof state !== "object") return;
	state[TICKER_KEY] = true;
	tickerEntries.set(state, { invalidate });
	ensureSharedTicker();
}

/** Stop a running tool's elapsed ticker (terminal result, error, session end). */
export function stopElapsedTicker(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	delete state[TICKER_KEY];
	tickerEntries.delete(state);
	stopSharedTickerIfIdle();
}

/** Stop every elapsed ticker (session start/shutdown). */
export function stopAllElapsedTickers(): void {
	for (const state of tickerEntries.keys()) delete state[TICKER_KEY];
	tickerEntries.clear();
	stopSharedTickerIfIdle();
}

export function __getElapsedTickerDebugState(): { trackedStates: number; hasSharedTicker: boolean } {
	return { trackedStates: tickerEntries.size, hasSharedTicker: sharedTickerHandle !== undefined };
}
