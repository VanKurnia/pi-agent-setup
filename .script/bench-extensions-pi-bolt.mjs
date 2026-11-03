// Benchmark: run pi-bolt N times with PI_TIMING=1, aggregate per-extension load times.
// Same as bench-extensions.mjs but targets the pi-bolt binary.
import { runExtensionBench } from "./bench-timings.mjs";

runExtensionBench("pi-bolt", "piboltbench-");
