// Benchmark: what a boot costs, in numbers that cannot be gamed by deferring work.
//
// pi's per-extension rows are an attribution metric: an import moved into a `session_start`
// handler shrinks them while the process still pays the cost before the first prompt. So report
// process wall clock, pi's own `main TOTAL`, and the extensions group total, with a stability
// verdict that keeps "boot is faster" claims falsifiable.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boot, median } from "./bench-timings.mjs";

const MAIN_HEADER = "--- Startup Timings: main ---";
const EXT_HEADER = "--- Startup Timings: extensions ---";
const MODULE_COST = /MODULE_COST\s+([\d.]+)ms/;
const STABLE_RATIO = 0.15;
const UNSTABLE = "UNSTABLE — raise --runs or close other work";
const USAGE = [
    'usage: node .script/bench-boot.mjs [runs=5] [--json] [--ab "<flags>"] [--module <path>] [-- <pi args>]',
    "  default: wall clock, pi's main TOTAL and the extensions group total, with a stability verdict",
    "  --json: the same numbers as one machine-readable object",
    '  --ab "<flags>": interleave the base boot with one carrying these flags, report B-A deltas',
    "  --module <path>: that module's own evaluation cost, timed inside a probe extension factory",
].join("\n");

// Timed from inside the probe's factory, i.e. after pi has paid jiti's one-time init, so the span
// is this module's own transform + evaluation rather than a cross-boot difference.
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

function fail(message) {
    console.error(`${message}\n${USAGE}`);
    process.exit(2);
}

/** Median and Tukey-hinge inter-quartile range; unparseable samples are ignored. */
function summarize(values) {
    const nums = values.filter(Number.isFinite);
    if (nums.length === 0) return { median: null, iqr: 0 };
    if (nums.length === 1) return { median: nums[0], iqr: 0 };
    const sorted = nums.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const lower = sorted.slice(0, mid);
    const upper = sorted.length % 2 ? sorted.slice(mid + 1) : sorted.slice(mid);
    return { median: median(sorted), iqr: median(upper) - median(lower) };
}

const verdict = ({ median: med, iqr }) => (med > 0 && iqr / med < STABLE_RATIO ? "stable" : UNSTABLE);

/** The `TOTAL: Nms` row of one timing group; null when pi never printed that group. */
function groupTotal(stderr, header) {
    const group = stderr.split(header)[1]?.split("-----")[0] ?? "";
    const match = /^\s*TOTAL:\s*(\d+)ms/m.exec(group);
    return match ? Number(match[1]) : null;
}

/** pi omits the extensions group entirely when nothing loads, which costs nothing. */
const extensionsTotal = (stderr) => groupTotal(stderr, EXT_HEADER) ?? 0;

/** Boots every plan once per run, interleaved, so all sides see the same machine state. */
function measure(runs, plans) {
    const sides = plans.map(() => ({ wall: [], main: [], ext: [] }));
    for (let i = 0; i < runs; i++) {
        plans.forEach(({ label, args }, index) => {
            const { ms, stderr } = boot("pi", args, tmp, `${label}${i}`);
            const side = sides[index];
            side.wall.push(ms);
            side.main.push(groupTotal(stderr, MAIN_HEADER));
            side.ext.push(extensionsTotal(stderr));
        });
    }
    return sides;
}

const mm = (value) => (value === null ? "n/a" : `${value}ms`);
const cells = (values) => values.map(mm).join(" ");
const statsOf = (side) => ({ wall: summarize(side.wall), main: summarize(side.main), ext: summarize(side.ext) });
const medianDelta = (a, b) => (a.median === null || b.median === null ? null : b.median - a.median);

function printSide(title, side) {
    const stats = statsOf(side);
    console.log(`${title}: runs=${side.wall.length}`);
    console.log(`wall clock: median ${mm(stats.wall.median)}  IQR ${mm(stats.wall.iqr)}  (per run: ${cells(side.wall)})`);
    console.log(`main TOTAL: median ${mm(stats.main.median)}  (per run: ${cells(side.main)})`);
    console.log(`extensions TOTAL: median ${mm(stats.ext.median)}  (per run: ${cells(side.ext)})`);
    console.log(verdict(stats.wall));
}

function jsonSide(side) {
    const stats = statsOf(side);
    return {
        wall: side.wall,
        wallMedian: stats.wall.median,
        wallIqr: stats.wall.iqr,
        main: side.main,
        mainMedian: stats.main.median,
        extensions: side.ext,
        extensionsMedian: stats.ext.median,
        verdict: verdict(stats.wall),
    };
}

function runBoot(opts) {
    const [side] = measure(opts.runs, [{ label: "r", args: BASE_ARGS }]);
    if (opts.json) {
        console.log(JSON.stringify({ mode: "boot", runs: opts.runs, ...jsonSide(side) }));
        return;
    }
    printSide("boot", side);
}

function runAb(opts) {
    const flags = opts.ab.split(/\s+/).filter(Boolean);
    const [a, b] = measure(opts.runs, [
        { label: "a", args: BASE_ARGS },
        { label: "b", args: [...BASE_ARGS, ...flags] },
    ]);
    const statsA = statsOf(a);
    const statsB = statsOf(b);
    const deltas = {
        wall: medianDelta(statsA.wall, statsB.wall),
        main: medianDelta(statsA.main, statsB.main),
        extensions: medianDelta(statsA.ext, statsB.ext),
    };
    if (opts.json) {
        console.log(JSON.stringify({ mode: "ab", runs: opts.runs, ab: opts.ab, a: jsonSide(a), b: jsonSide(b), delta: deltas }));
        return;
    }
    printSide("side A (base)", a);
    console.log();
    printSide(`side B (${opts.ab})`, b);
    console.log();
    const signed = (value) => (value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value}ms`);
    console.log(
        `delta (B-A): wall ${signed(deltas.wall)}  main ${signed(deltas.main)}  extensions ${signed(deltas.extensions)}`,
    );
}

function runModule(opts) {
    const target = resolve(opts.module);
    const probeFile = join(tmp, "module-probe.ts");
    writeFileSync(probeFile, MODULE_PROBE_SOURCE);
    const args = [...BASE_ARGS, "--no-extensions", "-e", probeFile];
    const costs = [];
    for (let i = 0; i < opts.runs; i++) {
        const { stderr } = boot("pi", args, tmp, `m${i}`, { PROBE_MODULE: target });
        const match = MODULE_COST.exec(stderr);
        costs.push(match ? Number(match[1]) : null);
    }
    const { median: med } = summarize(costs);
    if (opts.json) {
        console.log(JSON.stringify({ mode: "module", module: target, runs: opts.runs, cost: costs, costMedian: med }));
        return;
    }
    console.log(`module: ${opts.module}`);
    console.log(`resolved: ${target}`);
    console.log(`runs=${opts.runs}`);
    console.log(`module cost (warm runtime, in-factory import): median ${mm(med)}`);
    console.log(`per-run: ${cells(costs)}`);
}

/** `runs` is the optional leading positional; pi args go after `--`. */
function parseArgs(raw) {
    const [head, ...rest] = raw;
    const hasRuns = /^\d+$/.test(head ?? "");
    const opts = { runs: hasRuns ? Number(head) : 5, json: false, module: null, ab: null, extra: [] };
    const args = hasRuns ? rest : raw;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            opts.extra = args.slice(i + 1);
            break;
        } else if (arg === "--json") {
            opts.json = true;
        } else if (arg === "--module") {
            opts.module = args[++i] ?? fail("missing <path> after --module");
        } else if (arg === "--ab") {
            opts.ab = args[++i] ?? fail('missing "<flags>" after --ab');
        } else {
            fail(`unknown argument: ${arg}`);
        }
    }
    if (opts.runs < 1) fail(`runs must be a positive integer, got ${head}`);
    if (opts.module !== null && opts.ab !== null) fail("--module and --ab are mutually exclusive");
    return opts;
}

const opts = parseArgs(process.argv.slice(2));
const BASE_ARGS = ["--mode", "rpc", "--offline", "--no-session", ...opts.extra];
const tmp = mkdtempSync(join(tmpdir(), "piboot-"));
try {
    if (opts.module !== null) runModule(opts);
    else if (opts.ab !== null) runAb(opts);
    else runBoot(opts);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
