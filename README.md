# Pi Config

Personal configuration for `pi` (the terminal AI coding assistant).

This setup is inspired by the minimal setup of [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config).

## What's Included

- **Extensions**: Custom extensions inside `extensions/` (e.g., custom header, bash guards, file change watchers, subagents, db-viewer, and git-toolkit).
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

To configure custom endpoints or local models (like Ollama, LM Studio, or custom proxy models), create a `models.json` file inside `agent/`:

```bash
touch agent/models.json
```

Refer to the official documentation on [Custom Models](https://pi.dev/docs/latest/models) for how to set up provider base URLs, keys, and model lists.

## Installation and Updates

Run the update script to install the extensions and configure dependencies:

```bash
bash update.sh
```
