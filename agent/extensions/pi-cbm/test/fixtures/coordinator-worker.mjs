import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [modulePath, cacheDirectory, repoPath, maxConcurrentIndexes, eventDirectory, label] = process.argv.slice(2);
const { IndexCoordinator } = await import(modulePath);

const coordinator = new IndexCoordinator({
  cacheDirectory,
  maxConcurrentIndexes: Number(maxConcurrentIndexes),
  retryRanges: [[5, 5]],
  heartbeatMs: 25,
  staleAfterMs: 1_000,
  queueLockStaleAfterMs: 1_000,
  random: () => 0,
});

await mkdir(eventDirectory, { recursive: true });
const result = await coordinator.acquire(repoPath);
if (!result.ok) {
  await writeFile(join(eventDirectory, `${Date.now()}-${label}-skipped-${randomUUID()}`), result.reason);
  process.exit(2);
}

await writeFile(join(eventDirectory, `${Date.now()}-${label}-start-${randomUUID()}`), basename(repoPath));
await new Promise((resolve) => setTimeout(resolve, 40));
await writeFile(join(eventDirectory, `${Date.now()}-${label}-end-${randomUUID()}`), basename(repoPath));
await result.lease.release();
