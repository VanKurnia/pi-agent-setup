import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CbmClient } from "../src/cbm/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true })),
    );
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

describe("CbmClient transport", () => {
    async function writeObservingBinary(
        directory: string,
        name: string,
        stdoutPayload: unknown,
    ): Promise<string> {
        const binaryPath = join(directory, `${name}.mjs`);
        await writeFile(
            binaryPath,
            `import { writeFileSync } from "node:fs";\n` +
                `const observed = process.env.OBSERVED_PATH;\n` +
                `let input = "";\n` +
                `process.stdin.setEncoding("utf8");\n` +
                `process.stdin.on("data", (chunk) => { input += chunk; });\n` +
                `process.stdin.on("end", () => {\n` +
                `  writeFileSync(observed + ".args.json", JSON.stringify(process.argv.slice(2)));\n` +
                `  writeFileSync(observed + ".stdin.json", input);\n` +
                `  process.stdout.write(${JSON.stringify(JSON.stringify(stdoutPayload))});\n` +
                `});\n`,
        );
        await chmod(binaryPath, 0o755);
        return binaryPath;
    }

    async function setup(name: string, stdoutPayload: unknown): Promise<string> {
        const directory = await mkdtemp(join(tmpdir(), "pi-cbm-client-test-"));
        temporaryDirectories.push(directory);
        const observedPath = join(directory, name);
        const binaryPath = await writeObservingBinary(directory, name, stdoutPayload);
        vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", binaryPath);
        vi.stubEnv("OBSERVED_PATH", observedPath);
        return observedPath;
    }

    it("sends format json on stdin with argv cli --json search_graph", async () => {
        const observedPath = await setup("search-graph", {
            content: [{ type: "text", text: "{}" }],
        });
        const client = new CbmClient();
        await client.callTool("search_graph", { query: "x" });
        await expect(readFile(`${observedPath}.args.json`, "utf8")).resolves.toBe(
            JSON.stringify(["cli", "--json", "search_graph"]),
        );
        const stdin = JSON.parse(await readFile(`${observedPath}.stdin.json`, "utf8")) as Record<
            string,
            unknown
        >;
        expect(stdin.format).toBe("json");
        expect(stdin.query).toBe("x");
    });

    it("omits format for index_repository but keeps repo_path", async () => {
        const observedPath = await setup("index-repo", { content: [{ type: "text", text: "{}" }] });
        const client = new CbmClient();
        await client.callTool("index_repository", { repo_path: "/tmp/x" });
        const stdin = JSON.parse(await readFile(`${observedPath}.stdin.json`, "utf8")) as Record<
            string,
            unknown
        >;
        expect("format" in stdin).toBe(false);
        expect(stdin.repo_path).toBe("/tmp/x");
    });

    it("lets a caller-supplied format win", async () => {
        const observedPath = await setup("format-override", {
            content: [{ type: "text", text: "{}" }],
        });
        const client = new CbmClient();
        await client.callTool("search_graph", { query: "x", format: "tree" });
        const stdin = JSON.parse(await readFile(`${observedPath}.stdin.json`, "utf8")) as Record<
            string,
            unknown
        >;
        expect(stdin.format).toBe("tree");
    });

    it("prefers structuredContent over the text payload", async () => {
        await setup("structured", {
            content: [{ type: "text", text: "{}" }],
            structuredContent: { ok: true },
        });
        const client = new CbmClient();
        const result = await client.callTool("search_graph", { query: "x" });
        expect(result.data).toEqual({ ok: true });
    });

    it("leaves table payloads untouched", async () => {
        await setup("cols", {
            content: [{ type: "text", text: "{}" }],
            structuredContent: { cols: ["qn"], rows: [["a.b"]] },
        });
        const client = new CbmClient();
        const result = await client.callTool("search_graph", { query: "x" });
        expect(result.data).toEqual({ cols: ["qn"], rows: [["a.b"]] });
    });
});
