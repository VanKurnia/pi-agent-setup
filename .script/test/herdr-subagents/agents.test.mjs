// Test for loadAgentsFromDir/discoverAgents in agent/extensions/herdr-subagents/agents.ts.
// Run from repo root: node .script/test/herdr-subagents/agents.test.mjs
// Uses the shared harness (real SDK via jiti); fixtures live in os.tmpdir().
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const agents = await importProd(jiti, "agent/extensions/herdr-subagents/agents.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-agents-test-"));
const write = (dir, name, content) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, "utf8");
};
const md = (frontmatter, body = "You are a test agent.") => `---\n${frontmatter}\n---\n\n${body}\n`;

const dirA = path.join(root, "a");
write(dirA, "scout.md", md("name: scout\ndescription: recon\ntools: read, ffgrep ,read", "Scout body."));
write(dirA, "notes.txt", "not an agent");
write(dirA, "noname.md", md("description: missing name"));
const dirB = path.join(root, "b");
write(dirB, "scout.md", md("name: scout\ndescription: override\ntools: read", "Override body."));

await runCases(
    [
        [
            "happy path fields",
            () => {
                const [scout] = agents.loadAgentsFromDir(dirA, "user");
                assert.equal(scout.name, "scout");
                assert.deepEqual(scout.tools, ["read", "ffgrep", "read"]);
                assert.equal(scout.systemPrompt.trim(), "Scout body.");
                assert.equal(scout.description, "recon");
                assert.ok(scout.filePath.endsWith("scout.md"));
                assert.equal(scout.source, "user");
            },
        ],
        ["entry without name skipped", () => assert.equal(agents.loadAgentsFromDir(dirA, "user").length, 1)],
        [
            "non-md files ignored",
            () => assert.ok(agents.loadAgentsFromDir(dirA, "user").every((a) => a.name === "scout")),
        ],
        ["missing dir returns []", () => assert.deepEqual(agents.loadAgentsFromDir(path.join(root, "nope"), "user"), [])],
        [
            "later source wins by name",
            () => {
                const first = agents.loadAgentsFromDir(dirA, "user");
                const second = agents.loadAgentsFromDir(dirB, "user");
                const byName = new Map();
                for (const list of [first, second]) for (const a of list) byName.set(a.name, a);
                assert.equal(byName.get("scout").description, "override");
            },
        ],
        [
            "writer: set preserves siblings and unknown keys",
            () => {
                const dir = path.join(root, "writer-keep");
                const before = {
                    maxConcurrent: 4,
                    custom: true,
                    agentModels: { worker: "prov/w" },
                    agentThinking: { worker: "xhigh" },
                };
                write(dir, "subagents.json", JSON.stringify(before));
                assert.equal(agents.writeAgentModel(dir, "scout", "prov/s"), true);
                assert.equal(agents.writeAgentThinking(dir, "scout", "high"), true);
                const after = JSON.parse(fs.readFileSync(path.join(dir, "subagents.json"), "utf8"));
                assert.equal(after.maxConcurrent, 4);
                assert.equal(after.custom, true);
                assert.deepEqual(after.agentModels, { worker: "prov/w", scout: "prov/s" });
                assert.deepEqual(after.agentThinking, { worker: "xhigh", scout: "high" });
            },
        ],
        [
            "writer: undefined deletes keys and emptied sections",
            () => {
                const dir = path.join(root, "writer-del");
                write(
                    dir,
                    "subagents.json",
                    JSON.stringify({
                        maxConcurrent: 4,
                        agentModels: { scout: "prov/s" },
                        agentThinking: { scout: "high", worker: "xhigh" },
                    }),
                );
                assert.equal(agents.writeAgentModel(dir, "scout", undefined), true);
                assert.equal(agents.writeAgentThinking(dir, "scout", undefined), true);
                const after = JSON.parse(fs.readFileSync(path.join(dir, "subagents.json"), "utf8"));
                assert.equal(after.maxConcurrent, 4);
                assert.ok(!("agentModels" in after));
                assert.deepEqual(after.agentThinking, { worker: "xhigh" });
            },
        ],
        [
            "writer: missing file created minimal",
            () => {
                const dir = path.join(root, "writer-new");
                assert.equal(agents.writeAgentThinking(dir, "scout", "low"), true);
                const after = JSON.parse(fs.readFileSync(path.join(dir, "subagents.json"), "utf8"));
                assert.deepEqual(after, { agentThinking: { scout: "low" } });
            },
        ],
        [
            "writer: malformed file replaced",
            () => {
                const dir = path.join(root, "writer-bad");
                write(dir, "subagents.json", "{oops");
                assert.equal(agents.writeAgentModel(dir, "scout", "prov/s"), true);
                const after = JSON.parse(fs.readFileSync(path.join(dir, "subagents.json"), "utf8"));
                assert.deepEqual(after, { agentModels: { scout: "prov/s" } });
            },
        ],
        [
            "writer: invalid values refused, file untouched",
            () => {
                const dir = path.join(root, "writer-invalid");
                const content = JSON.stringify({ maxConcurrent: 4, agentModels: { scout: "prov/s" } });
                write(dir, "subagents.json", content);
                assert.equal(agents.writeAgentModel(dir, "scout", "noslash"), false);
                assert.equal(agents.writeAgentModel(dir, "scout", "prov/a b"), false);
                assert.equal(agents.writeAgentThinking(dir, "scout", "ultra"), false);
                assert.equal(fs.readFileSync(path.join(dir, "subagents.json"), "utf8"), content);
            },
        ],
        [
            "writer: unwritable path returns false",
            () => {
                const dir = path.join(root, "writer-ro");
                write(dir, "blocker", "x");
                assert.equal(
                    agents.writeAgentModel(path.join(dir, "blocker"), "scout", "prov/s"),
                    false,
                );
            },
        ],
        [
            "duplicate-key frontmatter throws",
            () => {
                const dir = path.join(root, "dup");
                write(dir, "bad.md", md("name: x\nname: y"));
                assert.throws(() => agents.loadAgentsFromDir(dir, "user"));
            },
        ],
        [
            "settings: full file resolves both flags",
            () => {
                const dir = path.join(root, "settings-full");
                write(
                    dir,
                    "subagents.json",
                    JSON.stringify({
                        maxConcurrent: 4,
                        agentModels: { scout: "opencode-go/deepseek-v4.1-flash" },
                        agentThinking: { scout: "high" },
                    }),
                );
                const settings = agents.loadSubagentsSettings(dir);
                const flags = agents.resolveAgentFlags({ name: "scout", model: "fallback/m" }, settings);
                assert.equal(flags.modelFlag, ' --model "opencode-go/deepseek-v4.1-flash"');
                assert.equal(flags.thinkingFlag, ' --thinking "high"');
            },
        ],
        [
            "settings: missing and malformed fall back",
            () => {
                const missing = agents.loadSubagentsSettings(path.join(root, "nope"));
                assert.deepEqual(missing, {});
                const dir = path.join(root, "settings-bad");
                write(dir, "subagents.json", "{oops");
                assert.deepEqual(agents.loadSubagentsSettings(dir), {});
                const scout = agents.resolveAgentFlags({ name: "scout", model: "fallback/m" }, missing);
                assert.equal(scout.modelFlag, ' --model "fallback/m"');
                assert.equal(scout.thinkingFlag, ' --thinking "low"');
                const worker = agents.resolveAgentFlags({ name: "worker", model: "fallback/m" }, missing);
                assert.equal(worker.thinkingFlag, ' --thinking "high"');
                const other = agents.resolveAgentFlags({ name: "other", model: "fallback/m" }, missing);
                assert.equal(other.thinkingFlag, "");
            },
        ],
        [
            "settings: invalid entries dropped, valid kept",
            () => {
                const dir = path.join(root, "settings-mixed");
                write(
                    dir,
                    "subagents.json",
                    JSON.stringify({
                        agentModels: {
                            bad1: "noslash",
                            bad2: "prov/model; rm -rf",
                            bad3: "prov/mo`del",
                            good: "prov/ok",
                        },
                        agentThinking: { bad: "ultra", good: "low" },
                    }),
                );
                const settings = agents.loadSubagentsSettings(dir);
                assert.deepEqual(settings, {
                    agentModels: { good: "prov/ok" },
                    agentThinking: { good: "low" },
                });
            },
        ],
        [
            "settings: unknown agent keys kept, suffix passes through",
            () => {
                const dir = path.join(root, "settings-extra");
                write(
                    dir,
                    "subagents.json",
                    JSON.stringify({
                        agentModels: { ghost: "prov/model:high", scout: "prov/s" },
                        agentThinking: {},
                    }),
                );
                const settings = agents.loadSubagentsSettings(dir);
                const ghost = agents.resolveAgentFlags({ name: "ghost", model: "fallback/m" }, settings);
                assert.equal(ghost.modelFlag, ' --model "prov/model:high"');
                assert.equal(settings.agentThinking, undefined);
            },
        ],
    ],
    "agents loader",
);
