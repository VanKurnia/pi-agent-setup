// Shared implementation of the .script benches that boot pi with PI_TIMING=1.
//
// pi's timing rows are a delta chain — each label reports `now - lastTime` (dist/core/timings.js),
// not its own duration — so two marks absorb work that does not belong to the extension they name.
// Both are measured on their own and reported as separate rows, so per-extension numbers stay
// comparable regardless of load order:
//
//   1. jiti's one-time loader init lands on the first module import.
//   2. The first built-in's `factory` mark lands after the whole tail of the extension phase —
//      path canonicalization, inline factories, and the GC that phase deferred. Built-ins are
//      imported by pi's own bundle before instrumentation exists and load last, so they never
//      emit a `module import` mark; whichever built-in loads first looks expensive.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GROUP_HEADER = "--- Startup Timings: extensions ---";
const ENTRY = /^\s+(.+?)\s+(module import|factory):\s+(\d+)ms/;
const PROBE_SOURCE = "export default function (): void {}\n";
const LOADER_LABEL = "<jiti loader init, one-time> [module import]";
const BUILTIN_LABEL = "<first builtin entry, one-time> [factory]";
const isImport = (entry) => entry.label.endsWith("[module import]");
const isBuiltinFactory = (entry) =>
    entry.label.startsWith("builtin:") && entry.label.endsWith("[factory]");
/** `builtin:mcp [factory]` -> `builtin:mcp`, the path `-e` expects. */
const builtinPath = (entry) => entry.label.slice(0, -" [factory]".length);

export const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const average = (values) =>
    Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
const pad = (value, width) => String(value).padStart(width);

/** Extension timing-group entries of one boot, in load order. */
function parseEntries(stderr) {
    const group = stderr.split(GROUP_HEADER)[1]?.split("-----")[0] ?? "";
    const entries = [];
    for (const line of group.split("\n")) {
        const match = ENTRY.exec(line);
        if (match) entries.push({ label: `${match[1]} [${match[2]}]`, ms: Number(match[3]) });
    }
    return entries;
}

/** One boot, timed to process exit. A nonzero exit code is irrelevant: timings print anyway. */
export function boot(bin, args, tmp, name, extraEnv = {}) {
    const outFile = join(tmp, `${name}-out.txt`);
    const errFile = join(tmp, `${name}-err.txt`);
    const started = Date.now();
    try {
        execFileSync("cmd.exe", ["/c", bin, ...args, "<", "NUL", ">", outFile, "2>", errFile], {
            env: { ...process.env, PI_TIMING: "1", ...extraEnv },
            stdio: "ignore",
            timeout: 120000,
        });
    } catch {
        /* exit code irrelevant; timings still printed */
    }
    const ms = Date.now() - started;
    const stderr = readFileSync(errFile, "utf-8");
    return { ms, entries: parseEntries(stderr), stderr };
}

/** A boot whose only extension is `path`, so the mark it lands on pays nothing else. */
const probeBoot = (bin, args, tmp, name, path) =>
    boot(bin, [...args, "--no-extensions", "-e", path], tmp, name).entries.find(isBuiltinFactory)
        ?.ms ?? 0;

/** The first built-in an ordinary boot loads, i.e. the one that inherits the phase tail. */
const firstBuiltin = (entries) => entries.find(isBuiltinFactory) ?? null;

/**
 * Median of the tail a boot's first built-in is charged, measured by loading that built-in alone.
 * Null when the boot loads no built-in or no timing came back.
 */
export function probeBuiltinTax(bin, args, tmp, runs, name = "builtin-tax") {
    const first = firstBuiltin(boot(bin, args, tmp, `${name}-discover`).entries);
    if (!first) return null;
    const samples = [];
    for (let i = 0; i < runs; i++) {
        samples.push(probeBoot(bin, args, tmp, `${name}${i}`, builtinPath(first)));
    }
    return samples.some((ms) => ms > 0) ? median(samples) : null;
}

/** `runs` is an optional leading integer; everything after it goes to pi. */
function parseRuns(raw, usage) {
    const [head, ...rest] = raw;
    if (head !== undefined && !/^\d+$/.test(head)) {
        throw new Error(`runs must be a positive integer, got "${head}"\n${usage}`);
    }
    const runs = Number(head ?? 5);
    if (runs < 1) throw new Error(`runs must be a positive integer, got "${head}"\n${usage}`);
    return { runs, extraArgs: head === undefined ? raw : rest };
}

export function runExtensionBench(bin, tmpPrefix) {
    const { runs, extraArgs } = parseRuns(
        process.argv.slice(2),
        `usage: node .script/bench-extensions*.mjs [runs=5] [-- <pi args>]`,
    );
    const args = ["--mode", "rpc", "--offline", "--no-session", ...extraArgs];

    const tmp = mkdtempSync(join(tmpdir(), tmpPrefix));
    const probe = join(tmp, "loader-probe.ts");
    writeFileSync(probe, PROBE_SOURCE);

    const measured = [];
    const loaderProbeMs = [];
    const builtinProbeMs = [];
    let firstBuiltinPath = null;
    // Probes alternate with each measured run so both see the same file-cache and CPU state.
    for (let i = 0; i < runs; i++) {
        const run = boot(bin, args, tmp, `m${i}`);
        measured.push(run);
        // An empty extension pays the loader init and nothing else, which isolates it.
        loaderProbeMs.push(
            boot(bin, [...args, "--no-extensions", "-e", probe], tmp, `i${i}`).entries.find(
                isImport,
            )?.ms ?? 0,
        );
        // The first built-in, loaded alone, pays the phase tail and nothing else.
        const first = firstBuiltin(run.entries);
        firstBuiltinPath ??= first ? builtinPath(first) : null;
        if (firstBuiltinPath) {
            builtinProbeMs.push(probeBoot(bin, args, tmp, `b${i}`, firstBuiltinPath));
        }
    }
    rmSync(tmp, { recursive: true, force: true });
    // Without probe timings there is nothing to isolate; report the raw numbers unchanged.
    const loaderInit = loaderProbeMs.some((ms) => ms > 0) ? loaderProbeMs : null;
    const builtinTax = builtinProbeMs.some((ms) => ms > 0) ? builtinProbeMs : null;

    const samples = new Map(); // label -> [ms...]
    const totals = [];
    const runtimes = [];
    const record = (label, ms) => {
        const series = samples.get(label) ?? [];
        series.push(ms);
        samples.set(label, series);
    };

    for (const [run, { ms, entries }] of measured.entries()) {
        // The boot's first module import paid the loader init; its first built-in paid the tail.
        const payerIndex = entries.findIndex(isImport);
        const builtinIndex = entries.findIndex(isBuiltinFactory);
        let groupTotal = 0;
        for (const [index, entry] of entries.entries()) {
            let own = entry.ms;
            if (loaderInit && index === payerIndex) {
                const moved = Math.min(loaderInit[run], own);
                own -= moved;
                record(LOADER_LABEL, moved);
            }
            if (builtinTax && index === builtinIndex) {
                const moved = Math.min(builtinTax[run], own);
                own -= moved;
                record(BUILTIN_LABEL, moved);
            }
            record(entry.label, own);
            groupTotal += entry.ms;
        }
        totals.push(groupTotal);
        runtimes.push(ms);
    }

    const HOME = process.env.USERPROFILE ?? "";
    const short = (label) => label.replace(HOME, "~").replace(/.*node_modules\\/, "npm:");
    const rows = [...samples.entries()]
        .map(([label, ms]) => ({
            label: short(label),
            mean: average(ms),
            med: median(ms),
            first: ms[0],
            min: Math.min(...ms),
            max: Math.max(...ms),
        }))
        .sort((a, b) => b.mean - a.mean);

    const totalMean = average(totals);
    console.log(
        `runs=${runs}  extension-load total: median ${median(totals)}ms  mean ${totalMean}ms  (min ${Math.min(...totals)} / max ${Math.max(...totals)})`,
    );
    console.log(`wall clock per boot: median ${median(runtimes)}ms`);
    const loaderSeries = samples.get(LOADER_LABEL);
    if (loaderSeries) {
        const payer = measured[0].entries.find(isImport)?.label ?? "";
        console.log(
            `loader init (jiti, one-time): median ${median(loaderSeries)}ms — charged to ${short(payer)}`,
        );
    }
    const builtinSeries = samples.get(BUILTIN_LABEL);
    if (builtinSeries) {
        console.log(
            `first builtin entry (phase tail, one-time): median ${median(builtinSeries)}ms — charged to ${firstBuiltinPath}`,
        );
    }
    console.log();
    console.log(
        "per-extension (module import + factory), ms:".padEnd(74) +
            " mean   med  cold   min  max  share",
    );
    for (const row of rows) {
        const share = ((row.mean / totalMean) * 100).toFixed(1);
        console.log(
            row.label.slice(0, 72).padEnd(74) +
                pad(row.mean, 5) +
                pad(row.med, 7) +
                pad(row.first, 6) +
                pad(row.min, 6) +
                pad(row.max, 5) +
                pad(`${share}%`, 7),
        );
    }

    if (process.env.SERIES) {
        console.log("\n--- raw per-run series (module import + factory) ---");
        const watch = [
            "pi-tool-display",
            "pi-blackhole",
            "smart-web-access",
            "subagents",
            "session-mgr",
            "open-code-review",
            "pi-zentui",
            "ext-mgr",
            LOADER_LABEL,
        ];
        for (const [label, ms] of samples) {
            if (!watch.some((name) => label.includes(name))) continue;
            console.log(short(label).padEnd(74) + ms.join(" "));
        }
        console.log("\ngroup totals per run: " + totals.join(" "));
        console.log("wall clock per run:   " + runtimes.join(" "));
    }
}
