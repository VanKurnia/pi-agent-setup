## Codemode
Use codemode for >=2 independent calls, large output needing filter, or multi MCP calls. Pattern: Promise.allSettled, filter, return concise. Never return raw >2KB. Single known read/grep: direct call. avoid using codemode for calling subagent.
