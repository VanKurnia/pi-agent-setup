// The shared ANSI stripper must cover SGR, C1 CSI, OSC-8 (BEL and ST forms),
// APC and OSC titles. Each row was verified against the implementation before
// this test was written; a regression shows up as a literal escape in the output.
import { ROOT, createTestJiti, importProd } from "../subagent/helpers.mjs";

const jiti = await createTestJiti();
const { stripAnsi } = await importProd(jiti, "agent/extensions/shared/strip-ansi.ts");

const cases = [
    ["sgr", "A\x1b[31mB\x1b[0mC", "ABC"],
    ["c1 csi", "A\u009b1mB\u009b0mC", "ABC"],
    ["osc8 bel", "A\x1b]8;;https://x\x07L\x1b]8;;\x07C", "ALC"],
    ["osc8 st", "A\x1b]8;;https://x\x1b\\L\x1b]8;;\x1b\\C", "ALC"],
    ["apc", "A\x1b_Gpayload\x1b\\C", "AC"],
    ["osc title", "A\x1b]0;title\x07C", "AC"],
];

let failures = 0;
for (const [name, input, expected] of cases) {
    const actual = stripAnsi(input);
    if (actual === expected) {
        console.log(`  ok   ${name}`);
        continue;
    }
    failures++;
    console.log(`  FAIL ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log(`\n${cases.length - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
