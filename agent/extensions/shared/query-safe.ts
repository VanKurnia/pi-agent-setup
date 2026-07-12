/** Strict allowlist: only permit SQL statements whose first keyword is read-only. */
export function isQuerySafe(sql: string): { safe: boolean; reason?: string } {
    const trimmed = sql.trim();
    if (!trimmed) {
        return { safe: false, reason: "Query is empty" };
    }

    // Extract the first non-whitespace word/token. This is harder to bypass
    // than a keyword-inside-string blacklist. We match the first identifier
    // or keyword-like token.
    const firstWordMatch = trimmed.match(/^\s*(\w+)/);
    if (!firstWordMatch) {
        return { safe: false, reason: "Could not parse query start" };
    }

    const firstWord = firstWordMatch[1]!.toLowerCase();
    const allowed = new Set([
        "select",
        "show",
        "describe",
        "explain",
        "pragma",
        "use",
        "with",
        // "with" allows CTEs like "WITH cte AS (SELECT ...) SELECT * FROM cte"
        // which are read-only.
    ]);

    if (!allowed.has(firstWord)) {
        return {
            safe: false,
            reason: `Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN, PRAGMA, USE, WITH) are allowed. Got "${firstWord}".`,
        };
    }

    // For CTEs starting with WITH, verify the overall statement terminates
    // with a read-only clause. A "WITH ... DELETE" or "WITH ... INSERT" is
    // mutation disguised as a read query.
    if (firstWord === "with") {
        // Find ALL keyword occurrences and check the LAST one (at end of statement).
        // We use a global match to find every keyword-like token, then take the last.
        const allKeywords = trimmed.match(
            /\b(WITH|SELECT|UPDATE|DELETE|INSERT|CREATE|DROP|ALTER|TRUNCATE|REPLACE|MERGE|CALL|EXECUTE|IMPORT|LOAD)\b/gi,
        );
        if (allKeywords && allKeywords.length > 0) {
            const lastAction = allKeywords[allKeywords.length - 1].toLowerCase();
            if (lastAction !== "select" && lastAction !== "with") {
                return {
                    safe: false,
                    reason: `CTE (WITH) ending with "${lastAction}" is not read-only. Only WITH ... SELECT is allowed.`,
                };
            }
        }
    }

    return { safe: true };
}
