/** Shared database configuration reader and markdown table formatter. */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeDir } from "./text-format.js";

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

/**
 * Overwrite `db-config.json` with `JSON.stringify(config, null, 2)` plus a
 * trailing newline (matching the file's current convention), then invalidate
 * the read-through cache so the next `readDbConfig()` re-reads from disk.
 * Single-user local write: no file-locking by design.
 */
export function writeDbConfig(config: DbConfig): void {
    const configPath = join(getAgentDir(), "db-config.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    _cachedConfig = null;
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

// =============================================================================
// Closest-dir resolver (scoring mirrors findParent in session-mgr/session-ops.ts)
// =============================================================================

function isBetterMatch(
    candidate: DbConnection,
    len: number,
    best: DbConnection | undefined,
    bestLen: number,
): boolean {
    if (!best) return true;
    if (len !== bestLen) return len > bestLen;
    if (!!candidate.default !== !!best.default) return !!candidate.default;
    return candidate.name.localeCompare(best.name) < 0;
}

/**
 * Find the closest-dir connection for `driver`: longest normalized `directory`
 * prefix of `cwd` wins (exact match counts as the best hit); ties prefer
 * `default: true`, then alphabetical name. Falls back to the driver's
 * `default: true` entry when nothing is a prefix of `cwd`.
 */
export function resolveClosestConnection(
    cwd: string,
    driver: "sqlite" | "mysql",
): DbConnection | undefined {
    const config = readDbConfig();
    if (!config) return undefined;
    const norm = normalizeDir(resolve(cwd));
    let best: DbConnection | undefined;
    let bestLen = -1;
    for (const c of config.connections || []) {
        if (c.driver !== driver) continue;
        const n = normalizeDir(resolve(c.directory));
        let len = -1;
        if (norm === n) len = Number.MAX_SAFE_INTEGER;
        else if (n.length < norm.length && norm.startsWith(`${n}/`)) len = n.length;
        else continue;
        if (isBetterMatch(c, len, best, bestLen)) {
            best = c;
            bestLen = len;
        }
    }
    if (best) return best;
    return (config.connections || [])
        .filter((c) => c.driver === driver && c.default)
        .sort((a, b) => a.name.localeCompare(b.name))[0];
}

/**
 * Resolve a tool param to a connection: empty → closest-dir default;
 * connection `name` (case-insensitive) → that entry; anything else passes
 * through untouched as an explicit path/URI override (never validated).
 */
export function resolveConnectionValue(
    input: string | undefined,
    cwd: string,
    driver: "sqlite" | "mysql",
): DbConnection | { passthrough: string } | undefined {
    if (input === undefined || input.trim() === "") {
        return resolveClosestConnection(cwd, driver);
    }
    const config = readDbConfig();
    const named = (config?.connections || []).find(
        (c) => c.name.toLowerCase() === input.toLowerCase(),
    );
    if (named) return named;
    return { passthrough: input };
}

/**
 * Mask the password in a `mysql://user:password@host/...` URI for human output.
 * Non-URI values (e.g. sqlite file paths, which carry no secret) pass through.
 */
export function maskConnection(connection: string): string {
    const m = connection.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/?#]*@)?([\s\S]*)$/);
    // Not a URI (e.g. a sqlite file path, which carries no secret): nothing to mask.
    if (!m) return connection;
    const [, scheme, auth, rest] = m;
    if (!auth) return connection;
    const user = auth.slice(0, -1).split(":")[0];
    return `${scheme}${user}:***@${rest}`;
}

export interface DbProbeResult {
    ok: boolean;
    latencyMs: number;
    error?: string;
}

/** Max time a single probe may take before it counts as unreachable. */
const PROBE_TIMEOUT_MS = 5000;

/** Strip any leaked URIs/passwords from driver errors + cap length. */
function sanitizeProbeError(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.replace(/mysql:\/\/\S+/gi, "mysql://***").slice(0, 300);
}

async function withTimeout<T>(promise: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Connection timed out after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** Minimal mysql2/promise surface used here: `execute` resolves the `[rows, fields]` tuple. */
export interface MysqlConnection {
    execute: (sql: string) => Promise<[unknown, unknown]>;
    end: () => Promise<void>;
}

/**
 * mysql2/promise's `createConnection`, provided by the extension that declares
 * mysql2 (db-viewer): extension imports resolve from the importing file, and
 * `shared/` lies outside every extension's node_modules tree. Probe helpers
 * take it as a lazy `loadMysql` callback so mysql2 is imported on demand.
 */
export type MysqlFactory = (uri: string) => Promise<MysqlConnection>;

/**
 * Single source of truth for connectivity checks (used by the `db_status`
 * tool and the `/db-status` command): `SELECT 1 AS ping` only, never writes.
 * Always resolves within ~5s; `error` is sanitized (no URI/password).
 */
export async function probeConnection(
    entry: DbConnection,
    loadMysql: () => Promise<MysqlFactory>,
): Promise<DbProbeResult> {
    const start = Date.now();
    try {
        await withTimeout(
            (async () => {
                if (entry.driver === "sqlite") {
                    const { DatabaseSync } = await import("node:sqlite");
                    const db = new DatabaseSync(entry.connection);
                    try {
                        db.prepare("SELECT 1 AS ping").get();
                    } finally {
                        db.close();
                    }
                } else {
                    const create = await loadMysql();
                    const conn = await create(entry.connection);
                    try {
                        await conn.execute("SELECT 1 AS ping");
                    } finally {
                        try {
                            await conn.end();
                        } catch {}
                    }
                }
            })(),
        );
        return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
        return { ok: false, latencyMs: Date.now() - start, error: sanitizeProbeError(error) };
    }
}

export interface DbStatusMatch {
    driver: "sqlite" | "mysql";
    name: string;
    directory: string;
    default?: boolean;
    ok: boolean;
    latencyMs: number;
    error?: string;
}

export interface DbStatus {
    cwd: string;
    matches: DbStatusMatch[];
    connections: string[];
    text: string;
}

/**
 * Resolve the closest-dir connections for `cwd` (optionally one `driver`
 * only), probe each, and format masked human-readable `text` from the same
 * data returned structurally — so tool `structuredContent` and command
 * `notify` output can never drift apart. Never includes full URIs.
 */
export async function getDbStatus(
    cwd: string,
    driver: "sqlite" | "mysql" | undefined,
    loadMysql: () => Promise<MysqlFactory>,
): Promise<DbStatus> {
    const drivers = driver ? [driver] : (["mysql", "sqlite"] as const);
    const config = readDbConfig();
    const connections = (config?.connections || []).map((c) => c.name);
    const matches: DbStatusMatch[] = [];
    const skipped: string[] = [];
    for (const d of drivers) {
        const match = resolveClosestConnection(cwd, d);
        if (!match) {
            skipped.push(d);
            continue;
        }
        const probe = await probeConnection(match, loadMysql);
        matches.push({
            driver: match.driver,
            name: match.name,
            directory: match.directory,
            ...(match.default ? { default: true as const } : {}),
            ok: probe.ok,
            latencyMs: probe.latencyMs,
            ...(probe.error ? { error: probe.error } : {}),
        });
    }
    const lines = [`DB status for ${cwd}:`];
    for (const m of matches) {
        const state = m.ok ? `ok (${m.latencyMs}ms)` : `FAIL (${m.latencyMs}ms): ${m.error}`;
        lines.push(
            `• ${m.name} (${m.driver}) — ${m.directory}${m.default ? " [default]" : ""} — ${state}`,
        );
    }
    for (const d of skipped) lines.push(`• no ${d} connection for this directory`);
    lines.push(
        `Connections: ${connections.length > 0 ? connections.join(", ") : "(none configured)"}`,
    );
    return { cwd, matches, connections, text: lines.join("\n") };
}
