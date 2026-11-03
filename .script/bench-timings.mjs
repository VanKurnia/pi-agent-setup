// Shared implementation of bench-extensions.mjs and bench-extensions-pi-bolt.mjs.
//
// pi charges jiti's one-time loader initialization to whichever extension loads first, so that
// extension looks expensive while every later one looks cheap. The init is measured on its own —
// a boot whose only extension is an empty file — and reported as a separate row, so per-extension
// numbers stay comparable regardless of load order.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GROUP_HEADER = "--- Startup Timings: extensions ---";
const ENTRY = /^\s+(.+?)\s+(module import|factory):\s+(\d+)ms/;
const PROBE_SOURCE = "export default function (): void {}\n";
const LOADER_LABEL = "<jiti loader init, one-time> [module import]";
const isImport = (entry) => entry.label.endsWith("[module import]");

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const average = (values) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
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
function boot(bin, args, tmp, name) {
    const outFile = join(tmp, `${name}-out.txt`);
    const errFile = join(tmp, `${name}-err.txt`);
    const started = Date.now();
    try {
        execFileSync("cmd.exe", ["/c", bin, ...args, "<", "NUL", ">", outFile, "2>", errFile], {
            env: { ...process.env, PI_TIMING: "1" },
            stdio: "ignore",
            timeout: 120000,
        });
    } catch {
        /* exit code irrelevant; timings still printed */
    }
    const ms = Date.now() - started;
    return { ms, entries: parseEntries(readFileSync(errFile, "utf-8")) };
}

export function runExtensionBench(bin, tmpPrefix) {
    const runs = Number(process.argv[2] ?? 5);
    const args = ["--mode", "rpc", "--offline", "--no-session", ...process.argv.slice(3)];

    const tmp = mkdtempSync(join(tmpdir(), tmpPrefix));
    const probe = join(tmp, "loader-probe.ts");
    writeFileSync(probe, PROBE_SOURCE);

    const measured = [];
    // Probe boot alternates with each measured run so both see the same file-cache and CPU state.
    const probeMs = [];
    for (let i = 0; i < runs; i++) {
        measured.push(boot(bin, args, tmp, `m${i}`));
        // An empty extension pays the loader init and nothing else, which isolates it.
        const probeRun = boot(bin, [...args, "--no-extensions", "-e", probe], tmp, `i${i}`);
        probeMs.push(probeRun.entries.find(isImport)?.ms ?? 0);
    }
    rmSync(tmp, { recursive: true, force: true });
    // Without probe timings there is nothing to isolate; report the raw numbers unchanged.
    const loaderInit = probeMs.some((ms) => ms > 0) ? probeMs : null;

    const samples = new Map(); // label -> [ms...]
    const totals = [];
    const runtimes = [];
    const record = (label, ms) => {
        const series = samples.get(label) ?? [];
        series.push(ms);
        samples.set(label, series);
    };

    for (const [run, { ms, entries }] of measured.entries()) {
        // The boot's first module import is the one that paid the loader init.
        const payerIndex = entries.findIndex(isImport);
        let groupTotal = 0;
        for (const [index, entry] of entries.entries()) {
            let own = entry.ms;
            if (loaderInit && index === payerIndex) {
                const moved = Math.min(loaderInit[run], own);
                own -= moved;
                record(LOADER_LABEL, moved);
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
