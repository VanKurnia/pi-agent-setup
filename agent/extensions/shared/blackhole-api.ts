/**
 * Cross-extension contract for blackhole's snapshot provider.
 *
 * Consumers: `agent/extensions/herdr-subagents/session.ts` (+ legacy `agent/extensions/subagents/src/run.ts`) (parent delegation snapshot).
 * Provider:  `agent/extensions/blackhole/index.ts` (registered in the factory).
 *
 * Backed by globalThis on purpose: pi's extension loader builds one jiti instance
 * per extension with `moduleCache: false`, so a module-level registry is a private
 * copy per extension and never crosses the boundary in production. This mirrors
 * the parent-link channel in `cross-extension-api.ts`.
 */

export interface BlackholeSnapshotApi {
    compileVccSummary(input: {
        messages: Array<{ role?: string; content?: unknown }>;
        previousSummary?: string;
        cwd?: string;
        omSummary?: string;
        /** Composed-summary budget in characters; the provider honors it. */
        maxChars?: number;
    }): string;
    buildOmCompactionSummary(sessionId: string): string;
}

const KEY = "__pi_blackhole_snapshot_api";

/** Register (or clear, with `undefined`) the snapshot provider for this process. */
export function setBlackholeSnapshotApi(api: BlackholeSnapshotApi | undefined): void {
    const g = globalThis as Record<string, unknown>;
    if (api) g[KEY] = api;
    else delete g[KEY];
}

/** Resolve the snapshot provider, or `undefined` when blackhole is not loaded. */
export function getBlackholeSnapshotApi(): BlackholeSnapshotApi | undefined {
    const g = globalThis as Record<string, unknown>;
    return g[KEY] as BlackholeSnapshotApi | undefined;
}
