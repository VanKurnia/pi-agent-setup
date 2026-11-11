// Loader gate: evaluates the zentui module graph the way Pi does, then calls the
// factory against a stub ExtensionAPI. Catches module-evaluation faults (TDZ,
// circular imports resolving to undefined, missing exports) and lost event
// wiring that `tsc --noEmit` cannot see. It renders nothing: footer, editor and
// user-message output stay unverified here.
import { join } from "node:path";
import { ROOT, createTestJiti } from "../subagent/helpers.mjs";

const ENTRY = join(ROOT, "agent/extensions/zentui/index.ts");

// Registered in index.ts, in file order. A change here is a deliberate change.
const EXPECTED_EVENTS = [
    "session_start",
    "session_shutdown",
    "agent_start",
    "turn_start",
    "agent_end",
    "model_select",
    "thinking_level_select",
    "session_info_changed",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "session_compact",
    "session_tree",
];

const failures = [];
let ran = 0;
const check = (name, condition, detail) => {
    ran++;
    if (condition) {
        console.log(`  ok   ${name}`);
        return;
    }
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

// `moduleCache: false` matches production: each run gets a fresh module graph.
const jiti = await createTestJiti(undefined, { moduleCache: false });

let mod;
try {
    mod = await jiti.import(ENTRY, { default: true });
    check("module graph evaluates", true);
} catch (error) {
    check("module graph evaluates", false, error?.stack ?? String(error));
}

const factory = mod?.default ?? mod;
check("default export is a factory", typeof factory === "function", typeof factory);

if (typeof factory === "function") {
    const events = [];
    const pi = {
        on: (name) => {
            events.push(name);
        },
        getThinkingLevel: () => "none",
    };

    try {
        factory(pi, {});
        check("factory runs against a stub ExtensionAPI", true);
    } catch (error) {
        check("factory runs against a stub ExtensionAPI", false, error?.stack ?? String(error));
    }

    const missing = EXPECTED_EVENTS.filter((name) => !events.includes(name));
    const unexpected = events.filter((name) => !EXPECTED_EVENTS.includes(name));
    check(
        `registers exactly ${EXPECTED_EVENTS.length} events`,
        missing.length === 0 && unexpected.length === 0,
        `missing=[${missing.join(",")}] unexpected=[${unexpected.join(",")}]`,
    );
}

console.log(`\n${ran - failures.length} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
