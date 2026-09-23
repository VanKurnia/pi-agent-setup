import { existsSync } from "node:fs";
import { PiUrlResult, formatError } from "./types.ts";
import {
    readDbConfig,
    formatRowsToMarkdown,
    type DbConnection,
    type DbConfig,
    type DbRow,
} from "../shared/db.js";

function resolveConnection(config: DbConfig): DbConnection | null {
    const cwd = process.cwd().replace(/\\/g, "/");
    const matches = config.connections.filter((c) => {
        const dir = c.directory.replace(/\\/g, "/").replace(/\/?$/, "/");
        return cwd.startsWith(dir);
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.directory.length - a.directory.length);
    return matches[0];
}

function safeTableName(name: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function allConnections(config: DbConfig): string {
    const lines = ["## Configured Database Connections", ""];
    for (const c of config.connections) {
        lines.push(`- **${c.name}** — \`${c.driver}\`, dir: \`${c.directory}\``);
    }
    return lines.join("\n");
}

async function listTables(conn: DbConnection): Promise<string> {
    if (conn.driver === "sqlite") {
        const { DatabaseSync } = await import("node:sqlite");
        try {
            if (!existsSync(conn.connection))
                return `SQLite database not found at \`${conn.connection}\`.`;
            const db = new DatabaseSync(conn.connection);
            const rows = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )
                .all() as { name: string }[];
            db.close();
            if (rows.length === 0) return "No tables found.";
            return rows.map((r) => `- \`${r.name}\``).join("\n");
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return `Error listing tables: ${message}`;
        }
    }
    if (conn.driver === "mysql") {
        try {
            const mysql = await import("mysql2/promise");
            const db = await mysql.createConnection(conn.connection);
            const [rows] = await db.execute("SHOW TABLES");
            await db.end();
            const arr = rows as DbRow[];
            if (arr.length === 0) return "No tables found.";
            const key = Object.keys(arr[0])[0];
            return arr.map((r: DbRow) => `- \`${r[key]}\``).join("\n");
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return `Error listing tables: ${message}`;
        }
    }
    return `Unknown driver "${conn.driver}".`;
}

async function queryTable(
    conn: DbConnection,
    table: string,
    limit = 200,
    offset = 0,
): Promise<string> {
    if (!safeTableName(table)) {
        return `Error: Invalid table name "${table}". Use only letters, numbers, and underscores.`;
    }
    const safeLimit = Number.isInteger(limit) ? Math.min(1000, Math.max(1, limit)) : 200;
    const safeOffset = Number.isInteger(offset) ? Math.max(0, offset) : 0;
    if (conn.driver === "sqlite") {
        const { DatabaseSync } = await import("node:sqlite");
        try {
            if (!existsSync(conn.connection))
                return `Error: SQLite database not found at \`${conn.connection}\`.`;
            const db = new DatabaseSync(conn.connection);
            const rows = db
                .prepare(`SELECT * FROM "${table}" LIMIT ${safeLimit + 1} OFFSET ${safeOffset}`)
                .all() as DbRow[];
            db.close();
            const formatted = formatRowsToMarkdown(rows.slice(0, safeLimit), "_Empty (0 rows)_");
            if (rows.length === 0) return `Table \`${table}\` is empty (0 rows).`;
            if (rows.length > safeLimit) {
                return `**${table}** (${safeLimit} rows — truncated):\n\n${formatted}\n\n_…truncated to ${safeLimit} rows — use limit/offset to page._`;
            }
            return `**${table}** (${rows.length} rows):\n\n${formatted}`;
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return `Error querying table "${table}": ${message}`;
        }
    }
    if (conn.driver === "mysql") {
        try {
            const mysql = await import("mysql2/promise");
            const db = await mysql.createConnection(conn.connection);
            const [rows] = await db.execute(
                `SELECT * FROM \`${table}\` LIMIT ${safeLimit + 1} OFFSET ${safeOffset}`,
            );
            await db.end();
            const arr = rows as DbRow[];
            const formatted = formatRowsToMarkdown(arr.slice(0, safeLimit), "_Empty (0 rows)_");
            if (arr.length === 0) return `Table \`${table}\` is empty (0 rows).`;
            if (arr.length > safeLimit) {
                return `**${table}** (${safeLimit} rows — truncated):\n\n${formatted}\n\n_…truncated to ${safeLimit} rows — use limit/offset to page._`;
            }
            return `**${table}** (${arr.length} rows):\n\n${formatted}`;
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return `Error querying table "${table}": ${message}`;
        }
    }
    return `Error: Unknown driver "${conn.driver}".`;
}

async function tableSchema(conn: DbConnection, table: string): Promise<string> {
    if (!safeTableName(table)) {
        return `Error: Invalid table name "${table}". Use only letters, numbers, and underscores.`;
    }
    if (conn.driver === "sqlite") {
        const { DatabaseSync } = await import("node:sqlite");
        try {
            if (!existsSync(conn.connection))
                return `Error: SQLite database not found at \`${conn.connection}\`.`;
            const db = new DatabaseSync(conn.connection);
            const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as DbRow[];
            db.close();
            const header = "| # | Column | Type | Not Null | Default | PK |";
            const sep_ = "|---|--------|------|----------|---------|----|";
            const data = rows.map(
                (r: DbRow) =>
                    `| ${r.cid} | ${r.name} | ${r.type} | ${r.notnull ? "YES" : ""} | ${r.dflt_value ?? ""} | ${r.pk ? "PK" : ""} |`,
            );
            return [`**${table} schema:**`, "", header, sep_, ...data].join("\n");
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return `Error describing table "${table}": ${message}`;
        }
    }
    if (conn.driver === "mysql") {
        try {
            const mysql = await import("mysql2/promise");
            const db = await mysql.createConnection(conn.connection);
            const [rows] = await db.execute(`DESCRIBE \`${table}\``);
            await db.end();
            const arr = rows as DbRow[];
            const header = "| Field | Type | Null | Key | Default | Extra |";
            const sep_ = "|-------|------|------|-----|---------|-------|";
            const data = arr.map(
                (r: DbRow) =>
                    `| ${r.Field} | ${r.Type} | ${r.Null || "NO"} | ${r.Key || ""} | ${r.Default ?? ""} | ${r.Extra || ""} |`,
            );
            return [`**${table} schema:**`, "", header, sep_, ...data].join("\n");
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            return `Error describing table "${table}": ${message}`;
        }
    }
    return `Error: Unknown driver "${conn.driver}".`;
}

export async function resolveDbUrl(path: string, url: string, _cwd?: string): Promise<PiUrlResult> {
    const config = readDbConfig();
    if (!config || !config.connections || config.connections.length === 0) {
        return {
            content:
                "Error: No database connections configured. Create `~/.pi/agent/db-config.json` with your connections.",
            mime: "text/markdown",
            protocol: "db",
            path,
        };
    }

    const queryIndex = path.indexOf("?");
    const cleanPath = queryIndex === -1 ? path : path.slice(0, queryIndex);
    const queryString = queryIndex === -1 ? "" : path.slice(queryIndex + 1);
    let limit: number | undefined;
    let offset: number | undefined;
    if (queryString) {
        const search = new URLSearchParams(queryString);
        const limitRaw = search.get("limit");
        if (limitRaw !== null) {
            const parsed = Number(limitRaw);
            if (Number.isInteger(parsed)) limit = parsed;
        }
        const offsetRaw = search.get("offset");
        if (offsetRaw !== null) {
            const parsed = Number(offsetRaw);
            if (Number.isInteger(parsed)) offset = parsed;
        }
    }
    const pathParts = cleanPath.replace(/\/+$/, "").split("/").filter(Boolean);

    // pi://db/connections
    if (pathParts.length === 1 && pathParts[0] === "connections") {
        return { content: allConnections(config), mime: "text/markdown", protocol: "db", path };
    }

    const conn = resolveConnection(config);
    if (!conn) {
        const available = config.connections
            .map((c) => `${c.name} (\`${c.directory}\`)`)
            .join(", ");
        return {
            content: `No database connection found for this directory. Configured connections: ${available}.\n\nUse \`pi://db/connections\` to list all.`,
            mime: "text/markdown",
            protocol: "db",
            path,
        };
    }

    // pi://db/ or pi://db/tables
    if (pathParts.length === 0 || (pathParts.length === 1 && pathParts[0] === "tables")) {
        const tableList = await listTables(conn);
        const content = [
            `## Database: ${conn.name} (\`${conn.driver}\`)`,
            "",
            `**Directory**: \`${conn.directory}\``,
            "",
            "### Tables",
            "",
            tableList,
        ].join("\n");
        return { content, mime: "text/markdown", protocol: "db", path };
    }

    // pi://db/<table>/schema
    if (pathParts.length === 2 && pathParts[1] === "schema") {
        const content = await tableSchema(conn, pathParts[0]);
        return { content, mime: "text/markdown", protocol: "db", path };
    }

    // pi://db/<table>
    if (pathParts.length === 1) {
        const content = await queryTable(conn, pathParts[0], limit ?? 200, offset ?? 0);
        return { content, mime: "text/markdown", protocol: "db", path };
    }

    return {
        content: formatError(`Unknown db path: ${path}`, url),
        mime: "text/markdown",
        protocol: "db",
        path,
    };
}
