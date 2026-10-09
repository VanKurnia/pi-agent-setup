/**
 * API that the filechanges extension exposes to other extensions.
 *
 * Owner: `agent/extensions/filechanges/index.ts` registers this via
 * `registerExtensionApi("filechanges", ...)` (see `./cross-extension-api.js`).
 * Consumers resolve it with `getExtensionApi<FilechangesApi>("filechanges")`.
 * The interface lives here (not in any consumer) so providers and consumers
 * never import across sibling extension directories.
 */
export interface FilechangesApi {
    trackFile: (
        ctx: any,
        relPath: string,
        absPath: string,
        originalContent: string | null,
    ) => Promise<void>;
}
