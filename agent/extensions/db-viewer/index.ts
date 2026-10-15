import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { isQuerySafe } from "../shared/query-safe.js";
import {
    formatRowsToMarkdown,
    getDbStatus,
    maskConnection,
    probeConnection,
    readDbConfig,
    resolveClosestConnection,
    resolveConnectionValue,
    type MysqlFactory,
    writeDbConfig,
} from "../shared/db.js";
import { normalizeDir } from "../shared/text-format.js";
import { createToolResultComponent } from "../shared/markdown.js";

function resolveMaxRows(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) return 200;
    return Math.min(1000, Math.max(1, Math.floor(raw)));
}

/**
 * Resolve mysql2/promise's createConnection across ESM/CJS interop shapes.
 * Lives in this extension because bare imports resolve from the importing
 * file, and mysql2 is installed only in this package's node_modules.
 */
async function getMysqlCreateConnection(): Promise<MysqlFactory> {
    const mysql = (await import("mysql2/promise")) as unknown as {
        default?: { createConnection?: MysqlFactory };
        createConnection?: MysqlFactory;
    };
    const create = mysql.default?.createConnection ?? mysql.createConnection;
    if (!create) throw new Error("mysql2/promise does not export createConnection");
    return create;
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

/** Strip `undefined` optionals so a plain object satisfies the `JsonValue` contract. */
function toJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Error text listing the available connections for `driver`, for unresolved defaults. */
function unknownConnectionError(driver: "sqlite" | "mysql"): string {
    const config = readDbConfig();
    const names = (config?.connections || []).filter((c) => c.driver === driver).map((c) => c.name);
    if (names.length > 0) {
        return (
            `No ${driver} connection found for this directory and no default configured. ` +
            `Available ${driver} connections: ${names.join(", ")}. ` +
            `Pass a connection name, path, or full URI explicitly.`
        );
    }
    return (
        `No ${driver} connections configured in db-config.json. ` +
        `Pass an explicit path/URI or add a connection entry.`
    );
}

export default function dbViewerExtension(pi: ExtensionAPI) {
    // Injected once per session (plus branch-dedup for /reload + resume).
    let hasInjectedDbConnections = false;

    pi.on("session_start", async () => {
        hasInjectedDbConnections = false;
    });

    pi.on("before_agent_start", async (event, ctx) => {
        // Runs from pi.sendMessage(..., { triggerTurn: true }) carry messageType "custom"
        // on pi >= 1.2.0; older runtimes omit the field, so treat absence as a user run.
        if ("messageType" in event && event.messageType !== "user") return;
        if (hasInjectedDbConnections) return;
        const branch = (ctx?.sessionManager?.getBranch?.() || []) as Array<{
            type?: string;
            customType?: string;
            message?: { customType?: string };
        }>;
        const alreadyInjected = branch.some((entry) => {
            const msg = entry?.message ?? entry;
            return msg?.customType === "db-viewer-connections";
        });
        if (alreadyInjected) {
            hasInjectedDbConnections = true;
            return;
        }
        const cwd = ctx?.cwd ?? process.cwd();
        const config = readDbConfig();
        if (!config || (config.connections || []).length === 0) return;
        const sqlite = resolveClosestConnection(cwd, "sqlite");
        const mysql = resolveClosestConnection(cwd, "mysql");
        if (!sqlite && !mysql) return;
        const lines = [
            "## Database connections (closest-dir defaults from db-config.json — omit dbPath/connectionString to use the default, or pass an explicit value to override)",
        ];
        const shown = new Set<string>();
        for (const match of [mysql, sqlite]) {
            if (!match || shown.has(match.name)) continue;
            shown.add(match.name);
            lines.push(
                `• ${match.name} (${match.driver}) — ${match.directory}${match.default ? " [default]" : ""} ← closest for this directory`,
            );
            lines.push(`  connection: ${match.connection}`);
        }
        for (const c of config.connections) {
            if (lines.length >= 14) break;
            if (shown.has(c.name)) continue;
            shown.add(c.name);
            lines.push(
                `• ${c.name} (${c.driver}) — ${c.directory}${c.default ? " [default]" : ""}`,
            );
        }
        if (shown.size < config.connections.length) {
            lines.push(`…and ${config.connections.length - shown.size} more`);
        }
        hasInjectedDbConnections = true;
        return {
            message: {
                customType: "db-viewer-connections",
                content: lines.join("\n"),
                display: false,
            },
        };
    });
    // Tool 1: SQLite Query Executor
    pi.registerTool({
        name: "query_sqlite",
        label: "Query SQLite",
        description:
            "Execute safe, read-only SELECT queries on a local SQLite database file. Omit dbPath to use the closest-dir default from db-config.json.",
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
        promptSnippet: "Query a SQLite database file (SELECT only)",
        promptGuidelines: [
            "Use query_sqlite when you need to inspect SQLite schema, counts, or table records.",
            "Do not try to write, insert, update, delete or drop tables. Only SELECT is supported.",
        ],
        parameters: Type.Object({
            dbPath: Type.Optional(
                Type.String({
                    description:
                        "Omit to use closest-dir default from db-config.json; pass a connection name, path, or full URI to override.",
                }),
            ),
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
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const safety = isQuerySafe(params.query);
            if (!safety.safe) {
                return {
                    content: [{ type: "text", text: `Blocked: ${safety.reason}` }],
                    isError: true,
                    details: {},
                };
            }
            const resolved = resolveConnectionValue(
                params.dbPath,
                ctx?.cwd ?? process.cwd(),
                "sqlite",
            );
            if (!resolved) {
                return {
                    content: [{ type: "text", text: unknownConnectionError("sqlite") }],
                    isError: true,
                    details: {},
                };
            }
            const dbPath = "passthrough" in resolved ? resolved.passthrough : resolved.connection;

            let db: DatabaseSync | null = null;
            try {
                db = new DatabaseSync(dbPath);
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
        description:
            "Execute safe, read-only queries on a MySQL database. Omit connectionString to use the closest-dir default from db-config.json.",
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
        promptSnippet: "Query a MySQL database (SELECT, SHOW, DESCRIBE only)",
        promptGuidelines: [
            "Use query_mysql to view table data, schema, or descriptions on MySQL databases.",
            "Only read-only queries (SELECT, SHOW, DESCRIBE) are executed. Writing operations are blocked.",
        ],
        parameters: Type.Object({
            connectionString: Type.Optional(
                Type.String({
                    description:
                        "Omit to use closest-dir default from db-config.json; pass a connection name, path, or full URI to override.",
                }),
            ),
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
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const safety = isQuerySafe(params.query);
            if (!safety.safe) {
                return {
                    content: [{ type: "text", text: `Blocked: ${safety.reason}` }],
                    isError: true,
                    details: {},
                };
            }
            const resolved = resolveConnectionValue(
                params.connectionString,
                ctx?.cwd ?? process.cwd(),
                "mysql",
            );
            if (!resolved) {
                return {
                    content: [{ type: "text", text: unknownConnectionError("mysql") }],
                    isError: true,
                    details: {},
                };
            }
            const connectionString =
                "passthrough" in resolved ? resolved.passthrough : resolved.connection;

            let createConnection: Awaited<ReturnType<typeof getMysqlCreateConnection>>;
            try {
                createConnection = await getMysqlCreateConnection();
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
                connection = await createConnection(connectionString);
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

    // Tool 3: DB connectivity probe (model-callable; models cannot call slash-commands)
    pi.registerTool({
        name: "db_status",
        label: "DB Status",
        description:
            "Check database connectivity for the closest-dir defaults from db-config.json. Returns reachability + latency per driver without running user queries.",
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
        promptSnippet: "Check whether the default SQLite/MySQL connections are reachable",
        promptGuidelines: [
            "Use db_status when you need to check whether the closest-dir default databases are reachable, before running queries.",
        ],
        parameters: Type.Object({
            driver: Type.Optional(
                Type.Union([Type.Literal("sqlite"), Type.Literal("mysql")], {
                    description: "Only probe this driver; omit to probe both.",
                }),
            ),
        }),
        outputSchema: Type.Object({
            cwd: Type.String({ description: "Directory the defaults were resolved for" }),
            matches: Type.Array(
                Type.Object({
                    driver: Type.String({ description: "Driver probed" }),
                    name: Type.String({ description: "Matched connection name" }),
                    directory: Type.String({
                        description: "Config directory the match was resolved from",
                    }),
                    default: Type.Optional(
                        Type.Boolean({ description: "True when the match is a default entry" }),
                    ),
                    ok: Type.Boolean({ description: "Whether SELECT 1 AS ping succeeded" }),
                    latencyMs: Type.Number({ description: "Probe round-trip time in ms" }),
                    error: Type.Optional(
                        Type.String({ description: "Sanitized driver error when ok is false" }),
                    ),
                }),
                { description: "Per-driver probe results for the closest-dir matches" },
            ),
            connections: Type.Array(Type.String(), {
                description: "All configured connection names",
            }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const status = await getDbStatus(
                ctx?.cwd ?? process.cwd(),
                params.driver,
                getMysqlCreateConnection,
            );
            const structuredContent = toJson({
                cwd: status.cwd,
                matches: status.matches,
                connections: status.connections,
            });
            return {
                content: [{ type: "text", text: status.text }],
                structuredContent,
                details: { matches: status.matches },
            };
        },
        renderResult(result, options, _theme, context) {
            return createToolResultComponent(result, options, context);
        },
    });

    // Tool 4: save a connection entry (first write path — destructive by design).
    pi.registerTool({
        name: "db_save",
        label: "DB Save",
        description:
            "Save a database connection for a working directory to db-config.json. Probes the connection first and refuses redundant entries already covered by a parent directory.",
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
        },
        promptSnippet: "Save a DB connection for this directory",
        promptGuidelines: [
            "Use db_save only when the user asks to remember a database or when a verified working connection has no covering entry in db_status.",
            "db_save always probes first; unreachable credentials are rejected, never stored.",
            "If the result says covered-by-parent, use the parent entry — do not re-save.",
        ],
        parameters: Type.Object({
            name: Type.String({
                description: "Connection name, unique case-insensitive.",
            }),
            driver: Type.Union([Type.Literal("sqlite"), Type.Literal("mysql")], {
                description: "Driver for the connection.",
            }),
            connection: Type.String({
                description: "File path (sqlite) or full URI (mysql).",
            }),
            directory: Type.Optional(
                Type.String({
                    description:
                        "Working directory to save for; defaults to cwd. Must not be empty.",
                }),
            ),
            overwrite: Type.Optional(
                Type.Boolean({
                    description: "Replace the entry when name already exists; default false.",
                }),
            ),
        }),
        outputSchema: Type.Object({
            saved: Type.Boolean({
                description: "Whether the entry was written to db-config.json",
            }),
            name: Type.String({ description: "Requested connection name" }),
            reason: Type.Optional(
                Type.Union(
                    [
                        Type.Literal("covered-by-parent"),
                        Type.Literal("probe-failed"),
                        Type.Literal("saved"),
                        Type.Literal("name-exists"),
                    ],
                    { description: "Save outcome" },
                ),
            ),
            parent: Type.Optional(
                Type.String({ description: "Covering parent entry name, when any" }),
            ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            // 1. Validate params + normalize directory.
            const name = (params.name ?? "").trim();
            const connection = (params.connection ?? "").trim();
            const driver = params.driver;
            const fail = (text: string, result: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                isError: true as const,
                structuredContent: toJson(result),
                details: { saved: false, name },
            });
            if (!name) return fail("Name must not be empty.", { saved: false, name });
            if (driver !== "sqlite" && driver !== "mysql")
                return fail("Driver must be sqlite or mysql.", { saved: false, name });
            if (!connection) return fail("Connection must not be empty.", { saved: false, name });
            if (params.directory !== undefined && params.directory.trim() === "")
                return fail("Directory must not be empty; omit to use cwd.", {
                    saved: false,
                    name,
                });
            const directory = resolve(params.directory ?? ctx?.cwd ?? process.cwd());
            // 2. Read config (missing file starts empty; written on successful save).
            const existing = readDbConfig();
            const config = existing ?? { connections: [] };
            if (!Array.isArray(config.connections)) config.connections = [];
            const overwrite = params.overwrite ?? false;
            const existingIndex = config.connections.findIndex(
                (c) => c.name.toLowerCase() === name.toLowerCase(),
            );
            if (existingIndex >= 0 && !overwrite) {
                const names = config.connections.map((c) => c.name).join(", ");
                return fail(
                    `Name '${name}' already exists (name-exists). Existing: ${names}. Re-run with overwrite:true to replace. Not saved.`,
                    { saved: false, name, reason: "name-exists" },
                );
            }
            // 3. Parent-dedup: exclude the entry being saved itself by name so an
            // update of its own entry never counts as "redundant against itself".
            const rawParent = resolveClosestConnection(directory, driver);
            const parent =
                rawParent && rawParent.name.toLowerCase() !== name.toLowerCase()
                    ? rawParent
                    : undefined;
            if (parent) {
                const same =
                    driver === "sqlite"
                        ? normalizeDir(resolve(parent.connection)) ===
                          normalizeDir(resolve(connection))
                        : parent.connection === connection;
                if (same) {
                    const text = `Already covered by '${parent.name}' (${parent.directory}) — not saved.`;
                    const structuredContent = toJson({
                        saved: false,
                        name,
                        reason: "covered-by-parent",
                        parent: parent.name,
                    });
                    return {
                        content: [{ type: "text" as const, text }],
                        structuredContent,
                        details: { saved: false, name, parent: parent.name },
                    };
                }
            }
            // 4. Mandatory probe gate: reuse probeConnection with the unsaved values.
            // No bypass flag — a failed probe rejects the save.
            const probe = await probeConnection(
                { name, driver, directory, connection },
                getMysqlCreateConnection,
            );
            if (!probe.ok) {
                return fail(
                    `Probe failed for '${name}': ${probe.error ?? "unreachable"}. Not saved.`,
                    {
                        saved: false,
                        name,
                        reason: "probe-failed",
                        ...(parent ? { parent: parent.name } : {}),
                    },
                );
            }
            // 5. Insert or named-replace on overwrite (overwrite is true whenever
            // the name exists — step 2 returned otherwise). Never touches
            // `default` flags: new entries omit it, overwrites preserve the rest.
            if (existingIndex >= 0) {
                config.connections[existingIndex] = {
                    ...config.connections[existingIndex],
                    name,
                    driver,
                    directory,
                    connection,
                };
            } else {
                config.connections.push({ name, driver, directory, connection });
            }
            writeDbConfig(config);
            const masked = maskConnection(connection);
            const parentNote = parent
                ? `Parent: '${parent.name}' (${parent.directory}) also covers this directory with a different connection.`
                : "New root (no covering parent).";
            const text = `Saved '${name}' (${driver}) for ${directory} — connection ${masked}. ${parentNote}`;
            const structuredContent = toJson({
                saved: true,
                name,
                reason: "saved",
                ...(parent ? { parent: parent.name } : {}),
            });
            return {
                content: [{ type: "text" as const, text }],
                structuredContent,
                details: {
                    saved: true,
                    name,
                    ...(parent ? { parent: parent.name } : {}),
                },
            };
        },
        renderResult(result, options, _theme, context) {
            return createToolResultComponent(result, options, context);
        },
    });

    // Command: /db-status — thin notify-only wrapper over the same probe helper.
    // Read-only, masked output always (never prints full URIs/passwords).
    pi.registerCommand("db-status", {
        description: "Check database connectivity for the closest-dir defaults.",
        handler: async (args, ctx) => {
            const raw = args?.trim().toLowerCase();
            const driver = raw === "sqlite" || raw === "mysql" ? raw : undefined;
            if (raw && !driver) {
                ctx.ui.notify("Usage: /db-status [sqlite|mysql]", "error");
                return;
            }
            const status = await getDbStatus(
                ctx.cwd ?? process.cwd(),
                driver,
                getMysqlCreateConnection,
            );
            ctx.ui.notify(status.text, "info");
        },
    });

    // Command: /sqlite-schema — inspect a local SQLite database
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

    // Command: /mysql-schema — inspect a MySQL database
    pi.registerCommand("mysql-schema", {
        description: "Inspect schema of a MySQL database",
        handler: async (args, ctx) => {
            const connectionString = args?.trim();
            if (!connectionString) {
                ctx.ui.notify("Usage: /mysql-schema <connection-uri>", "error");
                return;
            }

            let createConnection: Awaited<ReturnType<typeof getMysqlCreateConnection>>;
            try {
                createConnection = await getMysqlCreateConnection();
            } catch (e: any) {
                ctx.ui.notify(`mysql2 error: ${e.message}`, "error");
                return;
            }

            let connection;
            try {
                connection = await createConnection(connectionString);
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
