// Tests for the command-line size guard that keeps an oversized task out of
// argv, and for the dispatch failure message (tool-body.ts).
// Run from repo root: node .script/test/herdr-app-subagent/argv.test.mjs
//
// Pure helpers only: no herdr socket, no terminal, no model calls. The deferred
// `sendTask` branch of `launch()` needs a live child and is not covered here.
import assert from "node:assert/strict";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const body = await importProd(jiti, "agent/extensions/herdr-app-subagent/tool-body.js");
const { argvFitsTask, formatSubagentFailure } = body;

assert.equal(typeof argvFitsTask, "function", "argvFitsTask is not exported");
assert.equal(typeof formatSubagentFailure, "function", "formatSubagentFailure is not exported");

// Restated from the guard so the boundary cases are derived, not guessed: each
// argv entry costs its own length plus a quote pair and a separator, and the
// task is prefixed with "Task:\n".
const BUDGET = 24_000;
const PREFIX = "Task:\n".length;
const overhead = (argv) => argv.reduce((n, arg) => n + arg.length + 3, 0);

/** A task of exactly `limit` total command-line chars on this argv. */
const taskAt = (argv, limit) => "x".repeat(limit - overhead(argv) - PREFIX);

const SMALL = ["pi-bolt"];
const FAT = ["pi-bolt", ...Array.from({ length: 20 }, () => "f".repeat(500))];

await runCases(
    [
        [
            "argv: a short task on a small argv fits",
            () => {
                assert.equal(argvFitsTask(SMALL, "summarise the config"), true);
            },
        ],
        [
            "argv: a 25 KB task does not fit, a 23 KB task does",
            () => {
                assert.equal(argvFitsTask(SMALL, "x".repeat(25_000)), false);
                assert.equal(argvFitsTask(SMALL, "x".repeat(23_000)), true);
            },
        ],
        [
            "argv: the exact budget fits and one more char does not",
            () => {
                const exact = taskAt(SMALL, BUDGET);
                assert.equal(argvFitsTask(SMALL, exact), true, "the boundary itself must fit");
                assert.equal(argvFitsTask(SMALL, `${exact}x`), false, "one char past it must not");
            },
        ],
        [
            "argv: every entry's length counts, so a longer flag list shrinks the allowance",
            () => {
                const task = "x".repeat(23_000);
                assert.equal(argvFitsTask(SMALL, task), true);
                assert.equal(argvFitsTask(FAT, task), false);
                // The fat argv shifts the edge by exactly its own overhead.
                assert.equal(argvFitsTask(FAT, taskAt(FAT, BUDGET)), true);
                assert.equal(argvFitsTask(FAT, `${taskAt(FAT, BUDGET)}x`), false);
            },
        ],
        [
            "failure: names the terminal, the session and the discard path",
            () => {
                const text = formatSubagentFailure({
                    terminal: "t95",
                    sessionFile: "/root/sessions/t95.jsonl",
                    message: "read failed",
                });
                assert.ok(text.includes("read failed"), text);
                assert.ok(text.includes("terminal t95"), text);
                assert.ok(text.includes("/root/sessions/t95.jsonl"), text);
                assert.ok(text.includes("fresh:true"), text);
                assert.ok(text.includes("left running"), text);
            },
        ],
        [
            "failure: omits the terminal when none was created",
            () => {
                const text = formatSubagentFailure({ message: "boom" });
                assert.ok(text.includes("boom"), text);
                assert.equal(text.includes("terminal undefined"), false, text);
                assert.equal(text.includes("session undefined"), false, text);
                assert.ok(text.includes("fresh:true"), text);
            },
        ],
    ],
    "subagent argv + failure message",
);
