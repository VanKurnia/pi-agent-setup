# Agent Workspace Guide

Welcome to the `pi-agent-setup` workspace.

## Installation

To ensure a clean installation and avoid conflicts, please follow these steps carefully:

1.  **Start Fresh**: If you have an existing `$HOME/.pi` directory from a previous installation, it's best to back up any important files and then remove it. This prevents potential file conflicts. You can usually remove it with `rm -rf $HOME/.pi`.

2.  **Run the Setup Script**: From the original `pi-agent-setup` directory, run the `update.sh` script. This will correctly set up your workspace at `$HOME/.pi`, move all necessary files, and install the required extensions and dependencies.

    ```bash
    bash update.sh
    ```

Following this process will ensure your workspace is configured correctly.

## Extension Guidelines

- **Structure**: Place extensions in `extensions/`. Multi-file extensions or those with npm dependencies (like `db-viewer`) must go inside a single-level directory (`extensions/<name>`) with a `package.json` declaring `pi.extensions` pointing to `src/index.ts`.
- **Installation**: Run `bash update.sh` after creating or modifying extensions to install node dependencies and configure `settings.json`.

## Database Rules

- **Access**: Inspect SQLite and MySQL databases exclusively through the `db-viewer` extension tools (`query_sqlite` and `query_mysql`). Do not bypass them.
- **Safety**: Writing queries (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, etc.) are blocked. Only read-only queries are allowed.
- **MySQL Connections**: Use `mysql://root@localhost` (defaults to 3306) or configure custom ports like `mysql://root@localhost:3307/db_name`.

## General Preferences

- **Minimalism**: Prefer concise, direct responses. Avoid unnecessary fluff andverbosity.
