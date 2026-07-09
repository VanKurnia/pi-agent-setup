import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PiUrlResult, PI_AGENT_DIR, formatError } from "./types.ts";

interface DbConnection {
    name: string;
    driver: "sqlite" | "mysql";
    directory: string;
    connection: string;
    default?: boolean;
}

interface DbConfig {
    connections: DbConnection[];
}

function readConfig(): DbConfig | null {
    const configPath = join(PI_AGENT_DIR, "db-config.json");
    if (!existsSync(configPath)) return null;
    try {
        return JSON.parse(readFileSync(configPath, "utf-8")) as DbConfig;
    } catch {
        return null;
    }
}

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

function formatRowsToMarkdown(rows: any[]): string {
    if (!rows || rows.length === 0) return "_Empty (0 rows)_";
    const columns = Object.keys(rows[0]);
    const header = `| ${columns.join(" | ")} |`;
    const sep = `| ${columns.map(() => "---").join(" | ")} |`;
    const data = rows.map(
        (row: any) =>
            `| ${columns
                .map((col) => {
                    const v = row[col];
                    return v === null || v === undefined ? "NULL" : String(v).replace(/\|/g, "\\|");
                })
                .join(" | ")} |`,
    );
    return [header, sep, ...data].join("\n");
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
        } catch (e: any) {
            return `Error listing tables: ${e.message}`;
        }
    }
    if (conn.driver === "mysql") {
        try {
            const mysql: any = await import("mysql2/promise");
            const db = await mysql.createConnection(conn.connection);
            const [rows] = await db.execute("SHOW TABLES");
            await db.end();
            const arr = rows as any[];
            if (arr.length === 0) return "No tables found.";
            const key = Object.keys(arr[0])[0];
            return arr.map((r: any) => `- \`${r[key]}\``).join("\n");
        } catch (e: any) {
            return `Error listing tables: ${e.message}`;
        }
    }
    return `Unknown driver "${conn.driver}".`;
}

async function queryTable(conn: DbConnection, table: string, _limit: number = 20): Promise<string> {
    if (!safeTableName(table)) {
        return `Error: Invalid table name "${table}". Use only letters, numbers, and underscores.`;
    }
    if (conn.driver === "sqlite") {
        const { DatabaseSync } = await import("node:sqlite");
        try {
            if (!existsSync(conn.connection))
                return `Error: SQLite database not found at \`${conn.connection}\`.`;
            const db = new DatabaseSync(conn.connection);
            const rows = db.prepare(`SELECT * FROM "${table}" LIMIT ${_limit}`).all() as any[];
            db.close();
            const formatted = formatRowsToMarkdown(rows);
            if (rows.length === 0) return `Table \`${table}\` is empty (0 rows).`;
            return `**${table}** (${rows.length} rows):\n\n${formatted}`;
        } catch (e: any) {
            return `Error querying table "${table}": ${e.message}`;
        }
    }
    if (conn.driver === "mysql") {
        try {
            const mysql: any = await import("mysql2/promise");
            const db = await mysql.createConnection(conn.connection);
            const [rows] = await db.execute(`SELECT * FROM \`${table}\` LIMIT ${_limit}`);
            await db.end();
            const arr = rows as any[];
            const formatted = formatRowsToMarkdown(arr);
            if (arr.length === 0) return `Table \`${table}\` is empty (0 rows).`;
            return `**${table}** (${arr.length} rows):\n\n${formatted}`;
        } catch (e: any) {
            return `Error querying table "${table}": ${e.message}`;
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
            const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as any[];
            db.close();
            const header = "| # | Column | Type | Not Null | Default | PK |";
            const sep_ = "|---|--------|------|----------|---------|----|";
            const data = rows.map(
                (r: any) =>
                    `| ${r.cid} | ${r.name} | ${r.type} | ${r.notnull ? "YES" : ""} | ${r.dflt_value ?? ""} | ${r.pk ? "PK" : ""} |`,
            );
            return [`**${table} schema:**`, "", header, sep_, ...data].join("\n");
        } catch (e: any) {
            return `Error describing table "${table}": ${e.message}`;
        }
    }
    if (conn.driver === "mysql") {
        try {
            const mysql: any = await import("mysql2/promise");
            const db = await mysql.createConnection(conn.connection);
            const [rows] = await db.execute(`DESCRIBE \`${table}\``);
            await db.end();
            const arr = rows as any[];
            const header = "| Field | Type | Null | Key | Default | Extra |";
            const sep_ = "|-------|------|------|-----|---------|-------|";
            const data = arr.map(
                (r: any) =>
                    `| ${r.Field} | ${r.Type} | ${r.Null || "NO"} | ${r.Key || ""} | ${r.Default ?? ""} | ${r.Extra || ""} |`,
            );
            return [`**${table} schema:**`, "", header, sep_, ...data].join("\n");
        } catch (e: any) {
            return `Error describing table "${table}": ${e.message}`;
        }
    }
    return `Error: Unknown driver "${conn.driver}".`;
}

export async function resolveDbUrl(path: string, url: string): Promise<PiUrlResult> {
    const config = readConfig();
    if (!config || !config.connections || config.connections.length === 0) {
        return {
            content:
                "Error: No database connections configured. Create `~/.pi/agent/db-config.json` with your connections.",
            mime: "text/markdown",
            protocol: "db",
            path,
        };
    }

    const pathParts = path.replace(/\/+$/, "").split("/").filter(Boolean);

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
        const content = await queryTable(conn, pathParts[0]);
        return { content, mime: "text/markdown", protocol: "db", path };
    }

    return {
        content: formatError(`Unknown db path: ${path}`, url),
        mime: "text/markdown",
        protocol: "db",
        path,
    };
}
