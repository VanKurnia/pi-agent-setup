import { describe, it, expect } from "vitest";

// Re-implement the allowlist logic here for testing (keep in sync with index.ts)
function isQuerySafe(sql: string): { safe: boolean; reason?: string } {
	const trimmed = sql.trim();
	if (!trimmed) return { safe: false, reason: "Query is empty" };
	const firstWordMatch = trimmed.match(/^\s*(\w+)/);
	if (!firstWordMatch) return { safe: false, reason: "Could not parse query start" };
	const firstWord = firstWordMatch[1]!.toLowerCase();
	const allowed = new Set(["select", "show", "describe", "explain", "pragma", "use", "with"]);
	if (!allowed.has(firstWord))
		return { safe: false, reason: `Only read-only queries ...` };
	if (firstWord === "with") {
		// Find ALL keyword occurrences and check the LAST one.
		const allKeywords = trimmed.match(/\b(WITH|SELECT|UPDATE|DELETE|INSERT|CREATE|DROP|ALTER|TRUNCATE|REPLACE|MERGE|CALL|EXECUTE|IMPORT|LOAD)\b/gi);
		if (allKeywords && allKeywords.length > 0) {
			const lastAction = allKeywords[allKeywords.length - 1].toLowerCase();
			if (lastAction !== "select" && lastAction !== "with")
				return { safe: false, reason: `CTE ending with ...` };
		}
	}
	return { safe: true };
}

describe("isQuerySafe", () => {
	// Allowed queries
	it.each([
		"SELECT * FROM users",
		"select 1",
		"SELECT id, name FROM orders WHERE status = 'active'",
		"SHOW TABLES",
		"describe users",
		"EXPLAIN SELECT * FROM users",
		"PRAGMA table_info(users)",
		"USE my_database",
		"WITH cte AS (SELECT 1) SELECT * FROM cte",
		"SELECT * FROM users WHERE name = 'insert'",   // keyword inside string
		"SELECT * FROM users WHERE name = 'delete'",   // keyword inside string
		"SELECT 1 -- comment with drop",
		"select   *   from    users",                   // extra whitespace
		"SELECT\n*\nFROM\nusers",                       // multiline
	])("should allow: %s", (sql) => {
		expect(isQuerySafe(sql).safe).toBe(true);
	});

	// Blocked queries
	it.each([
		"INSERT INTO users VALUES (1)",
		"UPDATE users SET name = 'x'",
		"DELETE FROM users",
		"DROP TABLE users",
		"ALTER TABLE users ADD COLUMN x INT",
		"CREATE TABLE x (id INT)",
		"TRUNCATE users",
		"REPLACE INTO users VALUES (1)",
		"MERGE INTO users USING ...",
		"CALL my_proc()",
		"EXECUTE my_proc",
		"IMPORT TABLE ...",
		"LOAD DATA ...",
		"GRANT ALL ON ...",
		"REVOKE ALL ON ...",
		"",                                          // empty
		"  ",                                        // whitespace only
		"INSERT",                                    // incomplete but starts with mutation keyword
		"WITH cte AS (...) DELETE FROM users",        // CTE ending in mutation
		"WITH cte AS (...) INSERT INTO users VALUES (1)", // CTE ending in mutation
		"WITH cte AS (...) DROP TABLE users",         // CTE ending in mutation
		"WITH cte1 AS (SELECT 1), cte2 AS (SELECT 2) DELETE FROM users", // multi-CTE ending in mutation
	])("should block: %s", (sql) => {
		expect(isQuerySafe(sql).safe).toBe(false);
	});
});
