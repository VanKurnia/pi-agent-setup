/** Shared database configuration reader and markdown table formatter. */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface DbConnection {
    name: string;
    driver: "sqlite" | "mysql";
    directory: string;
    connection: string;
    default?: boolean;
}

export interface DbConfig {
    connections: DbConnection[];
}

export type DbRow = Record<string, unknown>;

let _cachedConfig: { config: DbConfig | null; mtimeMs: number } | null = null;

export function readDbConfig(): DbConfig | null {
    const configPath = join(getAgentDir(), "db-config.json");
    let mtimeMs: number;
    try {
        mtimeMs = statSync(configPath).mtimeMs;
    } catch {
        _cachedConfig = { config: null, mtimeMs: 0 };
        return null;
    }
    if (_cachedConfig && _cachedConfig.mtimeMs === mtimeMs) return _cachedConfig.config;
    try {
        const config = JSON.parse(readFileSync(configPath, "utf-8")) as DbConfig;
        _cachedConfig = { config, mtimeMs };
        return config;
    } catch {
        _cachedConfig = { config: null, mtimeMs };
        return null;
    }
}

export function formatRowsToMarkdown(
    rows: Record<string, unknown>[],
    emptyText = "Query executed successfully. 0 rows returned.",
): string {
    if (!rows || rows.length === 0) {
        return emptyText;
    }
    const columns = Object.keys(rows[0]);
    const headers = `| ${columns.join(" | ")} |`;
    const separators = `| ${columns.map(() => "---").join(" | ")} |`;
    const dataRows = rows.map((row) => {
        return `| ${columns
            .map((col) => {
                const val = row[col];
                if (val === null || val === undefined) return "NULL";
                return String(val).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
            })
            .join(" | ")} |`;
    });
    return [headers, separators, ...dataRows].join("\n");
}

export function findDbConnectionByValue(
    config: DbConfig,
    dbPath: string,
    connStr: string,
): DbConnection | undefined {
    return (config.connections || []).find(
        (c) =>
            (c.driver === "sqlite" && c.connection === dbPath) ||
            (c.driver === "mysql" && c.connection === connStr),
    );
}
