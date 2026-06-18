# Pi Config

Personal configuration for `pi` (the terminal AI coding assistant).

This setup is inspired by the minimal setup of [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config).

## What's Included

- **Extensions**: Custom extensions inside `extensions/` (e.g., custom header, bash guards, file change watchers, subagents, db-viewer, and git-toolkit).
- **Automation**: An `update.sh` script to install top-level extensions automatically and run `npm install` for internal dependencies.

## Quick Setup

To configure this environment on your local machine, run:

```bash
# Clone the repository directly to your user folder
git clone https://github.com/VanKurnia/pi-agent-setup.git ~/.pi
cd ~/.pi

# Initialize extensions and dependencies
bash update.sh
```

## Custom Models

To configure custom endpoints or local models (like Ollama, LM Studio, or custom proxy models), create a `models.json` file inside `agent/`:

```bash
touch agent/models.json
```

Refer to the official documentation on [Custom Models](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/models.md) for how to set up provider base URLs, keys, and model lists.

## Installation and Updates

Run the update script to install the extensions and configure dependencies:

```bash
bash update.sh
```
