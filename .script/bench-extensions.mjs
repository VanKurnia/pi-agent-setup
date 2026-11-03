// Benchmark: run pi N times with PI_TIMING=1, aggregate per-extension load times.
import { runExtensionBench } from "./bench-timings.mjs";

runExtensionBench("pi", "pibench-");
