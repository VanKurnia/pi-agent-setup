/**
 * Shared cross-extension API registry.
 *
 * Sharing constraint: pi's extension loader creates one jiti instance per
 * extension with moduleCache:false, so each extension gets a PRIVATE copy
 * of this module. The registry below only shares within a single extension
 * instance — it does NOT cross extension boundaries in production. For
 * state that must cross extensions (or sessions), use the globalThis-backed
 * helpers further down, which are process-wide by construction.
 *
 * Usage (provider side):
 * ```typescript
 * import { registerExtensionApi } from "../shared/cross-extension-api.js";
 * registerExtensionApi("my-api", { doSomething: () => ... });
 * ```
 *
 * Usage (consumer side):
 * ```typescript
 * import { getExtensionApi } from "../shared/cross-extension-api.js";
 * const api = getExtensionApi<MyApi>("my-api");
 * if (api) api.doSomething();
 * ```
 */

const registry = new Map<string, unknown>();

/** Register a cross-extension API. Idempotent — re-registration overwrites. */
export function registerExtensionApi<T>(name: string, api: T): void {
    registry.set(name, api);
}

/** Retrieve a registered cross-extension API. Returns undefined if not registered. */
export function getExtensionApi<T>(name: string): T | undefined {
    return registry.get(name) as T | undefined;
}

// ── Process-wide child->parent session links ─────────────────────────────
// Backed by globalThis, the only state both the dispatching session and the
// child session provably share: neither the module registry above nor plain
// module-level Maps survive the loader's per-extension module isolation, and
// a child session may not load the provider extension at all.
const PARENT_LINK_KEY = "__pi_subagent_parent_links";

function parentLinkStore(): Map<string, unknown> {
    const g = globalThis as Record<string, unknown>;
    let store = g[PARENT_LINK_KEY] as Map<string, unknown> | undefined;
    if (!(store instanceof Map)) {
        store = new Map<string, unknown>();
        g[PARENT_LINK_KEY] = store;
    }
    return store;
}

/** Record which parent session a child subagent session was dispatched from. */
export function setParentLinkGlobal(childSessionId: string, link: unknown): void {
    if (childSessionId) parentLinkStore().set(childSessionId, link);
}

/** Resolve the dispatching parent link for a child session id, if any. */
export function getParentLinkGlobal<T>(childSessionId: string): T | undefined {
    return parentLinkStore().get(childSessionId) as T | undefined;
}

/** Drop a child->parent link. Called when the child session disposes. */
export function deleteParentLinkGlobal(childSessionId: string): void {
    parentLinkStore().delete(childSessionId);
}
