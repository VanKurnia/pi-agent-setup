// Smoke test: load pi-tool-display the way Pi does and actually invoke the renderers.
// Catches runtime breakage (TDZ, bad merges) that tsc cannot.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PI = pathToFileURL(resolve("C:/npm-global/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js")).href;
const { createJiti } = await import(PI);
const require = createRequire(import.meta.url);

const pkgIndex = "C:/npm-global/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const tuiIndex = "C:/npm-global/node_modules/@earendil-works/pi-tui/dist/index.js";
const NM = "C:/npm-global/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works";
const alias = {
    "@earendil-works/pi-coding-agent": pkgIndex,
    "@earendil-works/pi-tui": `${NM}/pi-tui/dist/index.js`,
};

const jiti = createJiti(import.meta.url, { moduleCache: false, alias });

const entry = resolve("agent/extensions/pi-tool-display/index.ts");
const mod = await jiti.import(entry, { default: true });
const factory = mod.default ?? mod;
console.log("factory:", typeof factory);

// minimal ExtensionAPI stub that records registrations
const registered = { tools: [], commands: [], events: [] };
const pi = {
    on: (e) => registered.events.push(e),
    registerTool: (t) => registered.tools.push(t.name),
    registerCommand: (n) => registered.commands.push(n),
    registerShortcut: () => {},
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    getAllTools: () => [],
    getCommands: () => [],
    getFlag: () => undefined,
    events: { emit: () => {}, on: () => () => {} },
};

const started = Date.now();
factory(pi);
console.log(`factory() ok in ${Date.now() - started}ms; commands=${registered.commands.join(",")}`);

// Drive the renderers through the real production path: the prototype patch the
// extension installs on ToolExecutionComponent. Avoids reaching into internals.
const wiring = await jiti.import(resolve("agent/extensions/pi-tool-display/src/wiring.ts"));
const { loadToolDisplayConfig } = await jiti.import(resolve("agent/extensions/pi-tool-display/src/support.ts"));
const { ToolExecutionComponent } = await jiti.import(pkgIndex);
const config = loadToolDisplayConfig().config;

if (wiring.installPistyleToolRendererPatch(() => config) !== true) {
    console.log("  FAIL renderer patch did not install");
    process.exit(1);
}

const theme = {
    fg: (_c, t) => t,
    bg: (_c, t) => t,
    bold: (t) => t,
    getBgAnsi: () => "",
    colors: {},
};
const ctx = {
    args: {},
    toolCallId: "call_1",
    state: { elapsedMs: 1234 },
    cwd: process.cwd(),
    argsComplete: true,
    executionStarted: true,
    expanded: false,
    invalidate: () => {},
};

const cases = [
    ["read", { path: "README.md" }],
    ["bash", { command: "git status", description: "check" }],
    ["edit", { path: "a.txt", oldText: "x", newText: "y" }],
    ["write", { path: "b.txt", content: "hello\nworld" }],
    ["grep", { pattern: "x", path: "." }],
    ["ls", { path: "." }],
    ["find", { pattern: "*.ts" }],
    ["totally_unknown_tool", { foo: 1 }],
    ["ocr_review", { action: "review", path: "." }],
    ["db_query", { sql: "select 1" }],
    ["subagent", { prompt: "hi" }],
];

let pass = 0, fail = 0;
for (const [name, args] of cases) {
    try {
        const instance = {
            toolName: name,
            getRenderShell: () => "self",
            selfRenderContainer: { setBgFn() {}, paddingX: 1, paddingY: 1 },
            contentBox: { setBgFn() {}, paddingX: 1, paddingY: 1 },
            contentText: { setCustomBgFn() {} },
            invalidate() {},
        };
        const proto = ToolExecutionComponent.prototype;
        const callRenderer = proto.getCallRenderer.call(instance);
        const resultRenderer = proto.getResultRenderer.call(instance);
        if (typeof callRenderer !== "function" || typeof resultRenderer !== "function")
            throw new Error("patched selector did not return a renderer");

        const context = { ...ctx, args };
        const call = callRenderer(args, theme, context);
        const result = resultRenderer(
            { content: [{ type: "text", text: "sample output\nline two" }], details: { elapsedMs: 1234 } },
            { expanded: false, isPartial: false },
            theme,
            context,
        );
        if (!call || !result) throw new Error("renderer returned empty");
        console.log(`  ok   ${name.padEnd(22)} call=${call.constructor?.name ?? typeof call} result=${result.constructor?.name ?? typeof result}`);
        pass++;
    } catch (e) {
        console.log(`  FAIL ${name.padEnd(22)} ${e.message}`);
        fail++;
    }
}
wiring.removePistyleToolRendererPatch();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);