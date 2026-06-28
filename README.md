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
bash update.sh
```

Then create `agent/auth.json` — run `/login` inside pi to set up your provider.

### Upgrading an existing setup

```bash
mv ~/.pi ~/.pi.backup
git clone https://github.com/VanKurnia/pi-agent-setup.git ~/.pi
cd ~/.pi

# Restore custom settings (models, auth, .env)
cp ~/.pi.backup/agent/models.json ~/.pi/agent/ 2>/dev/null || true
cp ~/.pi.backup/agent/auth.json ~/.pi/agent/    2>/dev/null || true
cp ~/.pi.backup/.env ~/.pi/                      2>/dev/null || true

bash update.sh
```

### Post-install

- **`.env`** — `cp .env.example .env` then edit to configure subagent models
- **`/login`** — authenticate with your provider (API key or subscription)
- **Nerd Font** — required for icons in the TUI. Without one, you'll see garbled characters in menus and dialogs. [Download here](https://www.nerdfonts.com/font-downloads).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `bash` not found | Install [Git for Windows](https://git-scm.com/download/win). Pi auto-detects Git Bash. |
| Extension not loading | Run `bash update.sh` to reinstall deps. Check `agent/auth.json` exists. |
| Icons look broken | Install a Nerd Font and set it as your terminal font. |
| `update.sh` fails | Run in Git Bash, not cmd/PowerShell. The `~` path doesn't expand in Windows shells. |

## What's Included

### Extensions

| Extension | Description |
|-----------|-------------|
| `bash-guard` | Safeguards bash commands — validates before execution |
| `browser-tools` | Chrome DevTools automation (puppeteer, Readability, jsdom) |
| `db-viewer` | Secure read-only SQLite/MySQL viewer |
| `filechanges` | Tracks diffs across edits |
| `subagents` | Subagent orchestration for delegating tasks |
| `plan-mode` | Step-by-step plan authoring and tracking |
| `handoff` | Model-switch briefs for /compact |
| `update-setup` | Runs `update.sh` inside pi with live output widget |
| `ask-user-question` | Interactive Q&A dialog |
| `context` | Token usage grid overlay (`/context`) |
| `custom-header` | Customizable startup header |
| `git-toolkit` | Git status, diff, log, commit, branch |
| `md-link` | Collaborative `.md` editing (`/link-md`, `/send-diff`) |
| `plan-artifact` | Browser UI for `.plans/` markdown with commenting and syntax highlighting |
| `zz-read-only-mode` | Toggle read-only (`/read-only`) |

### External Packages

| Package | Description |
|---------|-------------|
| `@ff-labs/pi-fff` | Fuzzy file finder (`fffind`) and content grep (`ffgrep`) |
| `pi-9router-ext` | Web search and URL content extraction |
| `pi-x-ide` | VS Code / IDE integration |
| `pi-zentui` | Extended TUI components |

### Skills

| Skill | Description |
|-------|-------------|
| `grill-me` | Stress-test plans through relentless questioning |
| `improve` | Read-only codebase audit with prioritized implementation plans |
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
  "defaultProvider": "9router",
  "defaultModel": "versatile",
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

### Subagent Models (`.env`)

Configure which models subagents use:

```env
RESEARCHER_MODEL=reason
SCOUT_MODEL=assistant
WORKER_MODEL=coder

SUBAGENTS_MAX_CONCURRENCY=8
PI_FFF_MODE=override
```

Copy `.env.example` to `.env` and edit.

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
