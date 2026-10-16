# Minimal Subagents

A pi extension that registers a single `subagent` tool with two agents:

`~/.pi/agent/subagents.json` is the single source of truth for per-agent model and thinking level — edit it via `/subagents:settings`. If the file is missing, the first `subagent` invocation creates it, seeded with the active session model. Agent `.md` frontmatter may declare a fallback `model:`; once `subagents.json` has an entry for an agent, that entry wins (the file is seeded with the active session model on first use).

| Agent      | Tools                                                                                                                             | Model                     | Purpose                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------- |
| **scout**  | read, ffgrep, fffind, recall, powershell, query_sqlite, query_mysql, web_search, web_fetch, ninerouter_web_search, ninerouter_web_fetch | via `/subagents:settings` | Fast codebase recon + lightweight web research |
| **worker** | read, write, edit, powershell, ffgrep, fffind, recall, query_sqlite, query_mysql, codemode                                              | via `/subagents:settings` | Code changes                                   |
| —          | git status, git diff, git log, etc.                                                                                               | —                         | Git operations (via terminal)                  |
| —          | query_sqlite, query_mysql                                                                                                         | —                         | Database queries (via db-viewer)               |

## Usage

**Single mode:**

```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

**Parallel mode:**

```json
{
    "tasks": [
        { "agent": "scout", "task": "Map the database layer" },
        { "agent": "scout", "task": "Best practices for connection pooling (web research)" }
    ]
}
```

Max 4 concurrent subagents (configurable in `subagents.json` or via `/subagents:settings`). Each runs as an in-process one-shot SDK session (`createAgentSession` with an in-memory session) with no inherited conversation — attach all context to the task; a read-only parent snapshot is added automatically. Note: when 3+ subagents run codemode-heavy work at once, excess workers fail with `Codemode worker limit reached` (pi 1.3.0 process-wide cap of 2) — retry or stagger the runs.

The tool also supports `chain` (sequential steps with `{previous}` substitution) and `hybrid` (ordered single/parallel/chain phases).

## Config

`~/.pi/agent/subagents.json` (created on first use, editable via `/subagents:settings`):

```json
{
    "maxConcurrency": 4,
    "agentModels": { "scout": "provider/model" },
    "agentThinking": { "worker": "high" }
}
```

`agentModels` values must be `provider/model`; `agentThinking` must be one of the thinking levels listed in `src/core.ts` (`THINKING_LEVELS`).

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

Pi loads extensions via jiti, which creates separate module instances. Register via the shared cross-extension API module at `agent/extensions/shared/cross-extension-api.ts`:

```typescript
import { registerExtensionApi } from "../shared/cross-extension-api.js";
import type { AgentConfig } from "../subagents/src/core.js";

registerExtensionApi<{
    registerAgent: (config: AgentConfig) => void;
    unregisterAgent: (name: string) => void;
}>("subagents", { registerAgent, unregisterAgent });
```

**Known limitation**: `registerExtensionApi`/`getExtensionApi` share a module-instance-private registry — pi loads each extension with its own jiti instance, so it does not cross extension boundaries in production (see the header of `agent/extensions/shared/cross-extension-api.ts`). Cross-extension agent registration therefore does not currently work and is tracked as a deferred finding in `.plans/README.md`.

### 3. Custom tool support

Tools listed in agent configs are passed to `createAgentSession()`. Built-in tools
(`read`, `write`, `edit`, `powershell`) work automatically.
Extension-provided tools registered via `pi.registerTool()` in the main session
are also available in subagent sessions through the pi SDK's session creation.
If an agent needs a tool that isn't available, verify it's registered as a pi
extension in the main session.

## Structure

```
subagents/
├── index.ts           # Extension entry point
├── agents/            # Built-in agent configs (frontmatter + system prompt)
└── src/               # Execution core, dispatcher, and rendering
```

## Dependencies

The delegation snapshot resolves blackhole's snapshot provider through the shared contract in `agent/extensions/shared/blackhole-api.ts` (`setBlackholeSnapshotApi` / `getBlackholeSnapshotApi`, `globalThis`-backed because the loader isolates each extension's module registry). When blackhole is not loaded or the provider is absent, the snapshot degrades to empty and the task still runs.
