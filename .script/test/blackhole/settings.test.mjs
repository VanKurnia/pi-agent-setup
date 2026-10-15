// Test: blackhole command surface and the `/blackhole-model` config editor.
// Run from repo root: node .script/test/blackhole/settings.test.mjs
//
// Points PI_CODING_AGENT_DIR at a temp dir so the real agent config is never
// touched, then drives the command's pickers with a stub ctx.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestJiti, importProd, runCases } from "../subagent/helpers.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "blackhole-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
assert.equal(
    getAgentDir(),
    agentDir,
    "PI_CODING_AGENT_DIR ignored; refusing to write anywhere else",
);

const CONFIG = join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
const writeConfig = (value) => {
    mkdirSync(join(agentDir, "pi-blackhole"), { recursive: true });
    writeFileSync(CONFIG, JSON.stringify(value, null, 2), "utf8");
};

const jiti = await createTestJiti();
const mod = await importProd(jiti, "agent/extensions/blackhole/index.js");
const factory = mod.default ?? mod;
const { isModelTarget } = await importProd(jiti, "agent/extensions/blackhole/config.js");

const commands = {};
factory({
    on: () => {},
    registerTool: () => {},
    registerCommand: (name, def) => {
        commands[name] = def;
    },
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
});
assert.equal(typeof commands["blackhole-model"]?.handler, "function", "blackhole-model missing");
assert.equal(typeof commands["blackhole-prune"]?.handler, "function", "blackhole-prune missing");
assert.equal(typeof commands["blackhole-memory"]?.handler, "function", "blackhole-memory missing");

/**
 * Drive the settings menu. `picks` feeds the searchable pickers in order — the
 * value to choose, or null for Esc; `inputs` feeds the number prompts. Every
 * screen is rendered, so a component that cannot draw fails the test rather than
 * only the terminal.
 */
async function runMenu(picks, inputs = []) {
    const notes = [];
    const screens = [];
    const remaining = [...picks];
    const answers = [...inputs];
    // SelectList/Text only call theme.fg(style, text) and theme.bold(text).
    const theme = new Proxy({}, { get: () => (a, b) => (b === undefined ? a : b) });
    const ctx = {
        hasUI: true,
        cwd: process.cwd(),
        modelRegistry: {
            getAvailable: () => [
                { provider: "9router", id: "alpha" },
                { provider: "9router", id: "beta" },
            ],
        },
        ui: {
            notify: (message) => notes.push(message),
            input: async () => answers.shift(),
            custom: (build) => {
                const view = build({ requestRender() {} }, theme, {}, () => {});
                screens.push(view.render(120).join("\n"));
                return Promise.resolve(remaining.length > 0 ? remaining.shift() : null);
            },
        },
    };
    await commands["blackhole-model"].handler("", ctx);
    return { notes, screens };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("picking a model writes provider/id and keeps other keys", async () => {
    writeConfig({
        memory: true,
        customKey: { keep: 1 },
        observerModel: { _comment: "old note", provider: "9router", id: "beta", thinking: "low" },
    });
    await runMenu(["observerModel", "9router/alpha", null]);

    const config = readConfig();
    assert.deepEqual(config.observerModel, {
        provider: "9router",
        id: "alpha",
        thinking: "low",
    });
    assert.equal(config.observerModel._comment, undefined, "stale note survived");
    assert.deepEqual(config.customKey, { keep: 1 }, "unknown key was dropped");
    assert.equal(config.memory, true, "untouched key changed");
});

test("the unset row removes the key", async () => {
    writeConfig({ model: { provider: "9router", id: "beta" } });
    await runMenu(["model", "__unset__", null]);
    assert.equal("model" in readConfig(), false);
});

test("a choice writes its typed value, not its label", async () => {
    writeConfig({ memory: true });
    await runMenu(["memory", "false", null]);
    assert.equal(readConfig().memory, false);
});

test("a number is stored, and an empty input unsets it", async () => {
    writeConfig({});
    await runMenu(["recallResponseMaxChars", null], ["5000"]);
    assert.equal(readConfig().recallResponseMaxChars, 5000);

    await runMenu(["recallResponseMaxChars", null], [""]);
    assert.equal("recallResponseMaxChars" in readConfig(), false);
});

test("an out-of-range ratio is rejected without writing", async () => {
    writeConfig({});
    const notes = (await runMenu(["compactAfterRatio", null], ["2"])).notes;
    assert.equal("compactAfterRatio" in readConfig(), false);
    assert.ok(
        notes.some((n) => n.includes("Auto-compact after ratio")),
        "no rejection notice",
    );
});

test("the menu draws its fields", async () => {
    writeConfig({});
    const { screens } = await runMenu([null]);
    const menu = screens[0] ?? "";
    for (const label of ["Model (worker fallback)", "Observer model", "Reflector model"]) {
        assert.ok(menu.includes(label), `menu is missing "${label}":\n${menu}`);
    }
});

test("an entry missing provider or id is not usable", () => {
    assert.equal(isModelTarget({ provider: "9router", id: "alpha" }), true);
    assert.equal(isModelTarget({ id: "alpha" }), false);
    assert.equal(isModelTarget({ provider: "9router" }), false);
    assert.equal(isModelTarget(undefined), false);
});

test("the menu reports a provider-less entry as unset", async () => {
    writeConfig({ model: { id: "alpha" } });
    const { screens } = await runMenu([null]);
    assert.ok(screens[0].includes("unset (worker off)"), screens[0]);
});

test("Esc on the menu leaves the file alone", async () => {
    writeConfig({ memory: false });
    const before = readFileSync(CONFIG, "utf8");
    await runMenu([null]);
    assert.equal(readFileSync(CONFIG, "utf8"), before);
});

await runCases(cases, "\nblackhole settings");
