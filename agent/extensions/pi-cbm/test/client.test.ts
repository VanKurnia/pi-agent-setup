import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CbmClient } from "../src/cbm/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CbmClient environment", () => {
  it("forwards the PI cache directory to the upstream CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cbm-client-test-"));
    temporaryDirectories.push(directory);
    const observedPath = join(directory, "observed-cache-dir");
    const binaryPath = join(directory, "fake-codebase-memory.mjs");
    await writeFile(
      binaryPath,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(observedPath)}, process.env.CBM_CACHE_DIR ?? "");\nprocess.stdout.write(JSON.stringify({ content: [{ type: "text", text: "{}" }] }));\n`,
    );
    await chmod(binaryPath, 0o755);
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", binaryPath);
    const legacyCache = join(directory, "legacy-cache");
    const configuredCache = join(directory, "configured-cache");
    vi.stubEnv("CBM_CACHE_DIR", legacyCache);
    vi.stubEnv("PI_CBM_CACHE_DIR", configuredCache);

    const client = new CbmClient();
    await client.callTool("list_projects", {});
    await expect(readFile(observedPath, "utf8")).resolves.toBe(configuredCache);

    vi.stubEnv("PI_CBM_CACHE_DIR", "");
    await client.callTool("list_projects", {});
    await expect(readFile(observedPath, "utf8")).resolves.toBe(legacyCache);
  });
});
