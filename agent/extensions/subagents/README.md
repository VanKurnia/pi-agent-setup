# Minimal Subagents

A pi extension that registers a single `subagent` tool with three agents:

| Agent | Tools | Model | Purpose |
|-------|-------|-------|---------|
| **scout** | read, grep, find, ls | claude-haiku-4-5 | Fast codebase recon |
| **researcher** | web_search, web_fetch | claude-sonnet-4-6 | Web research |
| **worker** | read, write, edit, safe_bash | claude-sonnet-4-6 | Code changes |
| — | git_status, git_diff, git_log, etc. | — | Git operations (via git-toolkit) |
| — | query_sqlite, query_mysql | — | Database queries (via db-viewer) |

## Usage

**Single mode:**
```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

**Parallel mode:**
```json
{ "tasks": [
  { "agent": "scout", "task": "Map the database layer" },
  { "agent": "researcher", "task": "Best practices for connection pooling" }
]}
```

Max 4 concurrent subagents (configurable). Each runs as an isolated `pi` process with no inherited context — all context must be in the task description.

## Config

Optional `config.json` next to `index.ts`:

```json
{ "maxConcurrency": 4 }
```

## UI

Default view shows medium detail (agent status, task preview, recent tools). Expand to see full task, all tool calls, complete output, and token usage.

## Registering Agents from Other Extensions

Other extensions can dynamically register and unregister agents at runtime. This is useful for domain-specific agents that should only be available when a particular extension is active.

### 1. Define agent `.md` files

Create markdown files with YAML frontmatter in your extension's directory (e.g. `my-extension/agents/my-agent.md`):

```markdown
---
name: my-agent
description: Does a specific thing
tools: web_search, video_extract
model: claude-sonnet-4-20250514
---

You are an agent that does a specific thing...
```

Frontmatter fields:
- **name** (required) — unique agent name, used in `{ agent: "my-agent" }` calls
- **description** — short description
- **tools** — comma-separated list of tools the agent needs (builtin or extension)
- **model** — model identifier (defaults to `anthropic/claude-sonnet-4-6`)

The markdown body becomes the agent's system prompt.

### 2. Register agents via the shared cross-extension API module

Pi loads extensions via jiti, which creates separate module instances. The preferred way to register agents is via the shared cross-extension API module at `agent/extensions/shared/cross-extension-api.ts`:

```typescript
import { registerExtensionApi } from "../shared/cross-extension-api.js";
import type { AgentConfig } from "../subagents/src/types.js";

registerExtensionApi<{ registerAgent: (config: AgentConfig) => void; unregisterAgent: (name: string) => void }>("subagents", { registerAgent, unregisterAgent });
```

> **Note**: The old `api-registry.ts` at `subagents/src/api-registry.ts` is deprecated and re-exports from the shared module. New code should import from `../shared/cross-extension-api.js` directly.

The `globalThis.__pi_subagents` bridge pattern below is still viable for runtime interop when module imports are not available (e.g., dynamically loaded script contexts):

```typescript
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import { fileURLToPath } from "node:url";

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model: string;
  systemPrompt: string;
  filePath: string;
}

const AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

function registerMyAgents(): void {
  const subagents = (globalThis as any).__pi_subagents as
    | { registerAgent: (config: AgentConfig) => void; unregisterAgent: (name: string) => void }
    | undefined;
  if (!subagents) return; // subagents extension not loaded

  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;

    const tools = (frontmatter.tools || "").split(",").map(t => t.trim()).filter(Boolean);
    try {
      subagents.registerAgent({
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools,
        model: frontmatter.model || "anthropic/claude-sonnet-4-6",
        systemPrompt: body,
        filePath,
      });
    } catch {
      // Already registered — skip
    }
  }
}
```

Call `registerMyAgents()` when your extension activates (e.g. in a command handler). The agents become available to the `subagent` tool immediately.

### 3. Adding custom tool support

If your agents need tools beyond the built-in set, those tools must be mapped in the `CUSTOM_TOOL_EXTENSIONS` record in `subagents/index.ts`:

```typescript
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
  safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
  git_status: path.join(EXT_BASE, "git-toolkit.ts"),
  git_diff_unstaged: path.join(EXT_BASE, "git-toolkit.ts"),
  git_diff_staged: path.join(EXT_BASE, "git-toolkit.ts"),
  git_diff: path.join(EXT_BASE, "git-toolkit.ts"),
  git_add: path.join(EXT_BASE, "git-toolkit.ts"),
  git_commit: path.join(EXT_BASE, "git-toolkit.ts"),
  git_reset: path.join(EXT_BASE, "git-toolkit.ts"),
  git_log: path.join(EXT_BASE, "git-toolkit.ts"),
  git_create_branch: path.join(EXT_BASE, "git-toolkit.ts"),
  git_checkout: path.join(EXT_BASE, "git-toolkit.ts"),
  git_show: path.join(EXT_BASE, "git-toolkit.ts"),
  git_branch: path.join(EXT_BASE, "git-toolkit.ts"),
  query_sqlite: path.join(EXT_BASE, "db-viewer", "index.ts"),
  query_mysql: path.join(EXT_BASE, "db-viewer", "index.ts"),
};
```

Built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) work automatically. Any other tool the agent lists in its frontmatter must have a corresponding entry here pointing to the extension's `index.ts`.

## Structure

```
subagents/
├── index.ts           # Extension entry point
├── agents/            # Built-in agent configs (frontmatter + system prompt)
└── tools/             # Extensions loaded into subagent processes
    └── safe-bash.ts   # bash with dangerous command blocking
```
