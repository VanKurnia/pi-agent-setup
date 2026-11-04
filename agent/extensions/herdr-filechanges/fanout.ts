/**
 * Reaching the sub-agents this session started.
 *
 * A sub-agent is another pi process in another terminal, with its own tracker
 * and its own log, so the command has to be typed into it. `hc` is herdr-core's
 * own client, which keeps that protocol out of this folder. Only direct children
 * are listed: each runs the same command on its own children, so a deep tree is
 * covered one level at a time, each level waiting for the one below it.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FanOut, FanOutPlan } from "../shared/filechanges-core.ts";
import { DATA_DIR } from "./publish.ts";

/** `hc` waits for the core, not for the program; keep it well under a person's patience. */
const HC_TIMEOUT_MS = 20_000;
/** How often an awaited sub-agent's snapshot is re-read. */
const POLL_MS = 150;

type ListedTerminal = { address: string; parent?: string; status?: string };

function hc(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            "hc",
            args,
            { timeout: HC_TIMEOUT_MS, windowsHide: true },
            (err, stdout, stderr) => {
                if (!err) return resolve(stdout);
                // The core answers failures as one JSON line; its message is the
                // readable half, the rest is for whoever parses it.
                const reported = stderr.trim();
                let why = reported || err.message;
                try {
                    const parsed = JSON.parse(reported);
                    if (typeof parsed?.error?.message === "string") why = parsed.error.message;
                } catch {
                    // Plain text already; keep it.
                }
                reject(new Error(why));
            },
        );
    });
}

/** Files still logged by that terminal, or undefined when its snapshot is unreadable. */
async function logged(address: string): Promise<number | undefined> {
    try {
        const snapshot = JSON.parse(await readFile(join(DATA_DIR, `${address}.json`), "utf-8"));
        return Array.isArray(snapshot?.files) ? snapshot.files.length : undefined;
    } catch {
        return undefined;
    }
}

export const fanOut: FanOut = {
    plan: async (): Promise<FanOutPlan> => {
        const self = process.env.HC_TERMINAL_ID;
        if (!self) return { reachable: [], skipped: [] };

        let listed: ListedTerminal[];
        try {
            const parsed = JSON.parse(await hc(["ls", "--json"]));
            listed = Array.isArray(parsed?.terminals) ? parsed.terminals : [];
        } catch (err) {
            return {
                reachable: [],
                skipped: [],
                error: err instanceof Error ? err.message : String(err),
            };
        }

        const reachable: string[] = [];
        const skipped: { address: string; why: string }[] = [];
        for (const child of listed.filter((t) => t.parent === self)) {
            // Typing into a busy program would queue the command or land it
            // mid-turn, so those are reported, never typed into.
            if (child.status === "working") {
                skipped.push({ address: child.address, why: "still working" });
            } else if (child.status === "blocked") {
                skipped.push({ address: child.address, why: "waiting for you" });
            } else if ((await logged(child.address)) === undefined) {
                skipped.push({ address: child.address, why: "no change log" });
            } else {
                reachable.push(child.address);
            }
        }
        return { reachable, skipped };
    },

    // `force` because this process can never answer a child's confirm prompt.
    send: async (address, command) => {
        await hc(["send", address, `/filechanges-${command} force`]);
    },

    settled: async (address, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if ((await logged(address)) === 0) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
    },
};
