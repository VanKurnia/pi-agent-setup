<p align="center">
  <img src="https://pi.dev/logo-auto.svg" width="120" alt="pi">
</p>

<h1 align="center">Pi Agent Setup</h1>

<p align="center">
  <a href="https://github.com/VanKurnia/pi-agent-setup"><img src="https://img.shields.io/github/stars/VanKurnia/pi-agent-setup?style=flat-square&logo=github" alt="Stars"></a>
  <a href="https://github.com/VanKurnia/pi-agent-setup/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-0.80.2-8A2BE2?style=flat-square" alt="pi"></a>
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
memory_recall  → pi://vault/_agent/memory/  → resolve_pi_url reads full file
memory_write   → pi://vault/_agent/memory/  → resolve_pi_url reads recent entries
git_status     → pi://workspace/ + health/  → resolve_pi_url shows workspace snapshot
db queries     → pi://db/<name>/schema      → resolve_pi_url explores schema
vault notes    → wikilinks → pi://vault/    → resolve_pi_url reads linked notes
```

### Cross-Extension API

The `internal-url-resolver` exposes `"pi-url"` with `{ resolvePiUrl, registerProtocol, listProtocols }`. Any extension can register a new protocol — it auto-appears in the tool description and error messages.

### Context Injection

Vault context is injected once per session (not per turn) with a nudge: `memory_recall → resolve_pi_url → ffgrep`. This trains the agent to use `pi://` URLs before falling back to grep.

---

## External Integrations

Pi connects to these external tools and services (not counting Pi packages):

| Tool / Service | Integration | Status |
|----------------|-------------|--------|
| [[Obsidian]] | Obsidian Suite auto-detects vault, injects Index + project context once per session. | Active |
| [[OmniRoute]] | Local AI gateway at `localhost:20128`. Default provider (`defaultProvider: "omni"`) — all model requests route through it. | Active |
| [[VS Code]] / Zed / Neovim | `pi-x-ide` polls active file path and selection. Reconnects on session start, injects context per user message. | Active |
| [[MySQL]] | `db-viewer` extension provides `query_mysql` tool — read-only queries via connection URI. | Active |
| [[SQLite]] | `db-viewer` extension provides `query_sqlite` tool — read-only queries against local `.db` files. | Active |
| [[Git]] | `git-toolkit` extension wraps 12 Git operations. Shell: Git Bash at `C:\Program Files\Git\bin\bash.exe`. | Active |
| [[Chrome]] / Puppeteer | `browser-tools` extension provides browser automation. | Active |
| [[Node.js]] | Runtime for all extensions (loaded via jiti). Version managed by nvm. | Active |

**Single point of failure:** OmniRoute is the only provider. If it goes down, Pi has no models to call. Consider a local fallback (Ollama) or direct API key.

---

## What's Included

### Extensions

| Extension | Description |
|-----------|-------------|
| `bash-guard` | Safeguards bash commands — validates before execution |
| `browser-tools` | Chrome DevTools automation (puppeteer, Readability, jsdom) |
| `db-viewer` | Secure read-only SQLite/MySQL viewer; outputs `pi://db/` links |
| `filechanges` | Tracks diffs across edits |
| `git-toolkit` | Git status, diff, log, commit, branch; appends `pi://workspace/` + `pi://health/` footers |
| `internal-url-resolver` | Resolves `pi://` URLs (vault, skill, workspace, health, db); cross-extension protocol registry |
| `obsidian-memory` | Agent memory read/write as vault markdown; outputs `pi://vault/` links |
| `obsidian-suite` | Vault auto-detection, context injection, `/obsidian-path` command |
| `subagents` | Subagent orchestration for delegating tasks |
| `plan-mode` | Step-by-step plan authoring and tracking |
| `handoff` | Model-switch briefs for /compact |
| `update-setup` | Runs `update.sh` inside pi with live output widget |
| `ask-user-question` | Interactive Q&A dialog |
| `context` | Token usage grid overlay (`/context`) |
| `custom-header` | Customizable startup header |
| `md-link` | Collaborative `.md` editing (`/link-md`, `/send-diff`) |
| `plan-artifact` | Browser UI for `.plans/` markdown with commenting and syntax highlighting |
| `zz-read-only-mode` | Toggle read-only (`/read-only`) |

### External Packages

| Package | Description |
|---------|-------------|
| `@ff-labs/pi-fff` | Fuzzy file finder (`fffind`) and content grep (`ffgrep`) |
| `route-web-tools` | Web search and URL content extraction (`route_web_search`, `route_web_fetch`) |
| `omniroute-pi-ext-integration` | OmniRoute model sync, combo management, `/omni` commands |
| `pi-x-ide` | VS Code / IDE integration |
| `pi-zentui` | Extended TUI components |
| `pi-blackhole` | Session compaction & observation engine — manages context window via truncation, reflection, and automatic archival |
| `pi-speeed` | Performance monitoring for pi agent sessions |

### Skills

| Skill | Description |
|-------|-------------|
| `grill-me` | Stress-test plans through relentless questioning |
| `improve` | Read-only codebase audit with prioritized implementation plans |
| `obsidian` | Vault navigation protocol, link qualification, writing conventions |
| `orchestrator` | Session orchestration: subagent routing, context hygiene |
| `stop-slop` | Strips AI writing patterns from prose |

### Prompts

| Prompt | Description |
|--------|-------------|
| `commit-auto` | Conventional commit messages from staged changes |
| `review-changes` | Systematic diff review — correctness, edge cases, side effects |

---

## Configuration

### Provider & Models

Set your default provider and model in `agent/settings.json`:

```json
{
  "defaultProvider": "omni",
  "defaultModel": "auto/best-coding",
  "defaultThinkingLevel": "medium"
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
  "maxConcurrent": 8,
  "agentModels": {
    "researcher": "omni/auto/best-reasoning",
    "scout": "omni/auto/best-fast",
    "worker": "omni/auto/best-coding"
  }
}
```

Models override the env-var references in the built-in agent files (`$SCOUT_MODEL` etc.). `.env` is not used — settings are the single source of truth.

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
