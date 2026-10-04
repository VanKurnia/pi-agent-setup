// Benchmark: run pi N times with PI_TIMING=1, aggregate per-extension load times.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNS = Number(process.argv[2] ?? 5);
const EXTRA = process.argv.slice(3);

const tmp = mkdtempSync(join(tmpdir(), "pibench-"));

const samples = new Map(); // label -> [ms...]
let totals = [];
let runtimes = [];

for (let i = 0; i < RUNS; i++) {
    // Unique output file per run: reusing one path made stale content leak between runs.
    const outFile = join(tmp, `out-${i}.txt`);
    const errFile = join(tmp, `err-${i}.txt`);
    const started = Date.now();
    try {
        execFileSync(
            "cmd.exe",
            ["/c", "pi", "--mode", "rpc", "--offline", "--no-session", ...EXTRA, "<", "NUL", ">", outFile, "2>", errFile],
            { env: { ...process.env, PI_TIMING: "1" }, stdio: "ignore", timeout: 120000 },
        );
    } catch { /* exit code irrelevant; timings still printed */ }
    runtimes.push(Date.now() - started);

    const err = readFileSync(errFile, "utf-8");
    const group = err.split("--- Startup Timings: extensions ---")[1]?.split("-----")[0] ?? "";
    let groupTotal = 0;
    for (const line of group.split("\n")) {
        const m = /^\s+(.+?)\s+(module import|factory):\s+(\d+)ms/.exec(line);
        if (m) {
            const key = m[1].replace(/^builtin:/, "builtin:");
            const label = `${key} [${m[2]}]`;
            const ms = Number(m[3]);
            if (!samples.has(label)) samples.set(label, []);
            samples.get(label).push(ms);
            groupTotal += ms;
        }
    }
    totals.push(groupTotal);
}

rmSync(tmp, { recursive: true, force: true });

const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const HOME = process.env.USERPROFILE ?? "";
const short = (p) => p.replace(HOME, "~").replace(/.*node_modules\\/, "npm:");

const rows = [...samples.entries()]
    .map(([label, ms]) => ({
        label: short(label),
        med: median(ms),
        mean: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
        first: ms[0],
        min: Math.min(...ms),
        max: Math.max(...ms),
    }))
    .sort((a, b) => b.mean - a.mean);

const totalMed = median(totals);
const totalMean = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
console.log(`runs=${RUNS}  extension-load total: median ${totalMed}ms  mean ${totalMean}ms  (min ${Math.min(...totals)} / max ${Math.max(...totals)})`);
console.log(`wall clock per boot: median ${median(runtimes)}ms\n`);
console.log("per-extension (module import + factory), ms:".padEnd(74) + " mean   med  cold   min  max  share");
for (const r of rows) {
    const share = ((r.mean / totalMean) * 100).toFixed(1);
    console.log(
        r.label.slice(0, 72).padEnd(74) + String(r.mean).padStart(5) + String(r.med).padStart(7) + String(r.first).padStart(6) + String(r.min).padStart(6) + String(r.max).padStart(5) + String(share).padStart(7) + "%",
    );
}

if (process.env.SERIES) {
    console.log("\n--- raw per-run series (module import + factory) ---");
    const watch = ["pi-tool-display", "pi-blackhole", "pi-smart-fetch", "subagents", "session-mgr", "open-code-review", "pi-zentui", "ext-mgr"];
    for (const [label, ms] of samples) {
        if (!watch.some((w) => label.includes(w))) continue;
        console.log(short(label).padEnd(74) + ms.join(" "));
    }
    console.log("\ngroup totals per run: " + totals.join(" "));
    console.log("wall clock per run:   " + runtimes.join(" "));
}