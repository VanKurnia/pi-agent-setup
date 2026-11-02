/**
 * herdr-filechanges — the **herdr-app frontend** of the log.
 *
 * The log itself lives in `shared/filechanges-core.ts`; this file publishes a
 * snapshot that `~/.config/herdr-app/mods/herdr-filechanges/` draws in the
 * sidebar:
 *
 *   ~/.config/herdr-app/data/herdr-filechanges/<terminal>.json
 *
 * Boot cost is deliberately ~0: nothing is imported at module level. The core
 * (tracking + session entries + accept/decline) and the publisher load on
 * `session_start`, which fires before any tool call, so the writer still sees
 * the "before" content of the very first edit. Without `HC_TERMINAL_ID` there
 * is no herdr to publish to and no publisher is ever loaded.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FileChangeCore } from "../shared/filechanges-core.ts";

/** Coalesce a burst of tool results into one write. */
const SETTLE_MS = 80;

export default function (pi: ExtensionAPI) {
    const terminal = process.env.HC_TERMINAL_ID;

    let cwd = process.cwd();
    let core: FileChangeCore | null = null;
    let loading: Promise<FileChangeCore> | null = null;
    let publisher: ((core: FileChangeCore, terminal: string, cwd: string) => Promise<void>) | null =
        null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load(): Promise<FileChangeCore> {
        if (core) return core;
        loading ??= (async () => {
            const [coreModule, publishModule] = await Promise.all([
                import("../shared/filechanges-core.ts"),
                import("./publish.ts"),
            ]);
            publisher = publishModule.publish;
            core = coreModule.installFileChangeCore(pi, { owner: "herdr", onChange: () => settle() });
            return core;
        })();
        return loading;
    }

    function settle(): void {
        if (!terminal) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void publish();
        }, SETTLE_MS);
    }

    async function publish(): Promise<void> {
        if (!terminal || !core || !publisher) return;
        await publisher(core, terminal, cwd);
    }

    // Installing the core here means a reload re-registers it even when the TUI
    // frontend is disabled — the log must not depend on which frontend is on.
    pi.on("session_start", async (_event, ctx) => {
        cwd = ctx.cwd;
        const installed = await load();
        // Registered during this very event, so its own rebuild has not run yet.
        await installed.rebuildFromSession(ctx);
        await publish();
    });

    pi.on("session_tree", async (_event, ctx) => {
        cwd = ctx.cwd;
        await load();
        await publish();
    });

    // Any tool call is a chance a file changed outside pi (deleted, reverted, a git
    // checkout). Republish then: publish() re-reads every tracked file from disk.
    pi.on("tool_result", async () => settle());

    pi.on("session_shutdown", async () => {
        if (timer) clearTimeout(timer);
        timer = null;
    });
}
