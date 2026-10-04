import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { isQuerySafe } from "../shared/query-safe.js";
import { formatRowsToMarkdown } from "../shared/db.js";
import { createToolResultComponent } from "../shared/markdown.js";

function resolveMaxRows(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) return 200;
    return Math.min(1000, Math.max(1, Math.floor(raw)));
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * `structuredContent` is typed as `JsonValue`, and driver rows are not JSON:
 * `SQLOutputValue` admits `bigint` and `Uint8Array`, neither of which is a
 * `JsonValue`, so assigning raw rows fails to typecheck. This converts them.
 *
 * Fidelity notes: `bigint` becomes a decimal string (JSON.stringify throws on
 * BigInt outright, so a replacer is required rather than optional), and BLOB
 * `Uint8Array` becomes an array of byte numbers. `details` still carries the
 * untouched driver rows, so anything needing the original values reads that.
 */
function toJsonRows(rows: readonly unknown[]): JsonValue[] {
    return JSON.parse(
        JSON.stringify(rows, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
    ) as JsonValue[];
}

export default function dbViewerExtension(pi: ExtensionAPI) {
    // Tool 1: SQLite Query Executor
    pi.registerTool({
        name: "query_sqlite",
        label: "Query SQLite",
        description: "Execute safe, read-only SELECT queries on a local SQLite database file",
        annotations: { readOnlyHint: true },
        promptSnippet: "Query SQLite databases",
        promptGuidelines: [
            "Use query_sqlite when you need to inspect SQLite schema, counts, or table records.",
            "Do not try to write, insert, update, delete or drop tables. Only SELECT is supported.",
            "If database configuration or connection details are missing, look for .env files in the workspace. If they cannot be resolved, use the ask_user_question tool to request them.",
        ],
        parameters: Type.Object({
            dbPath: Type.String({ description: "Relative or absolute path to SQLite file" }),
            query: Type.String({ description: "SQL query to execute" }),
            maxRows: Type.Optional(
                Type.Number({ description: "Maximum rows to return (default 200, 1-1000)" }),
            ),
        }),
        outputSchema: Type.Object({
            rowCount: Type.Number({ description: "Total rows returned before truncation" }),
            rows: Type.Array(Type.Record(Type.String(), Type.Any()), {
                description: "Result rows, JSON-encoded",
            }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const safety = isQuerySafe(params.query);
            if (!safety.safe) {
                return {
                    content: [{ type: "text", text: `Blocked: ${safety.reason}` }],
                    isError: true,
                    details: {},
                };
            }

            let db: DatabaseSync | null = null;
            try {
                db = new DatabaseSync(params.dbPath);
                const statement = db.prepare(params.query);
                const rows = statement.all();
                const maxRows = resolveMaxRows(params.maxRows);
                const total = rows.length;
                const displayRows = total > maxRows ? rows.slice(0, maxRows) : rows;
                const notice =
                    total > maxRows
                        ? `\n\n_…truncated to ${maxRows} of ${total} rows — narrow the query or raise maxRows._`
                        : "";
                const text =
                    formatRowsToMarkdown(displayRows as Record<string, unknown>[]) + notice;
                return {
                    content: [{ type: "text", text }],
                    structuredContent: { rowCount: total, rows: toJsonRows(displayRows) },
                    details: { rowsCount: total, rows: displayRows },
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `SQLite Error: ${error.message}` }],
                    isError: true,
                    details: {},
                };
            } finally {
                if (db) {
                    try {
                        db.close();
                    } catch (e) {}
                }
            }
        },
        renderResult(result, options, _theme, context) {
            return createToolResultComponent(result, options, context);
        },
    });

    // Tool 2: MySQL Query Executor
    pi.registerTool({
        name: "query_mysql",
        label: "Query MySQL",
        description: "Execute safe, read-only queries on a MySQL database",
        annotations: { readOnlyHint: true },
        promptSnippet: "Query MySQL databases",
        promptGuidelines: [
            "Use query_mysql to view table data, schema, or descriptions on MySQL databases.",
            "Only read-only queries (SELECT, SHOW, DESCRIBE) are executed. Writing operations are blocked.",
            "If database configuration or connection details are missing, look for .env files in the workspace. If they cannot be resolved, use the ask_user_question tool to request them.",
        ],
        parameters: Type.Object({
            connectionString: Type.String({
                description: "MySQL connection URI, e.g. mysql://user:password@host:port/database",
            }),
            query: Type.String({ description: "SQL query to execute" }),
            maxRows: Type.Optional(
                Type.Number({ description: "Maximum rows to return (default 200, 1-1000)" }),
            ),
        }),
        outputSchema: Type.Object({
            rowCount: Type.Number({ description: "Total rows returned before truncation" }),
            rows: Type.Array(Type.Record(Type.String(), Type.Any()), {
                description: "Result rows, JSON-encoded",
            }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const safety = isQuerySafe(params.query);
            if (!safety.safe) {
                return {
                    content: [{ type: "text", text: `Blocked: ${safety.reason}` }],
                    isError: true,
                    details: {},
                };
            }

            let mysql: any;
            try {
                mysql = await import("mysql2/promise");
            } catch (e: any) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error loading mysql2: ${e.message}. Make sure npm dependencies are installed in the db-viewer extension directory.`,
                        },
                    ],
                    isError: true,
                    details: {},
                };
            }

            let connection;
            try {
                connection = await mysql.default.createConnection(params.connectionString);
                const [rows] = await connection.execute(params.query);
                const rowsArray = Array.isArray(rows) ? rows : [rows];
                const maxRows = resolveMaxRows(params.maxRows);
                const total = rowsArray.length;
                const displayRows = total > maxRows ? rowsArray.slice(0, maxRows) : rowsArray;
                const notice =
                    total > maxRows
                        ? `\n\n_…truncated to ${maxRows} of ${total} rows — narrow the query or raise maxRows._`
                        : "";
                const text =
                    formatRowsToMarkdown(displayRows as Record<string, unknown>[]) + notice;
                return {
                    content: [{ type: "text", text }],
                    structuredContent: { rowCount: total, rows: toJsonRows(displayRows) },
                    details: { rowsCount: total, rows: displayRows },
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `MySQL Error: ${error.message}` }],
                    isError: true,
                    details: {},
                };
            } finally {
                if (connection) {
                    try {
                        await connection.end();
                    } catch (e) {}
                }
            }
        },
        renderResult(result, options, _theme, context) {
            return createToolResultComponent(result, options, context);
        },
    });

    // Command 1: Inspect local SQLite schema
    pi.registerCommand("sqlite-schema", {
        description: "Inspect schema of a SQLite database",
        handler: async (args, ctx) => {
            const dbPath = args?.trim();
            if (!dbPath) {
                ctx.ui.notify("Usage: /sqlite-schema <path-to-db>", "error");
                return;
            }

            let db: DatabaseSync | null = null;
            try {
                db = new DatabaseSync(dbPath);
                const tablesStatement = db.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                );
                const tables = tablesStatement.all() as { name: string }[];

                if (tables.length === 0) {
                    ctx.ui.notify("No user tables found", "info");
                    return;
                }

                let schemaReport = `Tables in ${dbPath}:\n\n`;
                for (const table of tables) {
                    schemaReport += `Table: ${table.name}\n`;
                    const safeName = table.name.replace(/`/g, "``");
                    const pragmaStmt = db.prepare(`PRAGMA table_info(\`${safeName}\`)`);
                    const columns = pragmaStmt.all() as {
                        name: string;
                        type: string;
                        notnull: number;
                        pk: number;
                    }[];

                    for (const col of columns) {
                        const pkMarker = col.pk ? " [PK]" : "";
                        const nullMarker = col.notnull ? " NOT NULL" : "";
                        schemaReport += `  - ${col.name} (${col.type})${pkMarker}${nullMarker}\n`;
                    }
                    schemaReport += "\n";
                }

                ctx.ui.setEditorText(schemaReport);
                ctx.ui.notify("SQLite Schema loaded to editor", "info");
            } catch (error: any) {
                ctx.ui.notify(`SQLite Error: ${error.message}`, "error");
            } finally {
                if (db) {
                    try {
                        db.close();
                    } catch (e) {}
                }
            }
        },
    });

    // Command 2: Inspect MySQL schema
    pi.registerCommand("mysql-schema", {
        description: "Inspect schema of a MySQL database",
        handler: async (args, ctx) => {
            const connectionString = args?.trim();
            if (!connectionString) {
                ctx.ui.notify("Usage: /mysql-schema <connection-uri>", "error");
                return;
            }

            let mysql: any;
            try {
                mysql = await import("mysql2/promise");
            } catch (e: any) {
                ctx.ui.notify(`mysql2 error: ${e.message}`, "error");
                return;
            }

            let connection;
            try {
                connection = await mysql.default.createConnection(connectionString);
                const [tablesRows] = await connection.execute("SHOW TABLES");
                const tables = tablesRows as any[];

                if (tables.length === 0) {
                    ctx.ui.notify("No tables found", "info");
                    return;
                }

                const tableKey = Object.keys(tables[0])[0];

                let schemaReport = `Tables in MySQL database:\n\n`;
                for (const tableRow of tables) {
                    const tableName = tableRow[tableKey];
                    schemaReport += `Table: ${tableName}\n`;

                    const safeName = tableName.replace(/`/g, "``");
                    const [columnsRows] = await connection.execute(`DESCRIBE \`${safeName}\``);
                    const columns = columnsRows as any[];

                    for (const col of columns) {
                        const pkMarker = col.Key === "PRI" ? " [PK]" : "";
                        const nullMarker = col.Null === "NO" ? " NOT NULL" : "";
                        schemaReport += `  - ${col.Field} (${col.Type})${pkMarker}${nullMarker}\n`;
                    }
                    schemaReport += "\n";
                }

                ctx.ui.setEditorText(schemaReport);
                ctx.ui.notify("MySQL Schema loaded to editor", "info");
            } catch (error: any) {
                ctx.ui.notify(`MySQL Error: ${error.message}`, "error");
            } finally {
                if (connection) {
                    try {
                        await connection.end();
                    } catch (e) {}
                }
            }
        },
    });
}
