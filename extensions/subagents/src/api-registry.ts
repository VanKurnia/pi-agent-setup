const registry = new Map<string, unknown>();

/** Register a cross-extension API. Throws on duplicate name. */
export function registerExtensionApi<T>(name: string, api: T): void {
    if (registry.has(name)) {
        throw new Error(`Extension API '${name}' is already registered`);
    }
    registry.set(name, api);
}

/** Retrieve a registered cross-extension API. Returns undefined if not registered. */
export function getExtensionApi<T>(name: string): T | undefined {
    return registry.get(name) as T | undefined;
}
