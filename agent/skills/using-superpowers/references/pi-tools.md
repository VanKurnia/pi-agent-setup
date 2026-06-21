# Pi Tool Mapping — Concrete Reference

Skills speak in actions ("dispatch a subagent", "find the file", "run the tests"). On Pi, these resolve to the tools below.

Use this reference when a skill tells you to perform an action — look up the exact pi tool name.

---

## File Operations

| Skill says | Pi tool |
|---|---|
| Read a file | `read <path>` |
| Create / overwrite a file | `write <path>` |
| Edit a file (precise text replacement) | `edit` with `edits[{oldText, newText}]` |
| Search file contents | `bash` with `rg` / `grep` |
| Find files by name | `bash` with `find` / `ls` |
| List directory contents | `bash` with `ls` |
| Show git status | `git_status` |
| Show unstaged diff | `git_diff_unstaged` |
| Show staged diff | `git_diff_staged` |
| Show diff between branches | `git_diff` |
| Show commit log | `git_log` |
| Stage files | `git_add` |
| Commit | `git_commit` |
| Create branch | `git_create_branch` |
| Checkout branch | `git_checkout` |
| Show commit contents | `git_show` |
| List branches | `git_branch` |
| Unstage changes | `git_reset` |

---

## Shell

| Skill says | Pi tool |
|---|---|
| Run any shell command | `bash <command>` |
| Install npm packages | `bash` with `cd <dir> && npm install` |
| Run tests | `bash` with project test command |
| Run git commands | `bash` with `git <args>` |

---

## Web & Search

| Skill says | Pi tool |
|---|---|
| Search the web | `ninerouter_web_search` with query parameters |
| Fetch/extract a URL | `ninerouter_web_fetch` with URL |
| Check 9router status | `ninerouter_status` |

---

## Browser Automation (from browser-tools extension)

| Skill says | Pi tool |
|---|---|
| Start/connect Chrome | `browser_start` |
| Navigate to URL | `browser_nav` with `url` (optional `newTab: true`) |
| Execute JavaScript in page | `browser_eval` with `code` |
| Take screenshot | `browser_screenshot` (optional `description`) |
| Extract page as markdown | `browser_content` with `url` |
| List cookies | `browser_cookies` |
| Interactive element picker | `browser_pick` with `message` |

---

## Database (from db-viewer extension)

| Skill says | Pi tool |
|---|---|
| Query SQLite | `query_sqlite` with `dbPath` and `query` |
| Query MySQL | `query_mysql` with `connectionString` and `query` |

---

## Subagents

Pi provides a built-in `subagent` tool.

| Pattern | How to use |
|---|---|
| Single subagent | `subagent({ agent: "<name>", task: "..." })` |
| Parallel subagents | `subagent({ tasks: [{ agent, task }, { agent, task }, ...] })` |
| Check subagent availability | `subagent({ action: "doctor" })` |

**Available agents:**

| Name | Role | Tools |
|---|---|---|
| `scout` | Explore codebase, understand patterns, find files | `read`, `grep`, `find`, `ls`, git tools |
| `researcher` | Look up API docs, external knowledge, web searches | `ninerouter_web_search`, `ninerouter_web_fetch` |
| `worker` | Isolated code changes, implementing, reviewing | `read`, `write`, `edit`, `safe_bash`, git tools |

| Task | Dispatch as |
|---|---|
| Codebase exploration | `subagent({ agent: "scout", task: "..." })` |
| Web research | `subagent({ agent: "researcher", task: "..." })` |
| Code implementation | `subagent({ agent: "worker", task: "..." })` |
| Code review | `subagent({ agent: "worker", task: "..." })` |
| Applying review fixes | `subagent({ agent: "worker", task: "..." })` |
| Plan execution per task | `subagent({ agent: "worker", task: "..." })` |

**Always include ALL necessary context in the task description** — subagents have no access to your conversation history.

**For code review:** dispatch a `worker` subagent using the code-reviewer prompt template. Pass the diff as a file path, not inline text.

---

## User Interaction

| Skill says | Pi tool |
|---|---|
| Ask a clarifying question | `ask_user_question` with `question` (one per call) |
| Present multiple options | Use `ask_user_question` with `options[]` array and optional `multiSelect` |

---

## Skill Activation

Pi does not have a `Skill` tool like Claude Code. Instead:

- Pi scans skill directories at startup and loads all skill descriptions
- When a skill applies, **read its SKILL.md file** with `read <path>` and follow the instructions
- You can also use `/skill:<name>` commands in interactive mode
- The `using-superpowers` SKILL.md is always available — follow its rules

---

## Task / Todo Tracking

Pi does not ship a built-in task-list tool. Track tasks using:

- Plan files (`.superpowers/plans/...`) with markdown checklists
- A `.superpowers/tasks.md` file in the repo
- Inline progress tracking in your implementation notes

---

## Example: Orchestrator-Style Tool Usage

```text
# Instead of: "Dispatch a subagent to explore the codebase"
# Use:
subagent({ agent: "scout", task: "Explore how auth middleware works in src/middleware/ — list files, patterns, and dependencies. Tools: read, grep, find, ls." })

# Instead of: "Search the web for React 19 migration guide"
# Use:
ninerouter_web_search({ query: "React 19 migration guide", max_results: 5 })

# Instead of: "Run the tests"
# Use:
bash("npm test")

# Instead of: "Ask the user which approach they prefer"
# Use:
ask_user_question({ question: "Which approach do you prefer?", options: [...] })
```
