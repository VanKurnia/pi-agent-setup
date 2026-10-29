import net from "node:net";

function socketEndpoint(): string {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) {
        throw new Error("HERDR_SOCKET_PATH is not set; cannot reach herdr.");
    }
    return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

function requestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class HerdrError extends Error {
    code: string;
    constructor(message: string, code: string) {
        super(message);
        this.name = "HerdrError";
        this.code = code;
    }
}

// Method names and shapes below are herdr protocol 22 (herdr 0.9.5). An older
// server answers with unknown-method errors, which surface as a confusing
// dispatch failure instead of an upgrade hint.
const MIN_HERDR_PROTOCOL = 22;

/** Message for an unsupported server protocol, or undefined when compatible. */
export function protocolError(protocol: unknown): string | undefined {
    if (typeof protocol === "number" && protocol >= MIN_HERDR_PROTOCOL) return undefined;
    return `herdr server speaks protocol ${String(protocol)}; subagents need ${MIN_HERDR_PROTOCOL}+ (herdr 0.9.5+). Update herdr and retry.`;
}

/** Why this server cannot be used, or undefined when it speaks a usable protocol. */
export async function herdrProtocolProblem(): Promise<string | undefined> {
    try {
        return protocolError((await callHerdr("ping", {}))?.protocol);
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

function callHerdr(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 8000,
    signal?: AbortSignal,
): Promise<any> {
    return new Promise((resolve, reject) => {
        let endpoint: string;
        try {
            endpoint = socketEndpoint();
        } catch (err) {
            reject(err);
            return;
        }
        const id = requestId();
        let sock: net.Socket;
        try {
            sock = net.createConnection(endpoint);
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }
        let buffer = "";
        let settled = false;
        // Every exit runs the same teardown exactly once; the callback
        // only chooses the outcome.
        const settle = (outcome: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            try {
                sock.destroy();
            } catch {
                // Already gone; nothing to clean up.
            }
            outcome();
        };
        const timer = setTimeout(() => {
            settle(() =>
                reject(
                    new HerdrError(`herdr ${method} timed out waiting for a response.`, "timeout"),
                ),
            );
        }, timeoutMs);
        timer.unref?.();
        const fail = (message: string): void => {
            settle(() => reject(new Error(message)));
        };
        function onAbort(): void {
            settle(() => reject(new HerdrError(`herdr ${method} aborted.`, "aborted")));
        }
        signal?.addEventListener("abort", onAbort);
        if (signal?.aborted) onAbort();
        sock.on("error", (err: Error) =>
            fail(`herdr ${method} failed: ${err?.message ?? String(err)}`),
        );
        sock.on("connect", () => {
            try {
                sock.write(`${JSON.stringify({ id, method, params })}\n`);
            } catch (err) {
                fail(`herdr ${method} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
        sock.on("data", (chunk: Buffer) => {
            if (settled) return;
            buffer += chunk.toString("utf8");
            for (const line of buffer.split("\n")) {
                if (!line.trim()) continue;
                let message: any;
                try {
                    message = JSON.parse(line);
                } catch {
                    continue;
                }
                if (!message || typeof message !== "object" || message.id !== id) continue;
                settle(() => {
                    if (message.error && typeof message.error === "object") {
                        reject(
                            new HerdrError(
                                `herdr ${method} error ${String(message.error.code)}: ${String(message.error.message)}`,
                                String(message.error.code ?? "unknown"),
                            ),
                        );
                    } else {
                        resolve(message.result);
                    }
                });
                return;
            }
        });
    });
}

// Never pass an empty until array: the server matches nothing and
// returns immediately. Resolves true when the state that settled the wait is
// `blocked`, i.e. herdr saw an approval or question dialog.
export async function waitForAgentStatus(
    target: string,
    until: string[],
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<boolean> {
    // A fresh pane has no agent occupant yet, so the server answers
    // agent_not_found immediately instead of waiting. Retry until the
    // child boots; only the cold-boot window pays the 2000 ms granularity,
    // warm paths still resolve in ~1 ms.
    function sleepAbortable(ms: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            function onAbort(): void {
                clearTimeout(timer);
                reject(new HerdrError("herdr agent.wait aborted.", "aborted"));
            }
            signal?.addEventListener("abort", onAbort);
            if (signal?.aborted) onAbort();
        });
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new HerdrError("herdr agent.wait timed out waiting for a response.", "timeout");
        }
        if (signal?.aborted) {
            throw new HerdrError("herdr agent.wait aborted.", "aborted");
        }
        try {
            const result = await callHerdr(
                "agent.wait",
                { target, until, timeout_ms: remaining },
                remaining + 15000,
                signal,
            );
            const status: unknown = result?.agent?.agent_status;
            return status === "blocked";
        } catch (err) {
            if (!(err instanceof HerdrError && err.code === "agent_not_found")) throw err;
            const retryIn = Math.min(2000, deadline - Date.now());
            // No time left: fall through; the loop top throws the timeout.
            if (retryIn > 0) await sleepAbortable(retryIn);
        }
    }
}

/**
 * Share of the target pane to keep so the new pane takes a third of the tab.
 * `ratio` is the target's share, not the newcomer's: splitting a 154-wide
 * pane at 0.33 leaves the caller at 51 and the new pane at 103. Never below
 * half, so later panes cannot shave the caller (the main agent) away.
 */
async function thirdRatio(paneId: string): Promise<number | undefined> {
    try {
        const result: any = await callHerdr("pane.layout", { pane_id: paneId });
        const tabWidth: unknown = result?.layout?.area?.width;
        const paneWidth: unknown = result?.layout?.panes?.find(
            (pane: any) => pane?.pane_id === paneId,
        )?.rect?.width;
        if (typeof tabWidth !== "number" || typeof paneWidth !== "number" || paneWidth <= 0) {
            return undefined;
        }
        return Math.max(0.5, (paneWidth - tabWidth / 3) / paneWidth);
    } catch {
        return undefined;
    }
}

export async function splitPane(cwd: string): Promise<string> {
    const params: Record<string, unknown> = { direction: "right", focus: false, cwd };
    const caller = process.env.HERDR_PANE_ID;
    if (caller) {
        params.target_pane_id = caller;
        // A child takes a third of the tab: one child leaves 2/3 + 1/3, a
        // second lands on 1/3 + 1/3 + 1/3, and recycled panes keep it.
        const ratio = await thirdRatio(caller);
        if (ratio !== undefined) params.ratio = ratio;
    }
    const result: any = await callHerdr("pane.split", params);
    const paneId = result?.pane?.pane_id;
    if (typeof paneId !== "string" || paneId.length === 0) {
        throw new Error(
            `herdr pane split returned no result.pane.pane_id: ${JSON.stringify(result)}`,
        );
    }
    return paneId;
}

export function runInPane(paneId: string, command: string): Promise<void> {
    return callHerdr("pane.send_input", {
        pane_id: paneId,
        text: command,
        keys: ["enter"],
    }).then(() => undefined);
}

export interface PaneState {
    agent?: string;
    agentStatus: string;
}

export function getPane(paneId: string): Promise<PaneState> {
    return callHerdr("pane.get", { pane_id: paneId }).then((result: any) => {
        const pane = result?.pane;
        return { agent: pane?.agent, agentStatus: String(pane?.agent_status) };
    });
}

/**
 * Last rendered lines of the agent in `paneId`, for a blocked report. Best
 * effort: a read failure must not mask the original error.
 */
export async function readAgentTail(paneId: string): Promise<string> {
    try {
        const result = await callHerdr("agent.read", {
            target: paneId,
            source: "recent_unwrapped",
            lines: 40,
        });
        const text: unknown = result?.read?.text;
        return typeof text === "string" ? `\n--- pane ${paneId} ---\n${text}` : "";
    } catch {
        return "";
    }
}

export interface PaneSummary {
    paneId: string;
    tabId?: string;
    label?: string;
    title?: string;
    agent?: string;
    agentStatus: string;
}

export function listPanes(): Promise<PaneSummary[]> {
    return callHerdr("pane.list", {}).then((result: any) => {
        const panes = result?.panes;
        if (!Array.isArray(panes)) {
            throw new Error(`herdr pane list returned no result.panes: ${JSON.stringify(result)}`);
        }
        return panes.map((pane: any) => ({
            paneId: String(pane?.pane_id),
            tabId: typeof pane?.tab_id === "string" ? pane.tab_id : undefined,
            label: typeof pane?.label === "string" ? pane.label : undefined,
            title:
                typeof pane?.terminal_title_stripped === "string"
                    ? pane.terminal_title_stripped
                    : undefined,
            agent: typeof pane?.agent === "string" ? pane.agent : undefined,
            agentStatus: String(pane?.agent_status),
        }));
    });
}

export function renamePane(paneId: string, label: string): Promise<void> {
    return callHerdr("pane.rename", { pane_id: paneId, label }).then(() => undefined);
}

export function renameAgent(paneId: string, name: string): Promise<void> {
    return callHerdr("agent.rename", { target: paneId, name }).then(() => undefined);
}

/**
 * Best-effort herdr toast: a blocked or timed-out child is easy to miss while
 * the parent waits on it. `sound: "request"` is the attention variant, and a
 * notification failure must never affect the dispatch.
 */
export async function notifyHerdr(title: string): Promise<void> {
    try {
        await callHerdr("notification.show", { title, sound: "request" });
    } catch {
        // A toast is advisory; the tool result carries the detail.
    }
}

export function closePane(paneId: string): Promise<void> {
    return callHerdr("pane.close", { pane_id: paneId }).then(() => undefined);
}

export interface TabInfo {
    tabId: string;
    label?: string;
}

export async function createTab(
    cwd: string,
    label: string,
    workspaceId?: string,
): Promise<{ tabId: string; rootPaneId: string }> {
    const params: Record<string, unknown> = { cwd, label, focus: false };
    // Without workspace_id herdr drops the tab into the focused workspace,
    // which may not be the parent's. The pane-split fallback never had this
    // problem: it targeted the caller's own pane.
    if (workspaceId) params.workspace_id = workspaceId;
    const result: any = await callHerdr("tab.create", params);
    const tabId = result?.tab?.tab_id;
    const rootPaneId = result?.root_pane?.pane_id;
    if (typeof tabId !== "string" || !tabId || typeof rootPaneId !== "string" || !rootPaneId) {
        throw new Error(
            `herdr tab create returned no tab/root_pane ids: ${JSON.stringify(result)}`,
        );
    }
    return { tabId, rootPaneId };
}

export function listTabs(workspaceId?: string): Promise<TabInfo[]> {
    const params: Record<string, unknown> = workspaceId ? { workspace_id: workspaceId } : {};
    return callHerdr("tab.list", params).then((result: any) => {
        const tabs = result?.tabs;
        if (!Array.isArray(tabs)) {
            throw new Error(`herdr tab list returned no result.tabs: ${JSON.stringify(result)}`);
        }
        return tabs.map((tab: any) => ({
            tabId: String(tab?.tab_id),
            label: typeof tab?.label === "string" ? tab.label : undefined,
        }));
    });
}

// No closeTab wrapper: closing a tab's last pane removes the tab, so closePane suffices.
