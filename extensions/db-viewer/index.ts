import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";

// Simple, strict regex SQL parser to prevent state mutation.
function isQuerySafe(sql: string): { safe: boolean; reason?: string } {
	const sanitized = sql.trim().toLowerCase();
	
	if (sanitized.length === 0) {
		return { safe: false, reason: "Query is empty" };
	}

	// We only allow queries starting with: select, show, describe, explain, pragma, use
	const allowedActions = /^(select|show|describe|explain|pragma|use)\b/;
	if (!allowedActions.test(sanitized)) {
		return { 
			safe: false, 
			reason: "Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN, PRAGMA, USE) are allowed." 
		};
	}

	// Double check to prevent malicious multi-statement queries or nested mutation statements
	const dangerousKeywords = /\b(insert|update|delete|drop|alter|create|replace|truncate|rename|grant|revoke|load_file|into\s+outfile|into\s+dumpfile)\b/;
	if (dangerousKeywords.test(sanitized)) {
		return {
			safe: false,
			reason: "Dangerous keywords (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, REPLACE, TRUNCATE, etc.) detected in the query."
		};
	}

	return { safe: true };
}

// Format result rows to markdown tables
function formatRowsToMarkdown(rows: any[]): string {
	if (!rows || rows.length === 0) {
		return "Query executed successfully. 0 rows returned.";
	}

	const columns = Object.keys(rows[0] as object);
	const headers = `| ${columns.join(" | ")} |`;
	const separators = `| ${columns.map(() => "---").join(" | ")} |`;
	const dataRows = rows.map((row: any) => {
		return `| ${columns.map(col => {
			const val = row[col];
			if (val === null || val === undefined) return "NULL";
			return String(val).replace(/\|/g, "\\|");
		}).join(" | ")} |`;
	});

	return [headers, separators, ...dataRows].join("\n");
}

export default function dbViewerExtension(pi: ExtensionAPI) {
	
	// Tool 1: SQLite Query Executor
	pi.registerTool({
		name: "query_sqlite",
		label: "Query SQLite",
		description: "Execute safe, read-only SELECT queries on a local SQLite database file",
		promptSnippet: "Query SQLite databases",
		promptGuidelines: [
			"Use query_sqlite when you need to inspect SQLite schema, counts, or table records.",
			"Do not try to write, insert, update, delete or drop tables. Only SELECT is supported.",
			"If database configuration or connection details are missing, look for .env files in the workspace. If they cannot be resolved, use the ask_user_question tool to request them."
		],
		parameters: Type.Object({
			dbPath: Type.String({ description: "Relative or absolute path to SQLite file" }),
			query: Type.String({ description: "SQL query to execute" })
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const safety = isQuerySafe(params.query);
			if (!safety.safe) {
				return { content: [{ type: "text", text: `Blocked: ${safety.reason}` }], isError: true, details: {} };
			}

			let db: DatabaseSync | null = null;
			try {
				db = new DatabaseSync(params.dbPath);
				const statement = db.prepare(params.query);
				const rows = statement.all();
				return {
					content: [{ type: "text", text: formatRowsToMarkdown(rows) }],
					details: { rowsCount: rows.length, rows }
				};
			} catch (error: any) {
				return { content: [{ type: "text", text: `SQLite Error: ${error.message}` }], isError: true, details: {} };
			} finally {
				if (db) {
					try { db.close(); } catch (e) {}
				}
			}
		}
	});

	// Tool 2: MySQL Query Executor
	pi.registerTool({
		name: "query_mysql",
		label: "Query MySQL",
		description: "Execute safe, read-only queries on a MySQL database",
		promptSnippet: "Query MySQL databases",
		promptGuidelines: [
			"Use query_mysql to view table data, schema, or descriptions on MySQL databases.",
			"Only read-only queries (SELECT, SHOW, DESCRIBE) are executed. Writing operations are blocked.",
			"If database configuration or connection details are missing, look for .env files in the workspace. If they cannot be resolved, use the ask_user_question tool to request them."
		],
		parameters: Type.Object({
			connectionString: Type.String({ 
				description: "MySQL connection URI, e.g. mysql://user:password@host:port/database" 
			}),
			query: Type.String({ description: "SQL query to execute" })
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const safety = isQuerySafe(params.query);
			if (!safety.safe) {
				return { content: [{ type: "text", text: `Blocked: ${safety.reason}` }], isError: true, details: {} };
			}

			let mysql;
			try {
				const extDir = __dirname;
				const mysqlPath = require.resolve("mysql2/promise", { paths: [extDir] });
				mysql = require(mysqlPath);
			} catch (e: any) {
				return {
					content: [{ 
						type: "text", 
						text: `Error loading mysql2: ${e.message}. Make sure npm dependencies are installed in the db-viewer extension directory.` 
					}],
					isError: true,
					details: {}
				};
			}

			let connection;
			try {
				connection = await mysql.createConnection(params.connectionString);
				const [rows] = await connection.execute(params.query);
				const rowsArray = Array.isArray(rows) ? rows : [rows];
				return {
					content: [{ type: "text", text: formatRowsToMarkdown(rowsArray) }],
					details: { rowsCount: rowsArray.length, rows: rowsArray }
				};
			} catch (error: any) {
				return { content: [{ type: "text", text: `MySQL Error: ${error.message}` }], isError: true, details: {} };
			} finally {
				if (connection) {
					try { await connection.end(); } catch (e) {}
				}
			}
		}
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
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
				);
				const tables = tablesStatement.all() as { name: string }[];

				if (tables.length === 0) {
					ctx.ui.notify("No user tables found", "info");
					return;
				}

				let schemaReport = `Tables in ${dbPath}:\n\n`;
				for (const table of tables) {
					schemaReport += `Table: ${table.name}\n`;
					const pragmaStmt = db.prepare(`PRAGMA table_info(${table.name})`);
					const columns = pragmaStmt.all() as { name: string; type: string; notnull: number; pk: number }[];

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
					try { db.close(); } catch (e) {}
				}
			}
		}
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

			let mysql;
			try {
				const extDir = __dirname;
				const mysqlPath = require.resolve("mysql2/promise", { paths: [extDir] });
				mysql = require(mysqlPath);
			} catch (e: any) {
				ctx.ui.notify(`mysql2 error: ${e.message}`, "error");
				return;
			}

			let connection;
			try {
				connection = await mysql.createConnection(connectionString);
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
					
					const [columnsRows] = await connection.execute(`DESCRIBE \`${tableName}\``);
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
					try { await connection.end(); } catch (e) {}
				}
			}
		}
	});
}
