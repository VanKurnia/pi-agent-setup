import { describe, expect, it } from "vitest";
import { OutputService } from "../src/domain/output.js";

const tablePayload = {
    cols: ["qn", "label", "file", "lines", "rank"],
    rows: [
        [
            "a.b.parseCbmEnvelope",
            "Function",
            "agent/extensions/pi-cbm/src/cbm/envelope.ts",
            "7-37",
            -19.36,
        ],
    ],
    total: 1,
    has_more: false,
};

describe("search_graph projection", () => {
    it("keeps the result table", async () => {
        const output = new OutputService();
        const result = await output.buildCompactableToolResult(
            "Graph search results",
            tablePayload,
            {},
            { tool: "search_graph" },
        );
        const text = result.content[0].text;
        expect(text).toContain("parseCbmEnvelope");
    });

    it("keeps the flat table row qn and file", async () => {
        const output = new OutputService();
        const payload = {
            cols: ["qn", "label", "file", "lines", "rank"],
            rows: [
                [
                    "C-Users-Ivan-.pi.envelope.parseCbmEnvelope",
                    "Function",
                    "agent/extensions/pi-cbm/src/cbm/envelope.ts",
                    "7-37",
                    -19.36,
                ],
            ],
            total: 1,
            has_more: false,
        };
        const result = await output.buildCompactableToolResult(
            "Graph search results",
            payload,
            {},
            { tool: "search_graph" },
        );
        const text = result.content[0].text;
        expect(text).toContain("C-Users-Ivan-.pi.envelope.parseCbmEnvelope");
        expect(text).toContain("agent/extensions/pi-cbm/src/cbm/envelope.ts");
    });

    it("keeps grouped payloads", async () => {
        const output = new OutputService();
        const payload = {
            cols: ["qn", "label", "file"],
            groups: [
                {
                    qn_prefix: "my.module",
                    file: "src/my/module.ts",
                    rows: [["my.module.helper", "Function", "src/my/module.ts"]],
                },
            ],
            total: 1,
            has_more: false,
        };
        const result = await output.buildCompactableToolResult(
            "Graph search results",
            payload,
            {},
            { tool: "search_graph" },
        );
        const text = result.content[0].text;
        expect(text).toContain("my.module");
        expect(text).toContain("my.module.helper");
    });

    it("keeps the record-based results path working", async () => {
        const output = new OutputService();
        const payload = {
            project: "test",
            query: "helper",
            total: 1,
            has_more: false,
            results: [
                {
                    qualified_name: "my.module.helper",
                    label: "Function",
                    file_path: "src/my/module.ts",
                    start_line: 1,
                    end_line: 10,
                },
            ],
        };
        const result = await output.buildCompactableToolResult(
            "Graph search results",
            payload,
            {},
            { tool: "search_graph" },
        );
        const text = result.content[0].text;
        expect(text).toContain("my.module.helper");
    });

    it("search_code keeps the match table", async () => {
        const output = new OutputService();
        const payload = {
            cols: ["file", "line", "match"],
            rows: [
                [
                    "agent/extensions/pi-cbm/src/pi-tools/search.ts",
                    12,
                    "TOOLS_WITHOUT_FORMAT_PARAM",
                ],
            ],
            directories: { "agent/": 2 },
            total_grep_matches: 2,
            total_results: 2,
            dedup_ratio: "1.0x",
            has_more: false,
        };
        const result = await output.buildCompactableToolResult(
            "Code search results",
            payload,
            {},
            { tool: "search_code" },
        );
        const text = result.content[0].text;
        expect(text).toContain("agent/extensions/pi-cbm/src/pi-tools/search.ts");
    });

    it("get_code_snippet outline mode keeps the member list", async () => {
        const output = new OutputService();
        const payload = {
            name: "CbmClient",
            qualified_name: "my.client.CbmClient",
            label: "Class",
            file_path: "agent/extensions/pi-cbm/src/cbm/client.ts",
            start_line: 57,
            end_line: 180,
            source_mode: "outline",
            members: [
                {
                    qualified_name: "my.client.CbmClient.findGitRoot",
                    label: "Method",
                    start_line: 58,
                    end_line: 84,
                },
            ],
            members_total: 1,
            full_source_available: true,
        };
        const result = await output.buildCompactableToolResult(
            "Code snippet",
            payload,
            {},
            { tool: "get_code_snippet" },
        );
        const text = result.content[0].text;
        expect(text).toContain("my.client.CbmClient.findGitRoot");
    });

    it("include_metadata passes the payload through unprojected", async () => {
        const output = new OutputService();
        const payload = { ...tablePayload, upstream_debug_metric: "sentinel-123" };
        const result = await output.buildCompactableToolResult(
            "Graph search results",
            payload,
            { include_metadata: true },
            { tool: "search_graph" },
        );
        const text = result.content[0].text;
        expect(text).toContain("parseCbmEnvelope");
        expect(text).toContain("sentinel-123");
    });
});
