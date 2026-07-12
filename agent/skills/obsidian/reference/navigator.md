# Obsidian Navigator

## When to Use
Need vault context — memories, references, project info.

## Setup — Before Navigation

### 0. Check System Prompt
Vault context may already be injected in system prompt (look for `=== Obsidian Vault Context ===`).
If present: use it as your map — `read` the files mentioned. Don't search externally.

### 1. Detect Vault Path
- Check `.pi/agent/obsidian-config.json` — read `vaultPath`
- If missing: search `~/Documents/Obsidian Vault/` or ask user via `/obsidian-path`

### 2. Shell Environment
This bash is **MinGW/Git Bash** (Unix-style):
- ✅ `ls`, `find`, `cat`, `grep`
- ❌ Don't use `dir`, `type`, `findstr` (CMD syntax)

## Protocol: Progressive Disclosure
### Level 0: Check agent memory, then vault
1. **`memory_recall`** with key terms from the question — agent memory stores prior-session decisions, user preferences, project-specific context, and architectural facts. This is higher signal/noise than full vault grep. Start here.
2. If `memory_recall` returns nothing or is insufficient, `ffgrep` vault for the same terms (smart-case, ranked by frecency)
3. If ffgrep returns <3 results or the top result is weak, `ffind` the same terms (fuzzy path search catches differently-named files)
4. If still nothing, try `ffgrep` with Indonesian/English synonyms of key terms (e.g., "data model" → "skema", "schema", "model data")
5. If context exists → read top 1-2 matches, answer from vault
6. If none: "No prior context" → answer fresh

### Quick Access: pi:// URLs
For known paths, use `resolve_pi_url` tool:

| Protocol | Example | Use case |
|----------|---------|----------|
| `pi://vault/<path>` | `pi://vault/Projects/HRIS/Index HRIS` | Read vault note with [[wikilinks]] resolved |
| `pi://skill/<name>` | `pi://skill/orchestrator` | Read a skill's complete SKILL.md |
| `pi://skill/<name>/reference/<doc>` | `pi://skill/obsidian/reference/navigator` | Read a skill reference doc |
| `pi://workspace/` | `pi://workspace/` | Workspace info (git status, files, branch) |
| `pi://workspace/git` | `pi://workspace/git` | Detailed git status |
| `pi://workspace/files` | `pi://workspace/files` | File listing (depth ≤ 2) |
| `pi://health` | `pi://health` | Health check (vault, workspace, branch) |
| `pi://db/` | `pi://db/` | List database tables |
| `pi://db/<table>` | `pi://db/users` | Query table (first 20 rows) |
| `pi://db/<table>/schema` | `pi://db/users/schema` | Describe table schema |

**Use `pi://vault/` when you know the exact note path** — faster than ffgrep and resolves [[wikilinks]] automatically. Use `pi://skill/` to read any skill's full content without navigating the filesystem.

| Method | When |
|--------|------|
| `ffgrep` | Searching by keyword, don't know exact path |
| `pi://vault/<path>` | You know the note name, want wikilinks resolved |
| `read` | Quick peek, don't need wikilink resolution |

### Query tips
- Strip stop words: "What is the MHI data model" → "MHI data model"
- Try folder path as query: "HRIS MHI schema" hits more than "MHI data model"
- For proper nouns, try the Indonesian term if English yields nothing

1. **Level 1**: Read relevant folder's Index file (get the map)
2. **Level 2**: From Index, pick 1-2 notes to read (get content)
3. **Level 3**: Follow `[[wikilinks]]` in read notes (get graph context)

Don't skip Level 1-2. Don't bulk read.

## Search Strategy
- **Level 0 handles retrieval** — see protocol above for the ffgrep → fffind → synonym chain
- For full context after finding matches, `read` the files
- Prioritize Index files as entry point over direct file search

## Token Budget
- Inject max ~500 tokens from vault context into system prompt
- Priority order: active project → relevant Index

## Memory Facts Location
- `_agent/memory/` → **agent memory** — `memory_recall` reads this, `memory_write` appends to it. Per-project `.md` files + `global.md` for cross-project facts.
- `Projects/{name}/` → per-project vault context (architecture, tech stack, decisions)
- `Ideas/` → brainstorming ideas (read-only, don't write here)
- `Scratchpad/` → working notes (agent may write here)
