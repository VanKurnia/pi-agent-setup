import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCbmVersion } from "../src/cbm/binary.js";
import type { CbmVersion } from "../src/cbm/binary.js";
import { CbmClient, supportsJsonFormatParameter } from "../src/cbm/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

function version(major: number, minor: number, patch: number): CbmVersion {
    return { major, minor, patch };
}

describe("parseCbmVersion", () => {
    it("extracts the triplet from the upstream version string", () => {
        const result = parseCbmVersion("codebase-memory-mcp 0.11.0");
        expect(result?.major).toBe(0);
        expect(result?.minor).toBe(11);
        expect(result?.patch).toBe(0);
    });

    it("returns undefined when no triplet is present", () => {
        expect(parseCbmVersion("nonsense")).toBeUndefined();
    });
});

describe("supportsJsonFormatParameter", () => {
    it("assumes modern when the version is unknown", () => {
        expect(supportsJsonFormatParameter(undefined)).toBe(true);
    });

    it("rejects pre-0.10 and accepts 0.10+", () => {
        expect(supportsJsonFormatParameter(version(0, 9, 0))).toBe(false);
        expect(supportsJsonFormatParameter(version(0, 10, 0))).toBe(true);
        expect(supportsJsonFormatParameter(version(1, 0, 0))).toBe(true);
    });
});

describe("format retry", () => {
    it("retries once without format when the version probe is unresolved", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pi-cbm-version-test-"));
        temporaryDirectories.push(directory);
        const countPath = join(directory, "invocations.txt");
        const observedPath = join(directory, "retry");
        const binaryPath = join(directory, "flaky-format.mjs");
        await writeFile(
            binaryPath,
            `import { readFileSync, writeFileSync } from "node:fs";\n` +
                `if (process.argv.includes("--version")) {\n` +
                `  process.exit(0);\n` +
                `}\n` +
                `let input = "";\n` +
                `process.stdin.setEncoding("utf8");\n` +
                `process.stdin.on("data", (chunk) => { input += chunk; });\n` +
                `process.stdin.on("end", () => {\n` +
                `  const count = Number(readFileSync(${JSON.stringify(countPath)}, "utf8") || "0") + 1;\n` +
                `  writeFileSync(${JSON.stringify(countPath)}, String(count));\n` +
                `  writeFileSync(${JSON.stringify(observedPath)} + "." + count + ".stdin.json", input);\n` +
                `  if (count === 1) {\n` +
                `    process.stderr.write("unexpected argument --format");\n` +
                `    process.exit(1);\n` +
                `  }\n` +
                `  process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "{}" }] }));\n` +
                `});\n`,
        );
        await chmod(binaryPath, 0o755);
        await writeFile(countPath, "0");
        vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", binaryPath);

        const client = new CbmClient();
        const result = await client.callTool("search_graph", { query: "x" });
        expect(result.ok).toBe(true);
        expect(await readFile(countPath, "utf8")).toBe("2");
        const firstStdin = JSON.parse(
            await readFile(`${observedPath}.1.stdin.json`, "utf8"),
        ) as Record<string, unknown>;
        expect(firstStdin.format).toBe("json");
        const secondStdin = JSON.parse(
            await readFile(`${observedPath}.2.stdin.json`, "utf8"),
        ) as Record<string, unknown>;
        expect("format" in secondStdin).toBe(false);
        expect(secondStdin.query).toBe("x");
    });
});
