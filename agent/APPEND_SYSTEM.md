## Codemode
Use codemode as a programmatic control plane: >=2 independent calls, iterative probing/retries, in-memory data joins (ETL), cross-turn state tracking (`store`/`load`), and dynamic tool introspection (`searchTools`, `describeTool`).
Pattern: Promise.allSettled or loops, synthesize in RAM, never return more than 2KB raw. Single known read/grep: direct call. Avoid using codemode for calling subagent.

## Search
- `ffgrep` parses every pattern as regex first, so `$x`, balanced parens or quotes give a confident false "No matches". Use `rg -F` there, or escape (`\$request`).
- `ffgrep` returns no totals and ranks by frecency. For "all of them" or "how many", use `rg --stats`.
