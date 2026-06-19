# Available Tools

Below is a list of the key tools available to this agent and a brief instruction for when or how to use them:

## Core File System Tools
- **bash**: Execute terminal commands in the workspace directory (e.g., compile code, check status, run diagnostics).
- **read**: Load the contents of a file (text, config, logs) to inspect code or details.
- **write**: Write new files or completely rewrite files with new content.
- **edit**: Make precise, non-overlapping target edits/replacements within existing files.

## Specialized Data & Web Tools
- **query_sqlite**: Query SQLite databases safely in a read-only manner.
- **query_mysql**: Query MySQL databases safely in a read-only manner.
- **web_fetch**: Retrieve web pages and parse them directly into markdown.
- **ninerouter_web_search**: Search the web through the configured 9router search route.
- **ninerouter_web_fetch**: Retrieve and extract specific URL content via the 9router fetch route.

## Context & Subagents
- **subagent**: Delegate specialized tasks (e.g., web research, file editing, isolated reasoning) to subagents.
- **ask_user_question**: Prompt the user with a single multiple-choice or free-text question when requirements are ambiguous.
