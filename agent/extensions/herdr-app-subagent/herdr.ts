import net from "node:net";

/**
 * Methods this client needs. A core advertises what it speaks in `hello`;
 * a missing name is an upgrade hint, not a mysterious dispatch failure.
 */
const REQUIRED_METHODS = [
    "terminal.run",
    "terminal.wait",
    "terminal.send",
    "terminal.get",
    "terminal.list",
    "terminal.label",
    "terminal.read",
    "terminal.kill",
    "terminal.rm",
] as const;

/**
 * herdr-core hands every program it starts its own socket. A bare pipe name is
 * accepted too, so a session that exports the short form still works.
 */
function socketEndpoint(): string {
    const endpoint = process.env.HC_TERMINAL_SOCKET;
    if (!endpoint) {
        throw new Error("HC_TERMINAL_SOCKET is not set: this pi was not started by herdr-core.");
    }
    return process.platform === "win32" && !endpoint.startsWith("\\\\")
        ? `\\\\.\\pipe\\${endpoint}`
        : endpoint;
}

/** This session's own terminal address, or undefined outside herdr-core. */
export function callerId(): string | undefined {
    const id = process.env.HC_TERMINAL_ID;
    return typeof id === "string" && id.length > 0 ? id : undefined;
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

/** Why a core cannot be used, or undefined when it speaks everything we call. */
export function protocolProblem(hello: unknown): string | undefined {
    const info = hello as { version?: unknown; methods?: unknown } | null | undefined;
    const methods = Array.isArray(info?.methods)
        ? info.methods.filter((name): name is string => typeof name === "string")
        : [];
    if (methods.length === 0) {
        return `herdr-core ${String(info?.version ?? "unknown")} returned no method list; update herdr-core and retry.`;
    }
    const missing = REQUIRED_METHODS.filter((name) => !methods.includes(name));
    if (missing.length > 0) {
        return `herdr-core ${String(info?.version ?? "unknown")} does not speak ${missing.join(", ")}; update herdr-core and retry.`;
    }
    return undefined;
}

/** Why the running core cannot be used, or undefined when it can. */
export async function herdrProtocolProblem(): Promise<string | undefined> {
    try {
        return protocolProblem(await callHerdr("hello", {}));
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

/**
 * One newline-delimited JSON-RPC call over the core's socket. The connection
 * is per call: replies are matched by id, and the socket is destroyed either
 * way, so a slow method cannot block the next one.
 */
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
                    new HerdrError(
                        `herdr-core ${method} timed out waiting for a response.`,
                        "timeout",
                    ),
                ),
            );
        }, timeoutMs);
        timer.unref?.();
        const fail = (message: string): void => {
            settle(() => reject(new Error(message)));
        };
        function onAbort(): void {
            settle(() => reject(new HerdrError(`herdr-core ${method} aborted.`, "aborted")));
        }
        signal?.addEventListener("abort", onAbort);
        if (signal?.aborted) onAbort();
        sock.on("error", (err: Error) =>
            fail(`herdr-core ${method} failed: ${err?.message ?? String(err)}`),
        );
        sock.on("connect", () => {
            try {
                sock.write(`${JSON.stringify({ id, method, params })}\n`);
            } catch (err) {
                fail(
                    `herdr-core ${method} failed: ${err instanceof Error ? err.message : String(err)}`,
                );
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
                        // The core reports a machine-readable `kind` in data
                        // (unknown_method, not_found, ...); the numeric code
                        // alone says nothing useful.
                        const kind = String(
                            message.error.data?.kind ?? message.error.code ?? "unknown",
                        );
                        reject(
                            new HerdrError(
                                `herdr-core ${method} error ${kind}: ${String(message.error.message)}`,
                                kind,
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

/** The wait's outcome: the word that ended it, and whether it ended at all. */
export interface WaitOutcome {
    ended: boolean;
    reason: string;
    status: string | undefined;
    turn: number;
}

/**
 * Wait until the program stops working. A program that never reported status
 * counts as working until it exits, so this is safe to call right after a
 * launch. `timeoutMs` is converted to the core's seconds.
 */
export async function waitForAgentStatus(
    terminal: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<WaitOutcome> {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const result: any = await callHerdr(
        "terminal.wait",
        { terminal, caller: callerId(), timeout: seconds },
        timeoutMs + 15000,
        signal,
    );
    return {
        ended: result?.ended !== false,
        reason: typeof result?.reason === "string" ? result.reason : "unknown",
        status: typeof result?.status === "string" ? result.status : undefined,
        turn: typeof result?.turn === "number" ? result.turn : 0,
    };
}

/**
 * Start a child and return its address. The task travels as the last argv
 * element: a terminal is a real program, so nothing has to be typed into it
 * after boot.
 */
export async function runTerminal(input: {
    argv: string[];
    cwd: string;
    name?: string;
    labels: Record<string, string>;
}): Promise<string> {
    const params: Record<string, unknown> = {
        argv: input.argv,
        cwd: input.cwd,
        caller: callerId(),
        labels: input.labels,
        no_notify: true,
    };
    if (input.name !== undefined) params.name = input.name;
    const result: any = await callHerdr("terminal.run", params, 30000);
    const address: unknown = result?.address;
    if (typeof address !== "string" || address.length === 0) {
        throw new Error(`herdr-core terminal.run returned no address: ${JSON.stringify(result)}`);
    }
    return address;
}

export interface TerminalState {
    /** The program's own word: working, blocked, idle or done; undefined until it says. */
    status: string | undefined;
    /** live or finished. */
    state: string;
    /** Goes up each time the status leaves `working`. */
    turn: number;
}

export function getTerminal(terminal: string): Promise<TerminalState> {
    // No caller: a caller looking at its child has seen its news, and reading
    // the turn must not swallow the completion the wait is about to report.
    return callHerdr("terminal.get", { terminal }).then((result: any) => ({
        status: typeof result?.status?.state === "string" ? result.status.state : undefined,
        state: String(result?.state ?? ""),
        turn: typeof result?.turn === "number" ? result.turn : 0,
    }));
}

/** Paste a task into an idle child and submit it. Use `waitForAgentStatus` for the turn. */
export async function sendTask(terminal: string, text: string): Promise<void> {
    // Refuses a blocked program, which is what a dispatch wants: an
    // unanswered dialog is reported, never typed over.
    await callHerdr("terminal.send", { terminal, caller: callerId(), text });
}

/**
 * The session file a child was started with, read from its own argv. A reused
 * child may be running a different session file than the newest one on disk.
 * This one keeps `caller`: the dispatch is about to take the child over, so
 * accepting that child's news is the intended effect, not a side effect.
 */
export async function terminalSessionFile(terminal: string): Promise<string | undefined> {
    const result: any = await callHerdr("terminal.get", { terminal, caller: callerId() });
    const argv = Array.isArray(result?.argv)
        ? result.argv.filter((arg: unknown): arg is string => typeof arg === "string")
        : [];
    const index = argv.indexOf("--session");
    if (index < 0) return undefined;
    const file = argv[index + 1];
    return typeof file === "string" && file.length > 0 ? file : undefined;
}

/** Tail of a terminal's screen and history, for a blocked report. */
export async function readAgentTail(terminal: string, lines = 40): Promise<string> {
    try {
        const result: any = await callHerdr("terminal.read", {
            terminal,
            caller: callerId(),
            lines,
        });
        const text: unknown = result?.text;
        return typeof text === "string" ? `\n--- terminal ${terminal} ---\n${text}` : "";
    } catch {
        return "";
    }
}

export interface TerminalSummary {
    address: string;
    parent?: string;
    cwd?: string;
    name?: string;
    status?: string;
    state?: string;
}

/** Live terminals, optionally filtered by labels. Finished ones are excluded. */
export function listTerminals(labels?: Record<string, string>): Promise<TerminalSummary[]> {
    const params: Record<string, unknown> = {};
    if (labels !== undefined) params.labels = labels;
    return callHerdr("terminal.list", params).then((result: any) => {
        const terminals = result?.terminals;
        if (!Array.isArray(terminals)) {
            throw new Error(
                `herdr-core terminal.list returned no terminals: ${JSON.stringify(result)}`,
            );
        }
        return terminals.map((terminal: any) => ({
            address: String(terminal?.address),
            parent: typeof terminal?.parent === "string" ? terminal.parent : undefined,
            cwd: typeof terminal?.cwd === "string" ? terminal.cwd : undefined,
            name: typeof terminal?.name === "string" ? terminal.name : undefined,
            status: typeof terminal?.status?.state === "string" ? terminal.status.state : undefined,
            state: typeof terminal?.state === "string" ? terminal.state : undefined,
        }));
    });
}

export function labelTerminal(terminal: string, labels: Record<string, string>): Promise<void> {
    return callHerdr("terminal.label", { terminal, labels }).then(() => undefined);
}

/**
 * End a child and forget it: kill stops the program, rm drops the record.
 * Both are best effort — a child that already exited, or one the core no
 * longer knows, is not an error worth failing a dispatch over.
 */
export async function closeTerminal(terminal: string): Promise<void> {
    try {
        await callHerdr("terminal.kill", { terminal, caller: callerId() });
    } catch (err) {
        if (!(err instanceof HerdrError && err.code === "not_found")) throw err;
    }
    try {
        await callHerdr("terminal.rm", { terminal, caller: callerId() });
    } catch (err) {
        if (!(err instanceof HerdrError && err.code === "not_found")) throw err;
    }
}
