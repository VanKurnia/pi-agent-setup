# Pi Config

Personal configuration for `pi` (the terminal AI coding assistant).

This setup is inspired by the minimal setup of [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config).

## Quick Setup

To configure this environment on your local machine:

### If `~/.pi` does not exist or is empty :
Clone the repository directly into your `~/.pi` directory:

```bash
git clone https://github.com/VanKurnia/pi-agent-setup.git ~/.pi
cd ~/.pi
bash update.sh
```

### If `~/.pi` already exists and is not empty :
If you already have a `~/.pi` directory with existing configurations, run these commands to safely backup and set up:

```bash
# 1. Backup your existing config
mv ~/.pi ~/.pi.backup

# 2. Clone this repository to ~/.pi
git clone https://github.com/VanKurnia/pi-agent-setup.git ~/.pi
cd ~/.pi

# 3. (Optional) Restore any custom settings (e.g. models.json) from backup
if [ -f ~/.pi.backup/agent/models.json ]; then
  cp ~/.pi.backup/agent/models.json ~/.pi/agent/
fi

# 4. Initialize extensions and dependencies
bash update.sh
```

## Custom Models

To configure custom endpoints or local models (like Ollama, LM Studio, or custom proxy models), create a `models.json` file inside `agent/` using this template:

```jsonc
// agent/models.json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.2" },
        { "id": "deepseek-coder:6.7b" },
        { "id": "qwen2.5-coder:7b" }
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

Refer to the official documentation on [Custom Models](https://pi.dev/docs/latest/models) for details on provider base URLs, keys, and model lists.

## Installation and Updates

Run the update script to install the extensions and configure dependencies:

```bash
bash update.sh
```
## Font Recommendations

Install a **Nerd Font** for proper icon rendering of TUI elements. Download from [Here](https://www.nerdfonts.com/font-downloads)

After installing the font, set it as the terminal font family in VS Code (`terminal.integrated.fontFamily`) and/or your terminal emulator settings.

## Shell Configuration (Windows)

On Windows, configure the integrated terminal shell path in `settings.json` to use a POSIX-compatible shell (e.g., Git Bash, Cygwin, WSL):

```jsonc
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

## Inventory

### Extensions

| Extension | Description | Source |
|-----------|-------------|--------|
| `bash-guard` | Safeguards bash commands — validates and sanitises before execution | `extensions/bash-guard/` |
| `browser-tools` | Chrome DevTools Protocol browser automation (puppeteer, Readability, jsdom, Turndown) | `extensions/browser-tools/` |
| `db-viewer` | Secure read-only viewer for SQLite and MySQL databases | `extensions/db-viewer/` |
| `filechanges` | Tracks file diffs and changes across edits | `extensions/filechanges/` |
| `subagents` | Subagent orchestration for delegating sub-tasks | `extensions/subagents/` |
| `ask-user-question.ts` | Interactive question/answer dialog for clarifying requirements | `extensions/ask-user-question.ts` |
| `context.ts` | Visualises context/token usage as a coloured grid overlay (`/context`) | `extensions/context.ts` |
| `custom-header.ts` | Customisable startup header (edit the file and `/reload`) | `extensions/custom-header.ts` |
| `git-toolkit.ts` | Git operations: status, diff, log, branch, commit, add, etc. | `extensions/git-toolkit.ts` |
| `md-link.ts` | Link `.md` files for collaborative editing (`/link-md`, `/send-diff`) | `extensions/md-link.ts` |
| `update-setup.ts` | Auto-discovers bash paths on Windows, runs `update.sh` setup logic | `extensions/update-setup.ts` |
| `zz-read-only-mode.ts` | Toggle read-only mode (`/read-only`) to prevent accidental edits | `extensions/zz-read-only-mode.ts` |

### External Packages

| Package | Description |
|---------|-------------|
| `@ff-labs/pi-fff` | Fuzzy file finder (`fffind`) and content grep (`ffgrep`) tools |
| `pi-9router-ext` | Web search and fetch integration via 9router |
| `pi-zentui` | TUI (terminal UI) components for pi |

### Skills

| Skill | Description |
|-------|-------------|
| `grill-me` | Interview the user relentlessly about a plan or design until reaching shared understanding |
| `improve` | Survey any codebase as a senior advisor and produce prioritised implementation plans (read-only) |
| `orchestrator` | Top-level session orchestration rules — subagent routing, context hygiene, implementation discipline |
| `stop-slop` | Remove AI writing patterns from prose |

### Dev Dependencies

| Package | Version |
|---------|---------|
| `@earendil-works/pi-ai` | ^0.79.10 |
| `@earendil-works/pi-coding-agent` | ^0.79.10 |
| `@earendil-works/pi-tui` | ^0.79.10 |
| `@types/node` | ^22.0.0 |
| `typescript` | ^5.7.0 |
| `vitest` | ^4.1.9 |