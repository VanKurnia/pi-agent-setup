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
    closePane,
    createTab,
    getPane,
    herdrProtocolProblem,
    listPanes,
    listTabs,
    notifyHerdr,
    readAgentTail,
    renameAgent,
    renamePane,
    runInPane,
    splitPane,
    waitForAgentStatus,
    type PaneState,
} from "./herdr.ts";
import {
    acquireLock,
    agentNameFor,
    agentSessionId,
    attachDelegationSnapshot,
    buildChildHeader,
    cachedAssistantText,
    cachedTurnComplete,
    childSessionFilename,
    createDelegationSnapshot,
    findAgentSessionFile,
    isSafeAgentName,
    lockFileFor,
    matchPane,
    paneNameFor,
    parentKey,
    releaseLock,
    sweepLegacySessionFiles,
    tabNameFor,
} from "./session.ts";
import {
    buildAppendSystemPromptFlags,
    buildTrustFlag,
    discoverAgents,
    loadSubagentsSettings,
    resolveAgentFlags,
    type AgentConfig,
} from "./agents.ts";

// A child host is ready to take a task when pi-bolt is present and resting.
// done is pi-bolt's resting state after a finished turn; idle is its state
// before the first prompt. working means busy; anything else means stale.
function isReadyForTask(state: PaneState): boolean {
    return (
        state.agent === "pi-bolt" && (state.agentStatus === "idle" || state.agentStatus === "done")
    );
}

function errorResult(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true, details: {} };
}

function abortResult(paneId: string, sessionFile?: string) {
    // An aborted wait is not a failed turn: the child keeps its pane and its
    // session, so a later dispatch to this agent reuses both. Closing the pane
    // here would throw away work that is still in progress.
    const session = sessionFile === undefined ? "" : ` (session: ${sessionFile})`;
    return errorResult(`Subagent run was aborted; its pane ${paneId} was left running${session}.`);
}

// A blocked child is not a failed child: herdr recognized an approval or
// question dialog, and nothing in this pipeline can answer it. Leave the pane
// running so the work is not lost.
async function blockedResult(target: string, when: string) {
    void notifyHerdr(`subagent blocked: ${target}`);
    return errorResult(
        `herdr subagent pane ${target} is blocked ${when}: a herdr approval or question dialog is waiting in the child. ` +
            `The pane was left running — answer the dialog there, then dispatch again.${await readAgentTail(target)}`,
    );
}

// A child that never reached the expected state holds a pane no later dispatch
// can use: tell the user, then reclaim it.
async function timedOut(paneId: string, what: string) {
    void notifyHerdr(`subagent timeout: ${paneId} ${what}`);
    await closePane(paneId);
    return errorResult(`herdr subagent timed out waiting for pane ${paneId} to ${what}.`);
}

/** Body of the `subagent` tool. Lazy-loaded: the dispatch machinery stays off the boot path. */
export async function runSubagentTool(
    params: { agent: string; task: string },
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
    if (process.env.HERDR_ENV !== "1") {
        return errorResult("herdr-subagents requires running inside herdr (HERDR_ENV=1).");
    }
    // Before any discovery call: an incompatible server would otherwise
    // fail inside findMatch() with an unknown-method error.
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
    const paneName = paneNameFor(agent.name, cwd, parent);
    const lockPath =
        linked !== undefined ? lockFileFor(os.tmpdir(), agent.name, cwd, parent) : undefined;
    let paneId: string | undefined;
    let sessionFile: string | undefined;
    let sessionDir: string | undefined;
    let reused = false;
    // Byte size of the session file just before our prompt is sent;
    // -1 (nothing sent yet) disables the late-reply path.
    let sizeBefore = -1;
    // Pre-lock discovery for double-checked locking: findMatch reads
    // the mapped pane summary (status + occupant, no re-fetch). The
    // settle outcome feeds paneId/reused into the serialized launch
    // below, so it runs here — before acquireLock — with a
    // post-acquire re-match.
    const tabName = tabNameFor(agent.name, cwd, parent);
    // The child belongs in the parent's workspace, not
    // whichever workspace is currently focused.
    const workspaceId = process.env.HERDR_WORKSPACE_ID || undefined;
    const findMatch = async () => {
        if (linked === undefined) return undefined;
        const tabMatch = matchPane(await listTabs(workspaceId), tabName);
        if (tabMatch === undefined) return undefined;
        const match = (await listPanes()).find((pane) => pane.tabId === tabMatch.tabId);
        if (match === undefined) return undefined;
        return { tabMatch, match };
    };
    const stillWorking = () =>
        errorResult(`subagent ${agent.name} is still working; wait for it to finish.`);
    const recyclePane = async (paneId: string) => {
        try {
            await closePane(paneId);
        } catch {
            // Pane already gone; relaunch below.
        }
    };
    const lookupSessionFile = (onNames?: (names: string[]) => void) =>
        linked === undefined
            ? undefined
            : findAgentSessionFile(linked.groupDir, agent.name, cwd, undefined, parent, onNames);
    // Maps a server wait onto the four outcomes every site branches on.
    // `blocked` means herdr saw an approval or question dialog, which
    // only a human answering it in the pane can clear.
    const awaitStatus = async (
        target: string,
        until: string[],
        ms: number,
    ): Promise<"ok" | "aborted" | "timeout" | "blocked"> => {
        try {
            const blocked = await waitForAgentStatus(target, until, ms, signal);
            if (signal?.aborted) return "aborted";
            return blocked ? "blocked" : "ok";
        } catch (err) {
            if (signal?.aborted) return "aborted";
            if (err instanceof HerdrError && err.code === "aborted") return "aborted";
            if (err instanceof HerdrError && err.code === "timeout") return "timeout";
            throw err;
        }
    };
    let found = await findMatch();
    if (found !== undefined) {
        if (found.match.agentStatus === "working") {
            return stillWorking();
        }
        if (found.match.agentStatus === "blocked") {
            return blockedResult(found.match.paneId, "before reuse");
        }
        if (isReadyForTask(found.match)) {
            if (found.match.agentStatus === "done") {
                // done is transient post-turn: the pane may still be
                // flushing the finished turn. Reusing it now races the
                // extraction (previous reply), so wait for the host to
                // settle before deciding.
                const settleState = await awaitStatus(
                    found.match.paneId,
                    ["idle", "blocked"],
                    30000,
                );
                if (settleState === "aborted") return abortResult(found.match.paneId);
                if (settleState === "blocked")
                    return blockedResult(found.match.paneId, "before reuse");
                if (settleState === "timeout") {
                    // Still done after 30s: recycle the host, keep
                    // the session file; relaunch continues it below.
                    await recyclePane(found.match.paneId);
                }
                found = await findMatch();
                if (found !== undefined && !isReadyForTask(found.match)) {
                    // Changed state mid-settle: not trusted for reuse.
                    await recyclePane(found.match.paneId);
                    found = undefined;
                }
            }
        } else {
            // Stale host (dead agent, crashed child): recycle it so no
            // orphaned tab leaks, then relaunch below.
            await recyclePane(found.match.paneId);
            found = undefined;
        }
    }
    // The snapshot reads only frozen parent state, so build it
    // outside the lock while discovery runs ahead.
    const snapshot = await createDelegationSnapshot(ctx);
    try {
        if (lockPath !== undefined && !acquireLock(lockPath)) {
            return errorResult(`subagent ${agent.name} is already starting; retry shortly.`);
        }
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
            if (linked !== undefined) {
                // Post-acquire triage: reuse a live host, refuse to
                // collide with a working one, recycle a stale one.
                const confirmed = await findMatch();
                if (confirmed !== undefined) {
                    if (confirmed.match.agentStatus === "working") {
                        return stillWorking();
                    }
                    if (confirmed.match.agentStatus === "blocked") {
                        return blockedResult(confirmed.match.paneId, "before reuse");
                    }
                    if (isReadyForTask(confirmed.match)) {
                        paneId = confirmed.match.paneId;
                        reused = true;
                    } else {
                        await recyclePane(confirmed.match.paneId);
                    }
                }
                if (paneId === undefined) {
                    try {
                        paneId = (await createTab(cwd, tabName, workspaceId)).rootPaneId;
                    } catch {
                        paneId = await splitPane(cwd);
                        await renamePane(paneId, paneName);
                    }
                }
                if (!reused) {
                    const stamp = new Date().toISOString();
                    let file = lookupSessionFile((names) =>
                        sweepLegacySessionFiles(linked.groupDir, agent.name, names),
                    );
                    let fresh = false;
                    if (file === undefined) {
                        const id = agentSessionId(agent.name, cwd, parent);
                        const candidate = path.join(
                            linked.groupDir,
                            childSessionFilename(id, stamp),
                        );
                        try {
                            fs.writeFileSync(
                                candidate,
                                buildChildHeader(id, cwd, linked.parentFile, stamp),
                                { flag: "wx" },
                            );
                            fresh = true;
                            file = candidate;
                        } catch (err) {
                            if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
                            const winner = lookupSessionFile();
                            if (winner === undefined) throw err;
                            file = winner;
                        }
                    }
                    sessionFile = file;
                    const nameFlag = fresh ? ` --name "${paneName}"` : "";
                    await runInPane(
                        paneId,
                        `pi-bolt --session-dir "${linked.sessionsRoot}" --session "${file}"${nameFlag}${toolsFlag}${modelFlag}${thinkingFlag}${systemFlags}${trustFlag}`,
                    );
                } else {
                    sessionFile = lookupSessionFile();
                }
            } else {
                sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-subagent-"));
                paneId = await splitPane(cwd);
                await runInPane(
                    paneId,
                    `pi-bolt --session-dir "${sessionDir}"${toolsFlag}${modelFlag}${thinkingFlag}${systemFlags}${trustFlag}`,
                );
            }
        } finally {
            if (lockPath !== undefined) releaseLock(lockPath);
        }
        if (paneId === undefined) {
            return errorResult("herdr subagent failed to obtain a pane.");
        }
        const pane: string = paneId;
        // Late reply: if our wait is cancelled after the turn fully
        // landed, return its text instead of reporting "aborted".
        // Growth alone is not enough — the newest entry must be a
        // complete assistant message, else a partial turn would
        // yield the previous reply (see cachedTurnComplete).
        const readLateReply = (): { text: string; session: string } | undefined => {
            if (sessionFile === undefined || sizeBefore < 0) return undefined;
            let sizeNow: number;
            try {
                sizeNow = fs.statSync(sessionFile).size;
            } catch {
                return undefined;
            }
            if (sizeNow <= sizeBefore) return undefined;
            let jsonl: string;
            try {
                jsonl = fs.readFileSync(sessionFile, "utf8");
            } catch {
                return undefined;
            }
            const text = cachedTurnComplete(sessionFile, jsonl);
            return text === undefined ? undefined : { text, session: sessionFile };
        };
        const aborted = async (paneId: string) => {
            const late = readLateReply();
            if (late !== undefined) {
                return {
                    content: [{ type: "text" as const, text: late.text }],
                    details: {
                        mode: "single",
                        pane,
                        session: late.session,
                        reused,
                        late: true,
                    },
                };
            }
            return abortResult(paneId, sessionFile);
        };
        const ready = await awaitStatus(pane, ["idle", "blocked"], 60000);
        if (ready === "aborted") return aborted(pane);
        if (ready === "blocked") return blockedResult(pane, "during startup");
        if (ready === "timeout") return timedOut(pane, "become idle");
        // The wait guarantees status, not occupant: confirm pi-bolt
        // itself is resting before submitting.
        if (!isReadyForTask(await getPane(pane))) return timedOut(pane, "become idle");
        // A name makes the child readable in `herdr agent list`; it does
        // NOT unlock `agent.prompt`, because only an agent herdr started
        // itself is an "active named agent". A second live child of the
        // same agent already holds the name, so a refusal is expected.
        try {
            await renameAgent(pane, agentNameFor(agent.name));
        } catch {
            // Name taken or refused: the child stays unnamed.
        }
        const task = attachDelegationSnapshot(params.task, snapshot);
        await runInPane(pane, `Task:\n${task}`);
        if (signal?.aborted) return aborted(pane);
        const started = await awaitStatus(pane, ["working", "done", "blocked"], 40000);
        if (started === "aborted") return aborted(pane);
        if (started === "blocked") return blockedResult(pane, "while starting the task");
        if (started === "timeout") return timedOut(pane, "start working");
        if (signal?.aborted) return aborted(pane);
        if (sessionFile !== undefined) {
            try {
                sizeBefore = fs.statSync(sessionFile).size;
            } catch {
                sizeBefore = 0;
            }
        }
        const finished = await awaitStatus(pane, ["done", "idle", "blocked"], 1800000);
        if (finished === "aborted") return aborted(pane);
        if (finished === "blocked") return blockedResult(pane, "before finishing");
        if (finished === "timeout") return timedOut(pane, "finish");
        if (signal?.aborted) return aborted(pane);
        if (sessionFile === undefined && !reused && sessionDir !== undefined) {
            const jsonlFiles = fs
                .readdirSync(sessionDir, { encoding: "utf8", recursive: true })
                .filter((name) => name.endsWith(".jsonl"))
                .sort();
            if (jsonlFiles.length === 0) {
                await closePane(pane);
                return errorResult(
                    `herdr subagent finished but no session file was found under ${sessionDir}.`,
                );
            }
            sessionFile = path.join(sessionDir, jsonlFiles[0]);
        }
        if (sessionFile === undefined) {
            await closePane(pane);
            return errorResult(
                reused
                    ? `herdr subagent pane ${pane} is alive but its session file is missing.`
                    : "herdr subagent finished but no session file was found.",
            );
        }
        const jsonl = fs.readFileSync(sessionFile, "utf8");
        const text = cachedAssistantText(sessionFile, jsonl);
        if (text === undefined) {
            await closePane(pane);
            return errorResult(
                "herdr subagent finished but no assistant reply was found in the session file.",
            );
        }
        return {
            content: [{ type: "text" as const, text }],
            details: {
                mode: "single",
                pane,
                session: sessionFile,
                reused,
                ...(linked === undefined ? { unlinked: "ephemeral parent" } : {}),
            },
        };
    } catch (err) {
        if (paneId !== undefined) {
            try {
                await closePane(paneId);
            } catch {
                // Pane already gone; nothing to clean up.
            }
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`herdr subagent failed: ${message}`);
    }
}
