// Benchmark: wall-clock boot cost with main/extension timing attribution.
//
// The per-extension timing group is an attribution metric, not a boot metric:
// moving an import from an extension factory into a `session_start` handler
// shrinks the extension row while the process still pays the cost before the
// first prompt. This script reports the numbers that cannot be gamed that way:
// process wall clock, pi's own `main TOTAL`, and the extensions group total,
// plus a stability verdict so "boot is faster" claims stay falsifiable.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boot } from "./bench-timings.mjs";

const MAIN_HEADER = "--- Startup Timings: main ---";
const EXT_HEADER = "--- Startup Timings: extensions ---";
const STABLE_RATIO = 0.15;
// Loads the target inside the probe's factory, i.e. after pi has already paid jiti's one-time init,
// so the measured span is the module's own transform + evaluation and needs no cross-boot subtraction.
const MODULE_PROBE_SOURCE = [
    'import { pathToFileURL } from "node:url";',
    "",
    "export default async function (): Promise<void> {",
    '    const url = pathToFileURL(process.env.PROBE_MODULE ?? "").href;',
    "    const started = performance.now();",
    "    await import(url);",
    "    console.error(`MODULE_COST ${Math.round((performance.now() - started) * 10) / 10}ms`);",
    "}",
    "",
].join("\n");

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return medianOfSorted(sorted);
};
function medianOfSorted(sorted) {
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
/** Inter-quartile range via Tukey hinges; 0 for a single sample. */
function iqr(values) {
    if (values.length < 2) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const lower = sorted.slice(0, mid);
    const upper = sorted.length % 2 ? sorted.slice(mid + 1) : sorted.slice(mid);
    return medianOfSorted(upper) - medianOfSorted(lower);
}
/** Median/IQR over the numeric entries; nulls (unparseable groups) are ignored. */
function summarize(values) {
    const nums = values.filter((value) => typeof value === "number");
    if (nums.length === 0) return { median: null, iqr: null };
    return { median: median(nums), iqr: iqr(nums) };
}
/** `stable` when IQR/median < 0.15 for wall clock, else the UNSTABLE verdict. */
function verdict(walls) {
    const { median: med, iqr: spread } = summarize(walls);
    if (med === null) return "UNSTABLE — raise --runs or close other work";
    const ratio = med === 0 ? (spread === 0 ? 0 : Number.POSITIVE_INFINITY) : spread / med;
    return ratio < STABLE_RATIO ? "stable" : "UNSTABLE — raise --runs or close other work";
}

/** Raw text of one timing group; "" when pi never printed that header. */
function groupSlice(stderr, header) {
    return stderr.split(header)[1]?.split("-----")[0] ?? "";
}
/** The `TOTAL: Nms` row of one timing group; null when it cannot be parsed. */
function parseGroupTotal(stderr, header) {
    const match = /^\s*TOTAL:\s*(\d+)ms/m.exec(groupSlice(stderr, header));
    return match ? Number(match[1]) : null;
}
const sumEntries = (entries) => entries.reduce((sum, entry) => sum + entry.ms, 0);

/** One boot reduced to the three numbers this script reports. */
function timeBoot(tmp, args, name) {
    const { ms, entries, stderr } = boot("pi", args, tmp, name);
    return {
        wall: ms,
        main: parseGroupTotal(stderr, MAIN_HEADER),
        ext: parseGroupTotal(stderr, EXT_HEADER) ?? sumEntries(entries),
    };
}

/** Split a `--ab "--flag x --flag y"` string the way a shell would (quotes honoured). */
function splitFlags(text) {
    const out = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match = pattern.exec(text);
    while (match) {
        out.push(match[1] ?? match[2] ?? match[3]);
        match = pattern.exec(text);
    }
    return out;
}

function usage() {
    return [
        "usage: node .script/bench-boot.mjs [runs=5] [--json] [--module <path>] [--ab \"<flags>\"] [-- <extra pi args>]",
        "  default: interleave-free boots reporting wall clock, main TOTAL, extensions TOTAL",
        "  --json: one JSON object with per-run arrays and medians",
        '  --module <path>: that module\'s own evaluation cost, timed inside a probe extension factory',
        '  --ab "<flags>": interleave A (base args) and B (base args + flags), report B-A deltas',
    ].join("\n");
}
function parseArgs(raw) {
    const opts = { runs: 5, json: false, module: null, ab: null, extra: [] };
    let seenRuns = false;
    for (let i = 0; i < raw.length; i++) {
        const arg = raw[i];
        if (arg === "--") {
            opts.extra.push(...raw.slice(i + 1));
            break;
        } else if (arg === "--json") {
            opts.json = true;
        } else if (arg === "--module") {
            opts.module = raw[++i] ?? null;
            if (opts.module === null) {
                console.error("missing <path> after --module\n" + usage());
                process.exit(2);
            }
        } else if (arg === "--ab") {
            opts.ab = raw[++i] ?? null;
            if (opts.ab === null) {
                console.error('missing "<flags>" after --ab\n' + usage());
                process.exit(2);
            }
        } else if (!seenRuns && /^\d+$/.test(arg)) {
            opts.runs = Number(arg);
            seenRuns = true;
        } else {
            opts.extra.push(arg);
        }
    }
    return opts;
}

const msCell = (value) => (typeof value === "number" ? `${value}ms` : "n/a");
const rowCells = (values) => values.map(msCell).join(" ");

function printBootBlock(title, walls, mains, exts) {
    const wall = summarize(walls);
    const main = summarize(mains);
    const ext = summarize(exts);
    console.log(`${title}: runs=${walls.length}`);
    console.log(`wall clock: median ${msCell(wall.median)}  IQR ${msCell(wall.iqr)}  (per run: ${rowCells(walls)})`);
    console.log(`main TOTAL: median ${msCell(main.median)}  (per run: ${rowCells(mains)})`);
    console.log(`extensions TOTAL: median ${msCell(ext.median)}  (per run: ${rowCells(exts)})`);
    console.log(verdict(walls));
}

function runBoot(tmp, baseArgs, opts) {
    const walls = [];
    const mains = [];
    const exts = [];
    for (let i = 0; i < opts.runs; i++) {
        const row = timeBoot(tmp, baseArgs, `b${i}`);
        walls.push(row.wall);
        mains.push(row.main);
        exts.push(row.ext);
    }
    if (opts.json) {
        console.log(
            JSON.stringify({
                mode: "boot",
                runs: opts.runs,
                wall: walls,
                wallMedian: summarize(walls).median,
                wallIqr: summarize(walls).iqr,
                main: mains,
                mainMedian: summarize(mains).median,
                extensions: exts,
                extensionsMedian: summarize(exts).median,
                verdict: verdict(walls),
            }),
        );
        return;
    }
    printBootBlock("boot", walls, mains, exts);
}

function runAb(tmp, baseArgs, opts) {
    const sideArgs = [...baseArgs, ...splitFlags(opts.ab)];
    const a = { walls: [], mains: [], exts: [] };
    const b = { walls: [], mains: [], exts: [] };
    // A and B alternate within one process run so both see the same machine state.
    for (let i = 0; i < opts.runs; i++) {
        const rowA = timeBoot(tmp, baseArgs, `a${i}`);
        a.walls.push(rowA.wall);
        a.mains.push(rowA.main);
        a.exts.push(rowA.ext);
        const rowB = timeBoot(tmp, sideArgs, `b${i}`);
        b.walls.push(rowB.wall);
        b.mains.push(rowB.main);
        b.exts.push(rowB.ext);
    }
    const delta = (x, y) => (typeof x === "number" && typeof y === "number" ? y - x : null);
    const deltaWall = delta(summarize(a.walls).median, summarize(b.walls).median);
    const deltaMain = delta(summarize(a.mains).median, summarize(b.mains).median);
    const deltaExt = delta(summarize(a.exts).median, summarize(b.exts).median);
    if (opts.json) {
        console.log(
            JSON.stringify({
                mode: "ab",
                runs: opts.runs,
                ab: opts.ab,
                a: {
                    wall: a.walls,
                    wallMedian: summarize(a.walls).median,
                    main: a.mains,
                    mainMedian: summarize(a.mains).median,
                    extensions: a.exts,
                    extensionsMedian: summarize(a.exts).median,
                    verdict: verdict(a.walls),
                },
                b: {
                    wall: b.walls,
                    wallMedian: summarize(b.walls).median,
                    main: b.mains,
                    mainMedian: summarize(b.mains).median,
                    extensions: b.exts,
                    extensionsMedian: summarize(b.exts).median,
                    verdict: verdict(b.walls),
                },
                delta: { wall: deltaWall, main: deltaMain, extensions: deltaExt },
            }),
        );
        return;
    }
    printBootBlock("side A (base)", a.walls, a.mains, a.exts);
    console.log();
    printBootBlock(`side B (${opts.ab})`, b.walls, b.mains, b.exts);
    console.log();
    const signed = (value) => (value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value}ms`);
    console.log(`delta (B-A): wall ${signed(deltaWall)}  main ${signed(deltaMain)}  extensions ${signed(deltaExt)}`);
}

/** The `MODULE_COST <n>ms` line the probe extension prints from inside its factory. */
function parseModuleCost(stderr) {
    const match = /MODULE_COST\s+([\d.]+)ms/.exec(stderr);
    return match ? Number(match[1]) : null;
}

function runModule(tmp, baseArgs, opts) {
    const abs = resolve(opts.module);
    const probeFile = join(tmp, "module-cost-probe.ts");
    writeFileSync(probeFile, MODULE_PROBE_SOURCE);
    const args = [...baseArgs, "--no-extensions", "-e", probeFile];

    const costs = [];
    for (let i = 0; i < opts.runs; i++) {
        const { stderr } = boot("pi", args, tmp, `m${i}`, { PROBE_MODULE: abs });
        costs.push(parseModuleCost(stderr));
    }
    const med = summarize(costs).median;
    if (opts.json) {
        console.log(JSON.stringify({ mode: "module", module: abs, runs: opts.runs, cost: costs, costMedian: med }));
        return;
    }
    console.log(`module: ${opts.module}`);
    console.log(`resolved: ${abs}`);
    console.log(`runs=${opts.runs}`);
    console.log(`module cost (warm runtime, in-factory import): median ${msCell(med)}`);
    console.log(`per-run: ${rowCells(costs)}`);
}

const opts = parseArgs(process.argv.slice(2));
if (!Number.isInteger(opts.runs) || opts.runs < 1) {
    console.error(`runs must be a positive integer, got ${process.argv[2]}\n` + usage());
    process.exit(2);
}
if (opts.module !== null && opts.ab !== null) {
    console.error("--module and --ab are mutually exclusive\n" + usage());
    process.exit(2);
}
const baseArgs = ["--mode", "rpc", "--offline", "--no-session", ...opts.extra];

const tmp = mkdtempSync(join(tmpdir(), "piboot-"));
try {
    if (opts.module !== null) runModule(tmp, baseArgs, opts);
    else if (opts.ab !== null) runAb(tmp, baseArgs, opts);
    else runBoot(tmp, baseArgs, opts);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
