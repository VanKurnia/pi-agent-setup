import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/** Parameters of the `recall` tool. Single source of the contract; `runRecallTool` follows it. */
export const recallParams = Type.Object({
    query: Type.Optional(
        Type.String({
            description:
                "Text/regex search; #N expands entry; #N:text reads a message body; #N:file / #N:<path> reads a tool-call payload; append :offset:limit or :full to page a long entry; 12-char hex recovers an observation/reflection. mode:file searches tool-call payloads (write/edit arguments) and message text.",
        }),
    ),
    expand: Type.Optional(
        Type.Array(Type.Number(), {
            description:
                "Entry indices to return full untruncated content for. Standalone or with query.",
        }),
    ),
    page: Type.Optional(
        Type.Number({
            description: "Page number (1-based) for paginated results. Default: 1.",
        }),
    ),
    scope: Type.Optional(
        StringEnum(["lineage", "all"] as const, {
            description: "Search scope. lineage = active lineage (default), all = entire session.",
        }),
    ),
    mode: Type.Optional(
        StringEnum(["hybrid", "file", "touched"] as const, {
            description:
                "What content to search. hybrid (default) = all session content. file = file content only. touched = files-by-path summary with entry indices.",
        }),
    ),
    source: Type.Optional(
        StringEnum(["current", "parent"] as const, {
            description:
                "Which session to read. current (default) = own session. parent = delegating parent session; only resolves inside a subagent child run.",
        }),
    ),
});

export type RecallParams = Static<typeof recallParams>;
