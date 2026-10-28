// Smoke test: load pi-tool-display the way Pi does and actually invoke the renderers.
// Catches runtime breakage (TDZ, swapped bindings, box-math throws) that tsc cannot.
//
// Everything resolves from the repo (see helpers.mjs), so the script is cwd-independent
// and never hardcodes an install path. The extension entry is read from the extension's
// own manifest's entry list, so repointing that entry keeps this script working.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, createTestJiti, runCases } from "./test/subagent/helpers.mjs";

const EXT_DIR = join(ROOT, "agent/extensions/pi-tool-display");
const manifest = JSON.parse(readFileSync(join(EXT_DIR, "package.json"), "utf8"));
const entryRel = manifest.pi.extensions[0];

// `moduleCache: false` matches production: the script never shares a module instance
// with another run.
const jiti = await createTestJiti(undefined, { moduleCache: false });
const mod = await jiti.import(join(EXT_DIR, entryRel), { default: true });
const factory = mod.default ?? mod;
if (typeof factory !== "function") throw new Error(`no factory default export at ${entryRel}`);

// Minimal ExtensionAPI stub that records registrations and captures the resolver.
let resolver;
const registered = { commands: [], events: [] };
const pi = {
    on: (event) => {
        registered.events.push(event);
    },
    registerTool: () => {},
    registerCommand: (name) => {
        registered.commands.push(name);
    },
    registerShortcut: () => {},
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    registerToolRenderer: (r) => {
        resolver = r;
    },
    getAllTools: () => [],
    getCommands: () => [],
    getFlag: () => undefined,
    events: { emit: () => {}, on: () => () => {} },
};

const started = Date.now();
factory(pi);
console.log(`factory() ok in ${Date.now() - started}ms; resolver=${typeof resolver}`);
if (typeof resolver !== "function") throw new Error("pi.registerToolRenderer was not called");
console.log(`commands=${registered.commands.join(",") || "(none)"}`);

const theme = {
    fg: (_c, t) => t,
    bg: (_c, t) => t,
    bold: (t) => t,
    getBgAnsi: () => "",
    colors: {},
};
const base = {
    cwd: ROOT,
    argsComplete: true,
    executionStarted: true,
    isPartial: false,
    isError: false,
    expanded: false,
    invalidate: () => {},
    outputPad: 0,
    showImages: true,
};

const cases = [
    // dedicated renderers (DEDICATED_TOOLS) + the powershell -> bash alias
    ["read", { path: "README.md" }],
    ["write", { path: "b.txt", content: "hello\nworld" }],
    ["edit", { path: "a.txt", oldText: "x", newText: "y" }],
    ["bash", { command: "git status", description: "check" }],
    ["powershell", { command: "Get-Date" }],
    // these four all render the boxed FALLBACK card (no by-name route in wiring.ts)
    ["grep", { pattern: "x", path: "." }],
    ["ls", { path: "." }],
    ["find", { pattern: "*.ts" }],
    ["fffind", { pattern: "smoke" }],
    // fork cards
    ["ocr_review", { path: "." }],
    ["query_sqlite", { dbPath: "x.db", query: "select 1" }],
    ["subagent", { agent: "scout", task: "hi" }],
];

await runCases(
    cases.map(([name, args]) => [
        name,
        () => {
            const renderers = resolver(name, () => {
                throw new Error(`resolver deferred to next() for ${name}`);
            });
            if (renderers?.renderShell !== "self") throw new Error(`renderShell=${renderers?.renderShell}`);
            // Fresh `state` per case: pi-style memoises components on state slots, so a
            // shared state would let one case's cached component answer another's.
            // `isPartial: false` everywhere: the first partial pass renders `[]` by design.
            // `outputPad: 0` makes withOutputPad a passthrough.
            const context = { ...base, args, state: {}, toolCallId: `call_${name}` };
            const callComponent = renderers.renderCall(args, theme, context);
            const pendingLines = callComponent.render(80);
            const resultLines = renderers
                .renderResult(
                    { content: [{ type: "text", text: "sample output\nline two" }], details: {} },
                    { expanded: false, isPartial: false },
                    theme,
                    context,
                )
                .render(80);
            // The settled repaint Pi performs once the result arrives. `read` and
            // `write` put the whole card in the call component (the batch-leader
            // panel / the footer state the call closes the box with), so their
            // result component renders `[]` by design — the settled pass is what
            // proves those two painted.
            const settledLines = callComponent.render(80);
            const painted = settledLines.length + resultLines.length;
            if (pendingLines.length === 0 || painted === 0) {
                throw new Error(
                    `rendered zero lines (call=${pendingLines.length} result=${resultLines.length} settled=${settledLines.length})`,
                );
            }
            return `call=${pendingLines.length}L result=${resultLines.length}L settled=${settledLines.length}L`;
        },
    ]),
    "12 renderer paths",
);
