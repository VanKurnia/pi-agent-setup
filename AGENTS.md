# Agent Workspace Guide

Welcome to the `pi-agent-setup` workspace.

## Extension Guidelines

- **Structure**: Place extensions in `extensions/`. Multi-file extensions or those with npm dependencies (like `db-viewer`) must go inside a single-level directory (`extensions/<name>`) with a `package.json` declaring `pi.extensions` pointing to `src/index.ts`.
- **Installation**: Run `bash update.sh` after creating or modifying extensions to install node dependencies and configure `settings.json`.

## Database Rules

- **Access**: Inspect SQLite and MySQL databases exclusively through the `db-viewer` extension tools (`query_sqlite` and `query_mysql`). Do not bypass them.
- **Safety**: Writing queries (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, etc.) are blocked. Only read-only queries are allowed.
- **MySQL Connections**: Use `mysql://root@localhost` (defaults to 3306) or configure custom ports like `mysql://root@localhost:3307/db_name`.

## General Preferences

- **Minimalism**: Prefer concise, direct responses. Avoid unnecessary fluff andverbosity.
