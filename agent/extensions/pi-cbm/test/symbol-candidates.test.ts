import { describe, expect, it } from "vitest";
import { searchCandidates } from "../src/domain/symbols.js";

const searchGraphFixture = {
    cols: ["qn", "label", "file", "lines", "rank"],
    rows: [
        [
            "C-Users-Ivan-.pi.agent.extensions.pi-cbm.src.cbm.client.CbmClient.gitRoot",
            "Method",
            "agent/extensions/pi-cbm/src/cbm/client.ts",
            "39-41",
            -16.238036006504043,
        ],
        [
            "C-Users-Ivan-.pi.agent.extensions.pi-cbm.src.cbm.client.CbmClient.callTool",
            "Method",
            "agent/extensions/pi-cbm/src/cbm/client.ts",
            "43-99",
            -16.238036006504043,
        ],
    ],
    total: 4,
    total_relation: "eq",
    search_mode: "bm25",
    returned: 2,
    count: 2,
    has_more: true,
    next_offset: 2,
    truncated: true,
    truncation_reason: "page_limit",
};

const groupedFixture = {
    qn_rule: 'qn = qn_prefix == "" ? name : qn_prefix + "." + name',
    cols: ["name", "label", "lines", "in", "out"],
    groups: [
        {
            qn_prefix: "C-Users-Ivan-.pi.agent.extensions.pi-cbm.src.cbm.binary",
            file: "agent/extensions/pi-cbm/src/cbm/binary.ts",
            rows: [["resolveCbmBinary", "Function", "32-49", 1, 5]],
        },
    ],
    total: 1,
    returned: 1,
    count: 1,
    has_more: false,
    truncated: false,
};

const semanticFixture = {
    groups: [],
    semantic_total: 51,
    semantic_total_relation: "gte",
    semantic_returned: 50,
    semantic_has_more: true,
    semantic_next_offset: 50,
    semantic: {
        cols: ["qn", "label", "file", "score"],
        rows: [
            [
                "C-Users-Ivan-.pi.agent.extensions.pi-cbm.src.cbm.binary.expandHome",
                "Function",
                "agent/extensions/pi-cbm/src/cbm/binary.ts",
                0.86822969,
            ],
        ],
    },
};

const bothFixture = {
    qn_rule: 'qn = qn_prefix == "" ? name : qn_prefix + "." + name',
    cols: ["name", "label", "lines", "in", "out"],
    groups: [
        {
            qn_prefix: "C-Users-Ivan-.pi.agent.extensions.pi-cbm.src.cbm.binary",
            file: "agent/extensions/pi-cbm/src/cbm/binary.ts",
            rows: [["resolveCbmBinary", "Function", "32-49", 1, 5]],
        },
    ],
    total: 1,
    returned: 1,
    count: 1,
    has_more: false,
    truncated: false,
    semantic_total: 51,
    semantic_total_relation: "gte",
    semantic_returned: 50,
    semantic_has_more: true,
    semantic_next_offset: 50,
    semantic: {
        cols: ["qn", "label", "file", "score"],
        rows: [
            [
                "C-Users-Ivan-.pi.agent.extensions.pi-cbm.src.cbm.binary.expandHome",
                "Function",
                "agent/extensions/pi-cbm/src/cbm/binary.ts",
                0.86822969,
            ],
        ],
    },
};

describe("searchCandidates table mapping", () => {
    it("maps the captured search_graph cols/rows payload into records", () => {
        const candidates = searchCandidates(searchGraphFixture);
        expect(candidates).toHaveLength(2);
        expect(candidates[0]?.qualified_name?.endsWith(".CbmClient.gitRoot")).toBe(true);
        expect(candidates[0]?.file_path).toBe("agent/extensions/pi-cbm/src/cbm/client.ts");
        expect(candidates[0]?.start_line).toBe(39);
        expect(candidates[0]?.end_line).toBe(41);
    });

    it("maps the grouped name_pattern payload via qn_prefix and group file", () => {
        const candidates = searchCandidates(groupedFixture);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.qualified_name).toBe(
            "C-Users-Ivan-.pi.agent.extensions.pi-cbm.src.cbm.binary.resolveCbmBinary",
        );
        expect(candidates[0]?.file_path).toBe("agent/extensions/pi-cbm/src/cbm/binary.ts");
        expect(candidates[0]?.start_line).toBe(32);
        expect(candidates[0]?.end_line).toBe(49);
        expect(candidates[0]?.label).toBe("Function");
    });

    it("maps the nested semantic payload", () => {
        const candidates = searchCandidates(semanticFixture);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.qualified_name?.endsWith(".expandHome")).toBe(true);
        expect(candidates[0]?.file_path).toBe("agent/extensions/pi-cbm/src/cbm/binary.ts");
        expect(candidates[0]?.label).toBe("Function");
    });

    it("concatenates groups and semantic when both carry results", () => {
        const candidates = searchCandidates(bothFixture);
        expect(candidates).toHaveLength(2);
    });

    it("keeps the label filter for table rows", () => {
        const candidates = searchCandidates({
            cols: ["qn", "label", "file", "lines"],
            rows: [["a.b", "Module", "x.ts", "1-2"]],
        });
        expect(candidates).toEqual([]);
    });

    it("keeps the results branch for record payloads", () => {
        const candidates = searchCandidates({
            results: [{ qualified_name: "a.b", label: "Function" }],
        });
        expect(candidates).toHaveLength(1);
    });

    it("returns [] for non-record payloads", () => {
        expect(searchCandidates("tree text")).toEqual([]);
    });
});
