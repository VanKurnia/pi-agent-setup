// Test for cachedAssistantText (last-assistant-text extraction) in
// agent/extensions/herdr-subagents/session.ts.
// Run from repo root: node .script/test/herdr-subagents/session.test.mjs
// Silent on success (exit 0, no output); assertion failures exit non-zero.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const loaderUrl = pathToFileURL(
    resolve(
        ROOT,
        "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js",
    ),
).href;

const { createJiti } = await import(loaderUrl);
const jiti = createJiti(import.meta.url, {});
const { cachedAssistantText } = await jiti.import(
    resolve(ROOT, "agent/extensions/herdr-subagents/session.js"),
);

// Each case is a new file, so the reply tail cache never reuses a parse.
const extractLastAssistantText = (jsonl) => cachedAssistantText(`case-${jsonl.length}.jsonl`, jsonl);

const HEADER = `{"type":"session","version":3,"id":"sess-1"}`;
const user = (id, parentId) =>
    `{"type":"message","id":"${id}","parentId":${parentId === null ? "null" : `"${parentId}"`},"timestamp":1,"message":{"role":"user","content":[{"type":"text","text":"do the thing"}]}}`;
const assistant = (id, parentId, blocks) =>
    `{"type":"message","id":"${id}","parentId":"${parentId}","timestamp":2,"message":{"role":"assistant","content":${JSON.stringify(blocks)}}}`;
const custom = (id, parentId) =>
    `{"type":"custom","id":"${id}","parentId":"${parentId}","timestamp":3,"data":{"note":"not a reply"}}`;

// 1. Happy path: thinking blocks are excluded, text blocks are joined.
assert.equal(
    extractLastAssistantText(
        [
            HEADER,
            user("m1", null),
            assistant("m2", "m1", [
                { type: "thinking", text: "let me think" },
                { type: "text", text: "first line" },
                { type: "text", text: "second line" },
            ]),
        ].join("\n"),
    ),
    "first line\nsecond line",
);

// 2. Trailing non-message entry does not hide the assistant reply.
assert.equal(
    extractLastAssistantText(
        [HEADER, user("m1", null), assistant("m2", "m1", [{ type: "text", text: "done" }]), custom("c1", "m2")].join(
            "\n",
        ),
    ),
    "done",
);

// 3. Multiple assistants: the LAST one on the branch wins.
assert.equal(
    extractLastAssistantText(
        [
            HEADER,
            user("m1", null),
            assistant("m2", "m1", [{ type: "text", text: "draft" }]),
            assistant("m3", "m2", [{ type: "text", text: "final" }]),
        ].join("\n"),
    ),
    "final",
);

// 4. Truncated final line is ignored.
assert.equal(
    extractLastAssistantText(
        [
            HEADER,
            user("m1", null),
            assistant("m2", "m1", [{ type: "text", text: "done" }]),
            `{"type":"message","id":"m3","parentId":"m2",`,
        ].join("\n"),
    ),
    "done",
);

// 5. No assistant message yields undefined.
assert.equal(extractLastAssistantText([HEADER, user("m1", null)].join("\n")), undefined);
