# plan-artifact (pi extension)

Renders `.plans/` markdown as a browser UI with inline commenting, syntax highlighting, and mermaid diagrams.

## Features

- Browser-based markdown renderer (marked.js + highlight.js + mermaid.js)
- GFM compliance: strikethrough, autolinks, task lists, tables
- Inline section commenting with edit/delete support
- Accept/reject workflow with batched comment delivery to assistant
- TUI widget showing plan status (`plan_artifact` tool, `/plan-artifact` command)

## Usage

1. Call the `plan_artifact` tool with `summary` and `plan` (markdown) parameters
2. A local HTTP server starts and serves the rendered plan
3. The TUI shows a clickable widget link to the browser URL
4. Use `/plan-artifact` to open the TUI review overlay

### Comment workflow

- Add/edit/delete comments on any section (silent — no individual notifications)
- On **Accept** or **Request Changes**, all comments are batched and delivered to the assistant in a single message

## Cross-extension API

Registers via `registerExtensionApi("plan-artifact", ...)`. Consumable by other extensions:

```ts
import { getExtensionApi } from "../shared/cross-extension-api.js";

const api = getExtensionApi<PlanArtifactApi>("plan-artifact");
if (api) {
  api.isRunning();   // boolean
  api.getUrl();      // string | null
  api.getSummary();  // string | null
}
```

## Notes

- Plans live in `.plans/` at the repo root (written by the `improve` skill)
- Server starts on propose, stops 15s after accept/reject
- Comments are append-only events in `.plans/comments.jsonl` (audit log)
- Token-authenticated: each server instance generates a random 16-byte hex token
