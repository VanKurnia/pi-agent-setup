/**
 * Session manager — one extension for everything session-related.
 *
 * Registers:
 *   /rclone        — clone current session, always asks for new name first
 *   rename_session — model-callable tool to set the session display name
 *   /workdir       — searchable picker of previous working directories
 *   /session-mgr     — settings menu (cleanup threshold + clean now) + startup auto-clean prompt
 *
 * Each concern lives in its own module; this file only wires them together.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionMgr } from "./cleanup.js";
import { registerClone } from "./rclone.js";
import { registerRename } from "./rename.js";
import { registerWorkdir } from "./workdir.js";

export default function sessionMgr(pi: ExtensionAPI): void {
    registerClone(pi);
    registerRename(pi);
    registerWorkdir(pi);
    registerSessionMgr(pi);
}
