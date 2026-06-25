/**
 * Shared cross-extension API registry.
 *
 * Pi extensions loaded via jiti share the same module cache for paths
 * that resolve to the same absolute file. By placing this in a neutral
 * location, any extension can import it without coupling to another
 * extension's directory structure.
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
