## Codemode
Use codemode as a programmatic control plane: >=2 independent calls, iterative probing/retries, in-memory data joins (ETL), cross-turn state tracking (`store`/`load`), and dynamic tool introspection (`searchTools`, `describeTool`).
Pattern: Promise.allSettled or loops, synthesize in RAM, return concise (<2KB).
Never return raw >2KB. Single known read/grep: direct call. Avoid using codemode for calling subagent.
