// Tests for the herdr-core client's capability gate (herdr.ts) and the argv
// builder the dispatch uses (tool-body.ts).
// Run from repo root: node .script/test/herdr-app-subagent/herdr.test.mjs
// Pure helpers only: the socket calls need a live herdr-core and a live agent.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const herdr = await importProd(jiti, "agent/extensions/herdr-app-subagent/herdr.js");
const body = await importProd(jiti, "agent/extensions/herdr-app-subagent/tool-body.js");

const FULL = [
    "terminal.run",
    "terminal.wait",
    "terminal.send",
    "terminal.get",
    "terminal.list",
    "terminal.label",
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
            "argv: the flag builders' quoted values become single arguments",
            () =>
                assert.deepEqual(
                    body.argvFromFlags(' --model "opencode-go/x" --approve --tools read,edit'),
                    ["--model", "opencode-go/x", "--approve", "--tools", "read,edit"],
                ),
        ],
        [
            "argv: a quoted path with spaces stays one argument",
            () =>
                assert.deepEqual(
                    body.argvFromFlags(' --append-system-prompt "C:\\\\a b\\\\prompt.md"'),
                    ["--append-system-prompt", "C:\\\\a b\\\\prompt.md"],
                ),
        ],
        [
            "argv: an empty flag string yields no arguments",
            () => assert.deepEqual(body.argvFromFlags(""), []),
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
