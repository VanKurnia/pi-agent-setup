import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [modulePath, cacheDirectory, repoPath, eventDirectory] = process.argv.slice(2);
const { IndexCoordinator } = await import(modulePath);

const coordinator = new IndexCoordinator({
  cacheDirectory,
  retryRanges: [[5, 5]],
  heartbeatMs: 25,
  staleAfterMs: 1_000,
  queueLockStaleAfterMs: 1_000,
  random: () => 0,
});

await mkdir(eventDirectory, { recursive: true });
const result = await coordinator.acquire(repoPath);
if (!result.ok) process.exit(2);

await writeFile(join(eventDirectory, "ready"), "ready");
setInterval(() => undefined, 1_000);
