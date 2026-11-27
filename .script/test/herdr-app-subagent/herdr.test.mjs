// Tests for the herdr-core client's capability gate (herdr.ts) and the child
// argv the dispatch builds (agents.ts, tool-body.ts).
// Run from repo root: node .script/test/herdr-app-subagent/herdr.test.mjs
// Pure helpers only: the socket calls need a live herdr-core and a live agent.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const herdr = await importProd(jiti, "agent/extensions/herdr-app-subagent/herdr.js");
const body = await importProd(jiti, "agent/extensions/herdr-app-subagent/tool-body.js");
const agents = await importProd(jiti, "agent/extensions/herdr-app-subagent/agents.js");

const FULL = [
    "terminal.run",
    "terminal.wait",
    "terminal.send",
    "terminal.get",
    "terminal.list",
    "terminal.read",
    "terminal.kill",
    "terminal.rm",
];

await runCases(
    [
        [
            "protocol: a core speaking every method is accepted",
            () => assert.equal(herdr.protocolProblem({ methods: FULL }), undefined),
        ],
        [
            "protocol: unknown extra methods are fine",
            () =>
                assert.equal(
                    herdr.protocolProblem({ methods: [...FULL, "events.subscribe", "hello"] }),
                    undefined,
                ),
        ],
        [
            "protocol: a missing method is named",
            () => {
                const message = herdr.protocolProblem({
                    methods: FULL.filter((name) => name !== "terminal.wait"),
                });
                assert.equal(typeof message, "string");
                assert.ok(message.includes("terminal.wait"));
            },
        ],
        [
            "protocol: the core version appears in the message",
            () => {
                const message = herdr.protocolProblem({ version: "0.1.0", methods: [] });
                assert.equal(typeof message, "string");
                assert.ok(message.includes("0.1.0"));
            },
        ],
        [
            "protocol: an empty or absent method list is reported, not accepted",
            () => {
                assert.equal(typeof herdr.protocolProblem({ methods: [] }), "string");
                assert.equal(typeof herdr.protocolProblem(undefined), "string");
                assert.equal(typeof herdr.protocolProblem("hello"), "string");
            },
        ],
        [
            "flags: model and thinking arrive as flag-plus-value pairs",
            () => {
                assert.deepEqual(
                    agents.resolveAgentFlags({ name: "scout", model: "fallback/m" }, {}),
                    ["--model", "fallback/m", "--thinking", "low"],
                );
                assert.deepEqual(
                    agents.resolveAgentFlags(
                        { name: "scout", model: "fallback/m" },
                        {
                            agentModels: { scout: "opencode-go/x" },
                            agentThinking: { scout: "high" },
                        },
                    ),
                    ["--model", "opencode-go/x", "--thinking", "high"],
                );
                // No default and no stored level: the thinking flag is absent, not empty.
                assert.deepEqual(
                    agents.resolveAgentFlags({ name: "other", model: "fallback/m" }, {}),
                    ["--model", "fallback/m"],
                );
            },
        ],
        [
            "flags: trust is one valueless argument either way",
            () => {
                assert.deepEqual(agents.buildTrustFlag(true), ["--approve"]);
                assert.deepEqual(agents.buildTrustFlag(false), ["--no-approve"]);
            },
        ],
        [
            "flags: a prompt path with spaces stays a single argument",
            () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr flags "));
                const addendum = path.join(dir, "APPEND_SYSTEM.md");
                fs.writeFileSync(addendum, "addendum");
                assert.deepEqual(
                    agents.buildAppendSystemPromptFlags({
                        agent: { name: "scout", systemPrompt: "" },
                        cwd: dir,
                        agentDir: dir,
                        projectTrusted: false,
                        tmpDir: dir,
                    }),
                    ["--append-system-prompt", addendum],
                );
                fs.rmSync(dir, { recursive: true, force: true });
            },
        ],
        // The regression this suite exists for: a turn that ends without a
        // closing sentence. `turn` rises when the status leaves `working`, so
        // no text is consulted and no stale `done` can satisfy it.
        [
            "wait: a turn that advanced is done, text or no text",
            () =>
                assert.equal(
                    body.classifyWait(
                        { ended: true, reason: "status", status: "idle", turn: 3 },
                        2,
                    ),
                    "done",
                ),
        ],
        [
            "wait: a check-in that already saw the turn end is done",
            () =>
                assert.equal(
                    body.classifyWait(
                        { ended: false, reason: "timeout", status: "idle", turn: 3 },
                        2,
                    ),
                    "done",
                ),
        ],
        [
            "wait: a previous turn's done is not ours",
            () =>
                assert.equal(
                    body.classifyWait(
                        { ended: true, reason: "status", status: "done", turn: 2 },
                        2,
                    ),
                    "waiting",
                ),
        ],
        [
            "wait: still working is waiting",
            () =>
                assert.equal(
                    body.classifyWait(
                        { ended: false, reason: "timeout", status: "working", turn: 2 },
                        2,
                    ),
                    "waiting",
                ),
        ],
        [
            "wait: blocked wins over everything",
            () =>
                assert.equal(
                    body.classifyWait(
                        { ended: false, reason: "status", status: "blocked", turn: 2 },
                        2,
                    ),
                    "blocked",
                ),
        ],
        [
            "wait: a child that exited is reported, not waited on",
            () =>
                assert.equal(
                    body.classifyWait(
                        { ended: true, reason: "exit", status: undefined, turn: 2 },
                        2,
                    ),
                    "exited",
                ),
        ],
        [
            "wait: a send that never started is its own verdict",
            () =>
                assert.equal(
                    body.classifyWait(
                        { ended: true, reason: "not_started", status: "idle", turn: 2 },
                        2,
                    ),
                    "not-started",
                ),
        ],
    ],
    "herdr-core capability gate and argv builder",
);
