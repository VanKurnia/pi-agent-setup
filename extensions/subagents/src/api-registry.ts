const registry = new Map<string, unknown>();

/** Register a cross-extension API. Throws on duplicate name. */
export function registerExtensionApi<T>(name: string, api: T): void {
    // Idempotent: allow re-registration on extension reload (/new, /resume).
    // The module-level Map survives jiti cache across reloads.
    registry.set(name, api);
}

/** Retrieve a registered cross-extension API. Returns undefined if not registered. */
export function getExtensionApi<T>(name: string): T | undefined {
    return registry.get(name) as T | undefined;
}
