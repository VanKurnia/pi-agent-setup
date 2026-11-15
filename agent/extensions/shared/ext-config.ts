/** Shared location for extension-owned JSON config, keeping the agent dir root to host-owned files. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function extConfigPath(fileName: string): string {
    return join(getAgentDir(), "ext-config", fileName);
}

/** Writers call this before writing; readers never create anything. */
export function ensureExtConfigDir(): void {
    mkdirSync(join(getAgentDir(), "ext-config"), { recursive: true });
}
