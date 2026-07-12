# Obsidian Writer

## When to Use
Creating or updating notes in this vault.

## Setup — Before Writing

### 1. Check Vault Path
Same as Navigator: check `.pi/agent/obsidian-config.json` or `=== Obsidian Vault Context ===` in system prompt.

### 2. Shell Environment
This bash is **MinGW/Git Bash** (Unix-style):
- ✅ `ls`, `find`, `cat`, `grep`
- ❌ Don't use `dir`, `type`, `findstr` (CMD syntax)

### 3. Check Index & Context
- If you know the exact note path, `resolve_pi_url("pi://vault/<path>")` first — fastest check
- Otherwise `ffgrep` — check if note already exists, or find relevant terms
- Read destination folder's Index file — understand context
- If exploration needed, follow Obsidian Navigator protocol first (Level 1→2→3)

### 4. Read Syntax Reference
- Read `reference/styles.md` first for complete OFM syntax (wikilinks, callouts, embeds, tables, task lists, block refs, etc.)
- This doc only covers conventions; refer to styles for exact syntax

## Rules

### Format
- **Title Case with spaces** for file names
- **Frontmatter**: optional for project notes. Format:
  ```
  ---
  created: YYYY-MM-DD
  modified: YYYY-MM-DD
  ---
  ```
  Scratchpad/Ideas skip frontmatter.
- **Headings**: `##` and `###` for structure
- **Tables** for structured data
- **Bullet lists** for points
- **Code blocks** for code/config
- For exact syntax of all OFM elements, see `reference/styles.md`

### Language
- Indonesian → descriptions, audience, purpose, workflows
- English → technical terminology, code concepts, design patterns

### Cross-References
- Use `[[wikilinks]]` — don't use markdown links to local files
- Bottom of page: `## Related\n- [[Note Name]]`
- **Link qualification**: If >1 file matches `[[Name]]`, use full vault-root path. See `reference/link-rules.md`

### Create vs Update
- **New** → write in appropriate folder (Scratchpad/, Projects/{name}/, Ideas/)
- **Update existing** → only if explicitly asked. Don't rewrite without confirmation.
- **Archive** → don't delete. Leave as-is.

### Don't
- Change file naming format (Title Case with spaces)
- Bulk-write to folders without context
- Write outside designated folders

## Voice
- Indonesian: workflows, business rules, user instructions
- English: code concepts, tech terms, design patterns
- No greetings/sign-offs. Bullets > paragraphs. Tables > prose.
- Block refs (^id) when citing specific claims from other notes
