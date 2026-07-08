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
### Level 0: Check memory first
1. `ffgrep` vault for key terms from the question (smart-case, ranked by frecency)
2. If ffgrep returns <3 results or the top result is weak, `ffind` the same terms (fuzzy path search catches differently-named files)
3. If still nothing, try `ffgrep` with Indonesian/English synonyms of key terms (e.g., "data model" → "skema", "schema", "model data")
4. If context exists → read top 1-2 matches, answer from vault
5. If none: "No prior context" → answer fresh

### Quick Access: pi://vault
For known note paths, use `resolve_pi_url` tool:
- `pi://vault/Projects/HRIS/Index HRIS` — reads note + resolves [[wikilinks]]
- Faster than ffgrep when you know the exact path

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
- `Projects/{name}/` → per-project context (architecture, tech stack, decisions)
- `Ideas/` → brainstorming ideas (read-only, don't write here)
- `Scratchpad/` → working notes (agent may write here)
