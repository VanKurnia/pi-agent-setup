import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import {
    HerdrError,
    closePane,
    createTab,
    getPane,
    listPanes,
    listTabs,
    renamePane,
    runInPane,
    splitPane,
    waitForAgentStatus,
    type PaneState,
} from "./herdr.js";
import {
    acquireLock,
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
} from "./session.js";
import {
    buildAppendSystemPromptFlags,
    discoverAgents,
    loadSubagentsSettings,
    resolveAgentFlags,
    substituteEnv,
    THINKING_LEVELS,
    writeAgentModel,
    writeAgentThinking,
    type AgentConfig,
    type ThinkingLevel,
} from "./agents.js";
import { showPicker } from "../shared/picker.js";

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

export default function herdrSubagents(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description:
            "Run a subagent to complete a task. The child runs as a separate pi-bolt process in its own herdr pane and only its final reply is returned. A read-only parent snapshot is auto-attached as reference. Requires running inside herdr.",
        parameters: Type.Object({
            agent: Type.String({ description: "Name of the agent to invoke." }),
            task: Type.String({ description: "Task description for the subagent." }),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (process.env.HERDR_ENV !== "1") {
                return errorResult("herdr-subagents requires running inside herdr (HERDR_ENV=1).");
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
                linked !== undefined
                    ? lockFileFor(os.tmpdir(), agent.name, cwd, parent)
                    : undefined;
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
                    : findAgentSessionFile(
                          linked.groupDir,
                          agent.name,
                          cwd,
                          undefined,
                          parent,
                          onNames,
                      );
            // Maps a server wait onto the three outcomes every site needs:
            // "aborted" (take the abort path), "timeout" (take the
            // site's timeout path), or "ok". Anything else rethrows.
            const awaitStatus = async (
                target: string,
                until: string[],
                ms: number,
            ): Promise<"ok" | "aborted" | "timeout"> => {
                try {
                    await waitForAgentStatus(target, until, ms, signal);
                } catch (err) {
                    if (signal?.aborted) return "aborted";
                    if (err instanceof HerdrError && err.code === "aborted") return "aborted";
                    if (err instanceof HerdrError && err.code === "timeout") return "timeout";
                    throw err;
                }
                if (signal?.aborted) return "aborted";
                return "ok";
            };
            let found = await findMatch();
            if (found !== undefined) {
                if (found.match.agentStatus === "working") {
                    return stillWorking();
                }
                if (isReadyForTask(found.match)) {
                    if (found.match.agentStatus === "done") {
                        // done is transient post-turn: the pane may still be
                        // flushing the finished turn. Reusing it now races the
                        // extraction (previous reply), so wait for the host to
                        // settle before deciding.
                        const settleState = await awaitStatus(found.match.paneId, ["idle"], 30000);
                        if (settleState === "aborted") return abortResult(found.match.paneId);
                        const settled = settleState === "ok";
                        if (!settled) {
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
                    return errorResult(
                        `subagent ${agent.name} is already starting; retry shortly.`,
                    );
                }
                try {
                    const toolsFlag =
                        agent.tools.length > 0 ? ` --tools ${agent.tools.join(",")}` : "";
                    const systemFlags = buildAppendSystemPromptFlags({
                        agent,
                        cwd,
                        agentDir: getAgentDir(),
                        projectTrusted: ctx.isProjectTrusted(),
                        tmpDir: os.tmpdir(),
                    });
                    if (linked !== undefined) {
                        // Post-acquire triage: reuse a live host, refuse to
                        // collide with a working one, recycle a stale one.
                        const confirmed = await findMatch();
                        if (confirmed !== undefined) {
                            if (confirmed.match.agentStatus === "working") {
                                return stillWorking();
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
                                    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST")
                                        throw err;
                                    const winner = lookupSessionFile();
                                    if (winner === undefined) throw err;
                                    file = winner;
                                }
                            }
                            sessionFile = file;
                            const nameFlag = fresh ? ` --name "${paneName}"` : "";
                            await runInPane(
                                paneId,
                                `pi-bolt --session-dir "${linked.sessionsRoot}" --session "${file}"${nameFlag}${toolsFlag}${modelFlag}${thinkingFlag}${systemFlags}`,
                            );
                        } else {
                            sessionFile = lookupSessionFile();
                        }
                    } else {
                        sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-subagent-"));
                        paneId = await splitPane(cwd);
                        await runInPane(
                            paneId,
                            `pi-bolt --session-dir "${sessionDir}"${toolsFlag}${modelFlag}${thinkingFlag}${systemFlags}`,
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
                const ready = await awaitStatus(pane, ["idle"], 60000);
                if (ready === "aborted") return aborted(pane);
                if (ready === "timeout") {
                    await closePane(pane);
                    return errorResult(
                        `herdr subagent timed out waiting for pi-bolt to become idle in pane ${pane}.`,
                    );
                }
                // The wait guarantees status, not occupant: confirm pi-bolt
                // itself is resting before submitting.
                if (!isReadyForTask(await getPane(pane))) {
                    await closePane(pane);
                    return errorResult(
                        `herdr subagent timed out waiting for pi-bolt to become idle in pane ${pane}.`,
                    );
                }
                const task = attachDelegationSnapshot(params.task, snapshot);
                await runInPane(pane, `Task:\n${task}`);
                if (signal?.aborted) return aborted(pane);
                const started = await awaitStatus(pane, ["working", "done"], 40000);
                if (started === "aborted") return aborted(pane);
                if (started === "timeout") {
                    await closePane(pane);
                    return errorResult(
                        `herdr subagent timed out waiting for pane ${pane} to start working.`,
                    );
                }
                if (signal?.aborted) return aborted(pane);
                if (sessionFile !== undefined) {
                    try {
                        sizeBefore = fs.statSync(sessionFile).size;
                    } catch {
                        sizeBefore = 0;
                    }
                }
                const finished = await awaitStatus(pane, ["done", "idle"], 1800000);
                if (finished === "aborted") return aborted(pane);
                if (finished === "timeout") {
                    await closePane(pane);
                    return errorResult(
                        `herdr subagent timed out waiting for pane ${pane} to finish.`,
                    );
                }
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
        },
    });
    pi.registerCommand("herdr-subagent:settings", {
        description: "Configure herdr subagent settings (model and thinking level per agent)",
        handler: async (_args: string, ctx: ExtensionCommandContext) => {
            const agentDir = getAgentDir();
            const readState = () => ({
                agents: discoverAgents(ctx.cwd, "user").agents,
                models: ctx.modelRegistry.getAvailable(),
                settings: loadSubagentsSettings(agentDir),
            });
            let state = readState();
            while (true) {
                const options = state.agents.map((agent) => {
                    const model = state.settings.agentModels?.[agent.name];
                    const thinking = state.settings.agentThinking?.[agent.name];
                    const base = model ? `${agent.name} — ${model}` : agent.name;
                    return thinking ? `${base} · thinking: ${thinking}` : base;
                });
                const selected = await ctx.ui.select("Select agent to configure:", options);
                // Labels are UI text, not identifiers: resolve the pick back to
                // an agent by position.
                const target =
                    selected === undefined ? undefined : state.agents[options.indexOf(selected)];
                if (!target) return;

                const storedModel = state.settings.agentModels?.[target.name];
                const pickedModel = await showPicker(
                    ctx,
                    storedModel
                        ? `Model for "${target.name}" (current: ${storedModel})`
                        : `Model for "${target.name}":`,
                    "type to filter • ↑↓ navigate • enter select • esc close",
                    () => [
                        {
                            value: "__reset__",
                            label: "[reset to default]",
                            description: "Use agent file's default model",
                        },
                        ...state.models.map((model) => ({
                            value: `${model.provider}/${model.id}`,
                            label: `${model.provider}/${model.id}`,
                        })),
                    ],
                );
                if (pickedModel !== null) {
                    const reset = pickedModel === "__reset__";
                    const label = reset ? "default" : pickedModel;
                    const saved = writeAgentModel(
                        agentDir,
                        target.name,
                        reset ? undefined : pickedModel,
                    );
                    ctx.ui.notify(
                        saved
                            ? `Model for "${target.name}" set to ${label}`
                            : `Failed to save model for "${target.name}" (not applied)`,
                        saved ? "info" : "warning",
                    );
                    state = readState();
                }

                const effectiveModel = substituteEnv(
                    state.settings.agentModels?.[target.name] ?? target.model,
                );
                // Registry entry for the effective model; its map marks
                // unsupported levels with null, and a model without a map
                // supports every level.
                const entry = state.models.find(
                    (model) => `${model.provider}/${model.id}` === effectiveModel,
                );
                const storedLevel = state.settings.agentThinking?.[target.name];
                const pickedLevel = await showPicker(
                    ctx,
                    storedLevel
                        ? `Thinking for "${target.name}" (current: ${storedLevel})`
                        : `Thinking for "${target.name}":`,
                    "↑↓ navigate • enter select • esc close",
                    () => [
                        {
                            value: "__default__",
                            label: "[model default]",
                            description: "Use model default",
                        },
                        ...THINKING_LEVELS.filter(
                            (level) => entry?.thinkingLevelMap?.[level] !== null,
                        ).map((level) => ({ value: level, label: level })),
                    ],
                );
                if (pickedLevel !== null) {
                    const reset = pickedLevel === "__default__";
                    const label = reset ? "model default" : pickedLevel;
                    // Picker values are plain strings; the writer revalidates
                    // the cast before storing.
                    const saved = writeAgentThinking(
                        agentDir,
                        target.name,
                        reset ? undefined : (pickedLevel as ThinkingLevel),
                    );
                    ctx.ui.notify(
                        saved
                            ? `Thinking for "${target.name}" set to ${label}`
                            : `Failed to save thinking for "${target.name}" (not applied)`,
                        saved ? "info" : "warning",
                    );
                    state = readState();
                }
            }
        },
    });
}
