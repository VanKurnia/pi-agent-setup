---
name: web-dev
description: General instructions for efficient web development, managing databases, and adaptive Git usage.
---

# Web Development Guidelines

Use this skill to guide your workflow during web development, database inspections, and codebase modifications.

## Workspace Tool Discipline

Always prioritize the specialized workspace extensions over spawning generic bash commands:
1. **File Operations**: Use the `read`, `write`, and `edit` tools. Do not use bash commands (`cat`, `echo`, `sed`) to read or write files.
2. **Web Content**: Use `ninerouter_web_fetch` to retrieve external documentation or inspect remote sources.
3. **Clarifications**: Use `ask_user_question` immediately if a design decision, preference, or missing configuration details are required. Do not guess.

## Adaptive Git Operations (git-toolkit)

1. **Check for Git first**: Before running any Git operations, check if the workspace is a Git repository (e.g., check if a `.git` folder exists or run `git_status`).
2. **Bypass Git if not present**: If the workspace is not initialized as a Git repository, proceed with standard file edits and do not use Git tools.
3. **Use git-toolkit**: If Git is active, use the `git-toolkit` extension tools instead of raw shell commands:
   - Status & Diffs: Use `git_status`, `git_diff_unstaged`, and `git_diff_staged`.
   - Staging & Commits: Stage changes with `git_add` and record them using `git_commit`.
   - Branches & Logs: Navigate using `git_checkout`, `git_create_branch`, `git_branch`, and check history with `git_log` or `git_show`.

## Database Queries (db-viewer)

Query SQLite and MySQL databases exclusively through the read-only `db-viewer` extension.

1. **Discovery**: Look for database credentials inside `.env` or configurations in the workspace. If credentials cannot be resolved, use the `ask_user_question` tool to request them from the user.
2. **Safety**: Make only read-only queries (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `PRAGMA`). Altering state or table structure via write operations is prohibited.
3. **SQLite**:
   - Inspect schema by running `query_sqlite` with `SELECT name, sql FROM sqlite_master WHERE type='table'` or use `PRAGMA table_info(table_name)` for column details.
   - Run safe queries with `query_sqlite`.
4. **MySQL**:
   - Inspect schema by running `query_mysql` with `SHOW TABLES` and `DESCRIBE tablename`.
   - Run queries with `query_mysql`.

## Browser Toolkit (browser-tools)

Automate, scrape, and test web pages through Chrome DevTools Protocol.

1. **Start Chrome**: Call `browser_start` first if Chrome isn't already running on `:9222`. It's idempotent.
2. **Navigate**: Use `browser_nav` to go to a URL (`--new` opens a new tab, otherwise reuses the current one).
3. **Interact & extract**:
   - `browser_eval` — run JavaScript in the page context to read state, trigger clicks, scrape data.
   - `browser_content` — extract readable article content as clean markdown (uses Mozilla Readability).
   - `browser_screenshot` — capture a screenshot for visual verification (use sparingly; prefer `browser_eval` for DOM inspection).
4. **Debug**:
   - `browser_cookies` — inspect session/cookies for auth debugging.
   - `browser_pick` — launch an interactive element picker so the user can click elements on the page; returns CSS selectors.
