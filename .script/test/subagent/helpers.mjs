// Shared harness for the model-free extension behavior tests in this dir.
//
// - createTestJiti(): pi's jiti-loader with repo-local aliases (no hardcoded
//   install paths). The default module cache stays ON so stubs and extensions
//   share module instances, mirroring production.
// - importProd(): import an extension module by repo-relative path. The path
//   MUST use the `.js` shape production code uses (never `.ts`): jiti keys
//   module instances by specifier shape, so a `.ts` import silently evaluates
//   a second copy the code under test never sees.
// - textMsg()/toolMsg(): minimal session message builders.
// - runCases(): sequential case runner; exits non-zero on failure.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const realPkgPath = fileURLToPath(await import.meta.resolve("@earendil-works/pi-coding-agent"));
const tuiPath = fileURLToPath(await import.meta.resolve("@earendil-works/pi-tui"));
const loaderUrl = pathToFileURL(
    resolve(
        ROOT,
        "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js",
    ),
).href;

export async function createTestJiti(pkgAlias = realPkgPath, extraOpts = {}) {
    const { createJiti } = await import(loaderUrl);
    return createJiti(import.meta.url, {
        ...extraOpts,
        alias: {
            "@earendil-works/pi-coding-agent": pkgAlias,
            "@earendil-works/pi-tui": tuiPath,
        },
    });
}

/** Import an extension TS module the way production resolves it (`.js` shape). */
export function importProd(jiti, relPath) {
    return jiti.import(resolve(ROOT, relPath));
}

export const textMsg = (role, text) => ({ role, content: [{ type: "text", text }] });
export const toolMsg = (path) => ({
    role: "assistant",
    content: [{ type: "toolCall", arguments: { path } }],
});

export async function runCases(cases, footer) {
    let pass = 0;
    let fail = 0;
    for (const [name, fn] of cases) {
        try {
            await fn();
            pass++;
            console.log(`  ok   ${name}`);
        } catch (e) {
            fail++;
            console.log(`  FAIL ${name}: ${e.message}`);
        }
    }
    if (footer) console.log(footer);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}
