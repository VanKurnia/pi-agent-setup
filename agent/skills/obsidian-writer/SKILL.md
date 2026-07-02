---
name: obsidian-writer
description: Guides the agent in writing and updating Obsidian notes following vault conventions — Title Case with spaces, no frontmatter, wikilinks-only cross-references, bilingual ID/EN, folder-based organization. Use when the agent needs to create or edit a note in the vault.
---

# Obsidian Writer

## When to Use
Creating or updating notes in this vault.

## Setup — Before Writing

### 1. Check Vault Path
Same as Navigator: check `.pi/obsidian-config.json` or `=== Obsidian Vault Context ===` in system prompt.

### 2. Shell Environment
This bash is **MinGW/Git Bash** (Unix-style):
- ✅ `ls`, `find`, `cat`, `grep`
- ❌ Don't use `dir`, `type`, `findstr` (CMD syntax)

### 3. Check Index & Context
- `ffgrep` first — check if note already exists
- Read destination folder's Index file — understand context
- If exploration needed, follow Obsidian Navigator protocol first (Level 1→2→3)

### 4. Read Syntax Reference
- Read [obsidian-styles/SKILL.md](../obsidian-styles/SKILL.md) first for complete OFM syntax (wikilinks, callouts, embeds, tables, task lists, block refs, etc.)
- This skill only covers conventions; refer to styles for exact syntax

## Rules

### Format
- **Title Case with spaces** for file names
- **No frontmatter** — content starts from line 1
- **Headings**: `##` and `###` for structure
- **Tables** for structured data
- **Bullet lists** for points
- **Code blocks** for code/config
- For exact syntax of all OFM elements, see [obsidian-styles/SKILL.md](../obsidian-styles/SKILL.md)

### Language
- Indonesian → descriptions, audience, purpose, workflows
- English → technical terminology, code concepts, design patterns

### Cross-References
- Use `[[wikilinks]]` — don't use markdown links to local files
- Bottom of page: `## Related\n- [[Note Name]]`

### Create vs Update
- **New** → write in appropriate folder (Scratchpad/, Projects/{name}/, Ideas/)
- **Update existing** → only if explicitly asked. Don't rewrite without confirmation.
- **Archive** → don't delete. Leave as-is.

### Don't
- Add frontmatter (this vault doesn't use it)
- Change file naming format (Title Case with spaces)
- Bulk-write to folders without context
- Write outside designated folders
