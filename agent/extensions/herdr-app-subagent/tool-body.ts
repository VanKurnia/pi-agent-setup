import {
    getAgentDir,
    type AgentToolResult,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    HerdrError,
    awaitTerminalGone,
    callerId,
    closeTerminal,
    getTerminal,
    herdrProtocolProblem,
    killTerminal,
    listTerminals,
    readAgentTail,
    removeTerminal,
    runTerminal,
    sendTask,
    terminalSessionFile,
    waitForAgentStatus,
    type WaitOutcome,
} from "./herdr.ts";
import {
    acquireLock,
    agentNameFor,
    agentSessionId,
    attachDelegationSnapshot,
    buildChildHeader,
    cachedAssistantText,
    childSessionFilename,
    clearChildMemory,
    createDelegationSnapshot,
    deleteChildSessionFiles,
    findAgentSessionFile,
    isSafeAgentName,
    lockFileFor,
    parentKey,
    releaseLock,
    sweepLegacySessionFiles,
} from "./session.ts";
import {
    buildAppendSystemPromptFlags,
    buildTrustFlag,
    discoverAgents,
    loadSubagentsSettings,
    resolveAgentFlags,
    type AgentConfig,
} from "./agents.ts";

/**
 * The flag builders emit `--name "value"` for a shell, and their values are
 * paths and roles. A terminal is started as a real program, so the same flags
 * travel as argv: split on the quotes they emit, not on spaces, because a path
 * may contain one.
 */
export function argvFromFlags(flags: string): string[] {
    const tokens = flags.match(/"[^"]*"|\S+/g) ?? [];
    return tokens.map((token) => (token.startsWith('"') ? token.slice(1, -1) : token));
}

function errorResult(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true, details: {} };
}

function abortResult(terminal: string, sessionFile?: string) {
    // An aborted wait is not a failed turn: the child keeps its terminal and
    // its session, so a later dispatch to this agent continues both. Closing
    // it here would throw away work that is still in progress.
    const session = sessionFile === undefined ? "" : ` (session: ${sessionFile})`;
    return errorResult(
        `Subagent run was aborted; its sub-agent terminal ${terminal} was left running${session}.`,
    );
}

// A turn that ended without a closing sentence is still a turn: the work is
// done and its record is in the session file, so this is a result, not an error.
function noSummaryResult(agentName: string, terminal: string, session: string, reused: boolean) {
    return {
        content: [
            {
                type: "text" as const,
                text: `Subagent (\`${agentName}\`) finished without a text summary. Its session is ${session} — read it, or dispatch again.`,
            },
        ],
        details: { mode: "single", terminal, session, reused, noSummary: true },
    };
}

// A blocked child is not a failed child: the core saw an approval or question
// dialog, and nothing in this pipeline can answer it. Leave it running so the
// work is not lost.
async function blockedResult(terminal: string, when: string) {
    return errorResult(
        `herdr subagent terminal ${terminal} is blocked ${when}: an approval or question dialog is waiting in the child. ` +
            `It was left running — answer the dialog there, then dispatch again.${await readAgentTail(terminal)}`,
    );
}

// A child that outlived the budget is not a failed child: it holds work and a
// terminal a later dispatch can reuse. Report it, never reclaim it.
function timedOut(terminal: string, sessionFile: string | undefined, usedMs: number) {
    const session = sessionFile === undefined ? "" : ` (session ${sessionFile})`;
    return errorResult(
        `herdr subagent still working after ${Math.round(usedMs / 60000)} min; terminal ${terminal} was left running${session}. ` +
            "Dispatch again to collect or continue.",
    );
}

// A graceful hangup lets a child finish its turn; the transcript must also stop
// changing before it is deleted, or the next append recreates it headerless.
const KILL_WAIT_MS = 15_000;

export type WaitVerdict = "done" | "waiting" | "blocked" | "exited" | "not-started";

/**
 * Judge one wait result. `turnBefore` is the child's turn before our task was
 * handed over; a completed turn raises it (Terminal.turn: "goes up each time
 * the status leaves working"), so this needs no text and cannot be satisfied by
 * the child's previous `done`.
 */
export function classifyWait(outcome: WaitOutcome, turnBefore: number): WaitVerdict {
    if (outcome.status === "blocked") return "blocked";
    if (outcome.reason === "exit") return "exited";
    if (outcome.reason === "not_started") return "not-started";
    // Before the `ended` test: a check-in carries the current status, so a turn
    // that completed right at the timeout is finished, not still running.
    if (outcome.turn > turnBefore) return "done";
    return "waiting";
}

/** Body of the `subagent` tool. Lazy-loaded: the dispatch machinery stays off the boot path. */
export async function runSubagentTool(
    params: { agent: string; task: string; fresh?: boolean },
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
    const caller = callerId();
    const missing = [
        caller === undefined ? "HC_TERMINAL_ID" : undefined,
        process.env.HC_TERMINAL_SOCKET === undefined ? "HC_TERMINAL_SOCKET" : undefined,
    ].filter((name): name is string => name !== undefined);
    if (caller === undefined || missing.length > 0) {
        return errorResult(
            `herdr-subagents needs a herdr-core session; ${missing.join(" and ")} ` +
                `${missing.length === 1 ? "is" : "are"} not set. Start pi from a herdr-core terminal and retry.`,
        );
    }
    // Before any dispatch call: an older core would otherwise fail inside
    // runTerminal with an unknown-method error.
    const protocolProblem = await herdrProtocolProblem();
    if (protocolProblem !== undefined) {
        return errorResult(`herdr subagent failed: ${protocolProblem}`);
    }
    const cwd: string = ctx.cwd;
    const { agents } = discoverAgents(cwd, "user");
    const agent: AgentConfig | undefined = agents.find(
        (candidate) => candidate.name === params.agent,
    );
    if (!agent) {
        return errorResult(
            `Unknown agent: ${params.agent}. Available: ${agents.map((candidate) => candidate.name).join(", ")}`,
        );
    }
    if (!isSafeAgentName(agent.name)) {
        return errorResult(
            `Unsafe agent name: ${agent.name}. Agent names must match [A-Za-z0-9._-].`,
        );
    }
    // Model/thinking follow agent/subagents.json (read-only sharing with
    // the old backend); continued sessions adopt the current config.
    const { modelFlag, thinkingFlag } = resolveAgentFlags(
        agent,
        loadSubagentsSettings(getAgentDir()),
    );
    const rawParentFile: unknown = ctx.sessionManager?.getSessionFile?.();
    const linked =
        typeof rawParentFile === "string" && rawParentFile.length > 0
            ? {
                  parentFile: rawParentFile,
                  groupDir: path.dirname(rawParentFile),
                  sessionsRoot: path.dirname(path.dirname(rawParentFile)),
              }
            : undefined;
    const parent = linked !== undefined ? parentKey(linked.parentFile) : undefined;
    const isFresh = params.fresh === true;
    const childId = agentSessionId(agent.name, cwd, parent);
    const lockPath =
        linked !== undefined ? lockFileFor(os.tmpdir(), agent.name, cwd, parent) : undefined;
    // A child is identified in the app by who started it: the core records
    // `parent` itself, and these labels make a dispatch traceable.
    const labels = { "subagent.parent": caller, "subagent.agent": agent.name };
    const name = agentNameFor(agent.name, caller);
    let terminal: string | undefined;
    let sessionFile: string | undefined;
    let sessionDir: string | undefined;
    let reused = false;
    // Byte size of the child's session file before our task is launched.
    // Anything at or below it belongs to an earlier turn, including a reply
    // from a session this dispatch continues.
    let sizeBefore = 0;
    // The child's turn before this dispatch handed it the task. A turn only
    // counts as ours once it has ended, which raises this number.
    let turnBefore = 0;
    // One warm child per agent and folder: a live idle child of this parent
    // takes the next task instead of a new terminal being started.
    const findReusableChild = async (): Promise<string | undefined> => {
        if (linked === undefined) return undefined;
        const children = await listTerminals(labels);
        const ready = children.filter(
            (child) => child.cwd === cwd && (child.status === "idle" || child.status === "done"),
        );
        return ready[0]?.address;
    };
    // Leftovers from earlier dispatches outlive their usefulness: keep the
    // child in use and reclaim the idle ones.
    const pruneIdleSiblings = async (keep: string): Promise<void> => {
        if (linked === undefined) return;
        for (const child of await listTerminals(labels)) {
            if (child.address === keep) continue;
            if (child.status !== "idle" && child.status !== "done") continue;
            try {
                await closeTerminal(child.address);
            } catch {
                // Already gone; nothing to reclaim.
            }
        }
    };
    const lookupSessionFile = (onNames?: (names: string[]) => void) =>
        linked === undefined
            ? undefined
            : findAgentSessionFile(linked.groupDir, agent.name, cwd, parent, onNames);
    /** Only what this dispatch appended to the session file, never an older turn. */
    const readOurTurn = (): { text: string; session: string } | undefined => {
        if (sessionFile === undefined) return undefined;
        let buffer: Buffer;
        try {
            buffer = fs.readFileSync(sessionFile);
        } catch {
            return undefined;
        }
        if (buffer.length <= sizeBefore) return undefined;
        const tail = buffer.subarray(sizeBefore).toString("utf8");
        const text = cachedAssistantText(sessionFile, tail);
        return text === undefined ? undefined : { text, session: sessionFile };
    };
    // The snapshot reads only frozen parent state, so it is built before the
    // lock is taken and never holds up a concurrent dispatch.
    const task = attachDelegationSnapshot(params.task, await createDelegationSnapshot(ctx));
    try {
        const toolsFlag = agent.tools.length > 0 ? ` --tools ${agent.tools.join(",")}` : "";
        const systemFlags = buildAppendSystemPromptFlags({
            agent,
            cwd,
            agentDir: getAgentDir(),
            projectTrusted: ctx.isProjectTrusted(),
            tmpDir: os.tmpdir(),
        });
        const trustFlag = buildTrustFlag(ctx.isProjectTrusted());
        // The task travels as the last argv element: the child is a real
        // program, so nothing has to be typed into it after boot.
        const launch = async (newSession: boolean): Promise<string> => {
            const argv: string[] = ["pi-bolt"];
            if (linked !== undefined && sessionFile !== undefined) {
                argv.push("--session-dir", linked.sessionsRoot, "--session", sessionFile);
                // A session file created by this dispatch has no name yet.
                if (newSession) argv.push("--name", name);
            } else if (sessionDir !== undefined) {
                argv.push("--session-dir", sessionDir);
            }
            argv.push(
                ...argvFromFlags(toolsFlag + modelFlag + thinkingFlag + systemFlags + trustFlag),
            );
            argv.push(`Task:\n${task}`);
            try {
                return await runTerminal({ argv, cwd, name, labels });
            } catch (err) {
                // A second live child of the same agent already holds the
                // name; the dispatch is anonymous rather than refused.
                if (err instanceof HerdrError && /name/i.test(`${err.code} ${err.message}`)) {
                    return runTerminal({ argv, cwd, labels });
                }
                throw err;
            }
        };
        if (lockPath !== undefined && !acquireLock(lockPath)) {
            return errorResult(`subagent ${agent.name} is already starting; retry shortly.`);
        }
        try {
            // Fresh wins over reuse: reap first, so the lookup below cannot hand
            // the task to the child this dispatch is replacing.
            if (isFresh) {
                if (signal?.aborted) {
                    return errorResult(
                        `subagent ${agent.name} was cancelled before its fresh session started.`,
                    );
                }
                for (const child of await listTerminals(labels)) {
                    if (child.cwd !== cwd) continue;
                    await killTerminal(child.address);
                    if (!(await awaitTerminalGone(child.address, KILL_WAIT_MS))) {
                        return errorResult(
                            `subagent ${agent.name} could not be ended; terminal ${child.address} is still running.`,
                        );
                    }
                    await removeTerminal(child.address);
                }
                if (linked !== undefined) {
                    deleteChildSessionFiles(linked.groupDir, agent.name, cwd, parent);
                    clearChildMemory(childId);
                    // A survivor would be picked up by the creation branch below
                    // and turn this dispatch into the continue it was asked to replace.
                    if (lookupSessionFile() !== undefined) {
                        return errorResult(
                            `subagent ${agent.name}: the previous session file under ${linked.groupDir} could not be deleted, so it would resume. Nothing was launched.`,
                        );
                    }
                }
            }
            if (linked !== undefined) {
                const reusable = await findReusableChild();
                if (reusable !== undefined) {
                    // Hand the task to the warm child: same process, same
                    // context, no boot and no extra terminal.
                    const childSession = await terminalSessionFile(reusable);
                    sessionFile = childSession ?? lookupSessionFile();
                    if (sessionFile !== undefined) sizeBefore = fs.statSync(sessionFile).size;
                    await pruneIdleSiblings(reusable);
                    turnBefore = (await getTerminal(reusable)).turn;
                    await sendTask(reusable, `Task:\n${task}`);
                    terminal = reusable;
                    reused = true;
                }
            }
            if (linked !== undefined && terminal === undefined) {
                const stamp = new Date().toISOString();
                let file = lookupSessionFile((names) =>
                    sweepLegacySessionFiles(linked.groupDir, agent.name, names),
                );
                let createdSession = false;
                if (file === undefined) {
                    const candidate = path.join(
                        linked.groupDir,
                        childSessionFilename(childId, stamp),
                    );
                    try {
                        fs.writeFileSync(
                            candidate,
                            buildChildHeader(childId, cwd, linked.parentFile, stamp),
                            { flag: "wx" },
                        );
                        createdSession = true;
                        file = candidate;
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
                        const winner = lookupSessionFile();
                        if (winner === undefined) throw err;
                        file = winner;
                    }
                }
                sessionFile = file;
                sizeBefore = fs.statSync(sessionFile).size;
                terminal = await launch(createdSession);
                turnBefore = (await getTerminal(terminal)).turn;
                await pruneIdleSiblings(terminal);
            } else if (linked === undefined) {
                sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-subagent-"));
                terminal = await launch(false);
                turnBefore = (await getTerminal(terminal)).turn;
            }
        } finally {
            if (lockPath !== undefined) releaseLock(lockPath);
        }
        if (terminal === undefined) {
            return errorResult("herdr subagent failed to obtain a terminal.");
        }
        const child: string = terminal;
        const startedAt = Date.now();
        const deadline = startedAt + 1800000;
        let last: WaitOutcome | undefined;
        const aborted = async (target: string) => {
            // Late reply: a turn that ended before the cancel is still an
            // answer, and it counts even when it has no text.
            if (last === undefined || classifyWait(last, turnBefore) !== "done") {
                return abortResult(target, sessionFile);
            }
            const late = readOurTurn();
            if (late === undefined) {
                return sessionFile === undefined
                    ? abortResult(target, sessionFile)
                    : noSummaryResult(agent.name, child, sessionFile, reused);
            }
            return {
                content: [{ type: "text" as const, text: late.text }],
                details: {
                    mode: "single",
                    terminal,
                    session: late.session,
                    reused,
                    fresh: isFresh,
                    late: true,
                },
            };
        };
        // A program that never reported status counts as working until it
        // exits, so waiting right after the launch is safe. A continued session
        // can report "done" from its previous turn before it takes our task, so
        // the wait re-arms until a turn ends after handover — `Terminal.turn`
        // "goes up each time the status leaves working", which no leftover
        // `done` can satisfy. Each wait is armed with everything left of one
        // budget: a check-in is not a timeout, and a slow child is not a lost one.
        let verdict: WaitVerdict = "waiting";
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break; // budget spent; verdict stays "waiting"
            let raw: WaitOutcome;
            try {
                raw = await waitForAgentStatus(child, remaining, signal);
            } catch (err) {
                if (signal?.aborted) return aborted(child);
                if (err instanceof HerdrError && err.code === "aborted") return aborted(child);
                if (err instanceof HerdrError && err.code === "timeout") break;
                throw err;
            }
            last = raw;
            if (signal?.aborted) return aborted(child);
            verdict = classifyWait(raw, turnBefore);
            if (verdict !== "waiting") break;
            // Idle but no turn yet: wait a moment instead of hammering the socket.
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (verdict === "blocked") return blockedResult(child, "before finishing");
        if (verdict === "exited") {
            const session = sessionFile === undefined ? "" : ` (session ${sessionFile})`;
            return errorResult(
                `herdr subagent terminal ${child} exited before its turn ended${session}.`,
            );
        }
        if (verdict === "not-started") {
            const session = sessionFile === undefined ? "" : ` (session ${sessionFile})`;
            return errorResult(
                `herdr subagent terminal ${child} did not take the task; it is still pending there${session}.`,
            );
        }
        if (verdict === "waiting") return timedOut(child, sessionFile, Date.now() - startedAt);
        if (sessionFile === undefined && sessionDir !== undefined) {
            const jsonlFiles = fs
                .readdirSync(sessionDir, { encoding: "utf8", recursive: true })
                .filter((entry) => entry.endsWith(".jsonl"))
                .sort();
            if (jsonlFiles.length === 0) {
                await closeTerminal(child);
                return errorResult(
                    `herdr subagent finished but no session file was found under ${sessionDir}.`,
                );
            }
            sessionFile = path.join(sessionDir, jsonlFiles[0]);
        }
        if (sessionFile === undefined) {
            await closeTerminal(child);
            return errorResult("herdr subagent finished but no session file was found.");
        }
        const ours = readOurTurn();
        if (ours === undefined) {
            // A turn can end without text because the child finished quietly,
            // or because the child died: `finished` is the second case, and it
            // deserves to be named rather than reported as a silent success.
            if ((await getTerminal(child)).state === "finished") {
                return errorResult(
                    `herdr subagent terminal ${child} exited before answering (session ${sessionFile}).`,
                );
            }
            return noSummaryResult(agent.name, child, sessionFile, reused);
        }
        return {
            content: [{ type: "text" as const, text: ours.text }],
            details: {
                mode: "single",
                terminal,
                session: ours.session,
                reused,
                fresh: isFresh,
                ...(linked === undefined ? { unlinked: "ephemeral parent" } : {}),
            },
        };
    } catch (err) {
        if (terminal !== undefined) {
            try {
                await closeTerminal(terminal);
            } catch {
                // Already gone; nothing to clean up.
            }
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`herdr subagent failed: ${message}`);
    }
}
