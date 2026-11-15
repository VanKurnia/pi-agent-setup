#!/usr/bin/env node
// Moves extension-owned JSON config from the agent dir root into agent/ext-config/.
//
// Idempotent and non-destructive: a file whose destination already exists is left alone in
// both places and reported, so a second run or a half-migrated machine is safe. Runtime data
// is not config and is never touched — blackhole's session store stays in agent/pi-blackhole/.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const PI_ROOT = resolve(process.argv[2] ?? ".");
const AGENT_DIR = join(PI_ROOT, "agent");
const TARGET_DIR = join(AGENT_DIR, "ext-config");

/** Source, relative to agent/, then destination name inside agent/ext-config/. */
const MOVES = [
    ["zentui.json", "zentui.json"],
    ["pi-speeed.json", "pi-speeed.json"],
    ["ext-presets.json", "ext-presets.json"],
    ["db-config.example.json", "db-config.example.json"],
    ["db-config.json", "db-config.json"],
    ["subagents.json", "subagents.json"],
    ["session-mgr-settings.json", "session-mgr-settings.json"],
    ["pi-blackhole/pi-blackhole-config.json", "pi-blackhole-config.json"],
];

/** Prefers a rename; falls back to copy+unlink when a cross-device or locked rename fails. */
function moveFile(from, to) {
    try {
        renameSync(from, to);
    } catch {
        copyFileSync(from, to);
        rmSync(from);
    }
}

let migrated = 0;
let collided = 0;

for (const [from, to] of MOVES) {
    const source = join(AGENT_DIR, from);
    if (!existsSync(source)) continue;
    const target = join(TARGET_DIR, to);
    if (existsSync(target)) {
        console.log(
            `skip    agent/${from}: agent/ext-config/${to} already exists — compare both, then delete the old copy`,
        );
        collided++;
        continue;
    }
    try {
        mkdirSync(TARGET_DIR, { recursive: true });
        moveFile(source, target);
        console.log(`migrate agent/${from} -> agent/ext-config/${to}`);
        migrated++;
    } catch (error) {
        console.error(`fail    agent/${from}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

if (existsSync(join(AGENT_DIR, "obsidian-config.json"))) {
    console.log("note    agent/obsidian-config.json is unread since the vault extension was dropped — safe to delete");
}

if (migrated === 0 && collided === 0) {
    console.log("ext-config: nothing to migrate");
} else {
    console.log(`ext-config: ${migrated} file(s) migrated, ${collided} collision(s) left in place`);
}
