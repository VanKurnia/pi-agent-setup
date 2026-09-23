<p align="center">
  <img src="https://pi.dev/logo-auto.svg" width="120" alt="pi">
</p>

<h1 align="center">Pi Agent Setup</h1>

<p align="center">
  <a href="https://github.com/VanKurnia/pi-agent-setup"><img src="https://img.shields.io/github/stars/VanKurnia/pi-agent-setup?style=flat-square&logo=github" alt="Stars"></a>
  <a href="https://github.com/VanKurnia/pi-agent-setup/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-0.87.1-8A2BE2?style=flat-square" alt="pi"></a>
</p>

<p align="center">
  Personal configuration, extensions, skills, and prompts for
  <a href="https://pi.dev">pi</a> — the terminal AI coding assistant.
</p>

<p align="center">
  <a href="#quick-setup">Quick Setup</a> •
  <a href="#whats-included">What's Included</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#custom-models">Custom Models</a>
</p>

---

## Quick Setup

Clone this repo to `~/.pi` — pi reads everything from there.

> **Run these commands in Git Bash.** On Windows, `~` expands in bash but **not** in cmd or PowerShell. Alternatives: `%USERPROFILE%\.pi` (cmd) or `$HOME\.pi` (PowerShell).

### Fresh machine

```bash
git clone https://github.com/VanKurnia/pi-agent-setup.git ~/.pi
cd ~/.pi
bash install.sh
```

Then run `/login` inside pi to set up your provider.

### Upgrading an existing setup

```bash
cd ~/.pi
bash install.sh
```

`install.sh` is idempotent: it fetches the latest version, stashes any local changes, and reinstalls dependencies while preserving your existing config files.

> **Note:** The older `update.sh` still exists alongside `install.sh` for backwards compatibility. `install.sh` is the recommended entry point for both fresh and upgrade scenarios.

### Post-install

- **`/login`** — authenticate with your provider (API key or subscription)
- **Nerd Font** — required for icons in the TUI. Without one, you'll see garbled characters in menus and dialogs. [Download here](https://www.nerdfonts.com/font-downloads).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `bash` not found | Install [Git for Windows](https://git-scm.com/download/win). Pi auto-detects Git Bash. |
| Extension not loading | Run `bash install.sh` to reinstall deps. Check `agent/auth.json` exists. |
| Icons look broken | Install a Nerd Font and set it as your terminal font. |
| `install.sh` / `update.sh` fails | Run in Git Bash (Windows) or bash (Linux/macOS). The `~` path doesn't expand in cmd/PowerShell. |

## Pi URL Ecosystem (`pi://`)

The `resolve_pi_url` tool resolves 5 internal protocols that interconnect all extensions:

| Protocol | Description | Example |
|----------|-------------|--------|
| `pi://vault/` | Read Obsidian notes with wikilink resolution — wikilinks emit `pi://vault/` URLs, not dead ends | `pi://vault/Projects/Pi Agent/Index Pi Agent` |
| `pi://skill/` | Read agent skill docs | `pi://skill/orchestrator` |
| `pi://workspace/` | Git workspace snapshot (status, files, branch) | `pi://workspace/` |
| `pi://health/` | Validation check across vault, workspace, branch | `pi://health/` |
| `pi://db/` | Schema and query results for configured databases | `pi://db/hris/schema` |

### Self-Referencing Loop

Every extension's output now produces `pi://` URLs that feed back into the resolver:

```
git_status     → pi://workspace/ + health/  → resolve_pi_url shows workspace snapshot
db queries     → pi://db/<name>/schema      → resolve_pi_url explores schema
vault notes    → wikilinks → pi://vault/    → resolve_pi_url reads linked notes
```

### Cross-Extension API

The `internal-url-resolver` exposes `"pi-url"` with `{ resolvePiUrl, registerProtocol, listProtocols }`. Any extension can register a new protocol — it auto-appears in the tool description and error messages.

### Context Injection

Vault context is injected once per session (not per turn) with a nudge: `resolve_pi_url → ffgrep`. This trains the agent to use `pi://` URLs before falling back to grep.

---

## External Integrations

Pi connects to these external tools and services (not counting Pi packages):

| Tool / Service | Integration | Status |
|----------------|-------------|--------|
| [[Obsidian]] | Obsidian Suite auto-detects vault, injects Index + project context once per session. | Active |
| [[9router]] | Local LLM routing proxy at `localhost:20128`. Available as a provider alongside `opencode-go` (current `defaultProvider`); ninerouter extension also exposes it as native web tools. | Active |
| [[VS Code]] / Zed / Neovim | `pi-x-ide` polls active file path and selection. Reconnects on session start, injects context per user message. | Active |
| [[MySQL]] | `db-viewer` extension provides `query_mysql` tool — read-only queries via connection URI. | Active |
| [[SQLite]] | `db-viewer` extension provides `query_sqlite` tool — read-only queries against local `.db` files. | Active |
| [[Git]] | `git-toolkit` extension wraps 12 Git operations. Shell: Git Bash at `C:\Program Files\Git\bin\bash.exe`. | Active |
| [[Chrome]] / Puppeteer | `browser-tools` extension provides browser automation. | Active |
| [[Node.js]] | Runtime for all extensions (loaded via jiti). Version managed by nvm. | Active |


---

## What's Included

### Extensions

| Extension | Description |
|-----------|-------------|
| `ask-user-question` | Interactive Q&A dialog (`ask_user_question` tool) |
| `bash-guard` | Validates bash commands before execution (`/bash-guard`) |
| `browser-tools` | Browser automation — 7 `browser_*` tools (start, nav, eval, pick, content, screenshot, cookies) |
| `custom-header` | Customizable startup header |
| `db-viewer` | Secure read-only SQLite/MySQL viewer (`query_sqlite`, `query_mysql`); outputs `pi://db/` links |
| `filechanges` | Tracks diffs across edits (`/filechanges`, `/filechanges-accept`, `/filechanges-decline`) |
| `git-toolkit` | 12 `git_*` tools (status, diff, log, commit, branch…); appends `pi://workspace/` + `pi://health/` footers |
| `herdr-agent-state` | Agent-state sync for the herdr integration (managed file — do not edit) |
| `internal-url-resolver` | Resolves `pi://` URLs (vault, skill, workspace, health, db); cross-extension protocol registry |
| `load-env` | Loads `agent/.env` at startup |
| `ninerouter` | Minimal native 9router web tools (`ninerouter_web_search`, `ninerouter_web_fetch`); config in `agent/9router-config.json` |
| `obsidian-suite` | Vault auto-detection, context injection, `/obsidian-status` + `/obsidian-path` commands |
| `open-code-review` | AI-powered review of git changes (`ocr_review`, `ocr_scan`, `ocr_health`) |
| `pi-cbm` | Codebase memory index — 15 native tools (`search_graph`, `search_code`, `read_symbol`, `resolve_symbol`, `get_code_snippet(s)`, `trace_path`, `get_architecture`, `query_graph`…). Auto-indexes current git repo on session start. |
| `pi-speeed` | Session performance monitoring (`/pi-speeed`) |
| `pi-tool-display` | Local config stub; implementation comes from the npm package of the same name |
| `plan-artifact` | Browser UI for `.plans/` markdown with commenting and syntax highlighting |
| `subagents` | Subagent orchestration for delegating tasks (`subagent` tool, `/reload-agents`, `/subagents:settings`) |
| `thinking-fold` | Collapsible thinking blocks with per-model behavior (`/thinking-fold-settings`) |
| `update-setup` | Runs `update.sh` inside pi with live output widget (`/update-setup`) |

### External Packages

| Package | Description |
|---------|-------------|
| `@ff-labs/pi-fff` | Fuzzy file finder (`fffind`) and content grep (`ffgrep`) |
| `pi-x-ide` | VS Code / IDE integration |
| `pi-zentui` | Extended TUI components |
| `pi-blackhole` | Session compaction & observation engine — manages context window via truncation, reflection, and automatic archival |
| `pi-speeed` | Performance monitoring for pi agent sessions (npm companion to the local extension) |
| `pi-smart-fetch` | Enhanced web-fetch tool |
| `pi-smart-web-search` | Enhanced web-search tool |
| `pi-extmgr` | Extension management commands |
| `pi-tool-display` | TUI rendering — collapsed tool output, diff visualization, thinking labels. |

### Skills

| Skill | Description |
|-------|-------------|
| `grill-me` | Stress-test plans through relentless questioning |
| `improve` | Read-only codebase audit with prioritized implementation plans |
| `improve-codebase-architecture` | Scan for deepening opportunities — surface architectural friction with visual HTML report |
| `open-code-review` | AI-powered review of git changes via the `ocr` CLI |
| `orchestrator` | Session orchestration: subagent routing, context hygiene |
| `posting` | File-based API client (Postman/Insomnia alternative) — pi maintains `*.posting.yaml` collections, the human drives the TUI |

### Prompts

| Prompt | Description |
|--------|-------------|
| `bro` | Rephrase the last message in casual Indonesian, junior-SWE style |
| `commit` | Generate git commit title + description |
| `initiate-base-knowledge` | Bootstrap context with workspace rules and architecture |
| `review-changes` | Review all changes via `ocr_review`, then inspect flagged hunks — correctness, edge cases, side effects |
| `set-scope` | Set working scope to given paths and understand them deeply before proceeding |
| `simplify-changes` | Simplify a completed workpackage without changing its behavior |

---

## Configuration

### Provider & Models

Set your default provider and model in `agent/settings.json`:

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "muse-spark-1.3-contributor",
  "defaultThinkingLevel": "xhigh"
}
```

### Shell (Windows)

Pi auto-detects Git Bash. Only set a custom path for non-standard installations:

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

### Subagent Models

Configure per-agent models via `/subagents:settings` inside pi. Settings are stored in `agent/subagents.json`:

```json
{
  "maxConcurrent": 4,
  "agentModels": {
    "scout": "opencode-go/mimo-v2.6-flash",
    "worker": "opencode-go/muse-spark-1.3-contributor"
  },
  "agentThinking": {
    "scout": "high",
    "worker": "xhigh"
  }
}
```

Per-agent models plus thinking levels, edited via `/subagents:settings` — settings are the single source of truth.

### Custom Models

Add local or custom API endpoints in `agent/models.json`:

```jsonc
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.2" },
        { "id": "deepseek-coder:6.7b" }
      ]
    },
    "lm-studio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "models": [
        { "id": "local-model" }
      ]
    }
  }
}
```

See [pi.dev/docs/latest/models](https://pi.dev/docs/latest/models) for provider details.

## Acknowledgements

Inspired by [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config).
