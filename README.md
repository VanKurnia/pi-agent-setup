# Pi Config

Personal configuration for `pi` (the terminal AI coding assistant).

This setup is inspired by the minimal setup of [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config).

## What's Included

- **Extensions**: Custom extensions inside `extensions/` — custom header, bash guards, file change watchers, subagents, db-viewer, git-toolkit, context helpers, markdown link helpers, read-only mode, and update setup.
- **Skills**: Agent skills under `agent/skills/` — orchestrator (session orchestration), stop-slop (remove AI writing patterns), web-dev (web development workflows).
- **Zentui Config**: Terminal UI configuration in `agent/zentui.json`.
- **Automation**: An `update.sh` script to install top-level extensions automatically and run `npm install` for internal dependencies.

## Quick Setup

To configure this environment on your local machine:

### Option A: If `~/.pi` does not exist or is empty
Clone the repository directly into your `~/.pi` directory:

```bash
git clone https://github.com/VanKurnia/pi-agent-setup.git ~/.pi
cd ~/.pi
bash update.sh
```

### Option B: If `~/.pi` already exists and is not empty
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
