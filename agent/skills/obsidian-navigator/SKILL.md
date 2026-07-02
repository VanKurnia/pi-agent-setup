---
name: obsidian-navigator
description: Provides a progressive-disclosure protocol for reading vault context — start with Index files, drill via wikilinks, use ffgrep for search. Enforces token budget (~500 token injection ceiling). Use when the agent needs to find references, project info, or prior session memory.
---

# Obsidian Navigator

## When to Use
Need vault context — memories, references, project info.

## Setup — Before Navigation

### 0. Check System Prompt
Vault context may already be injected in system prompt (look for `=== Obsidian Vault Context ===`).
If present: use it as your map — `read` the files mentioned. Don't search externally.

### 1. Detect Vault Path
- Check `.pi/obsidian-config.json` — read `vaultPath`
- If missing: search `~/Documents/Obsidian Vault/` or ask user via `/obsidian-path`

### 2. Shell Environment
This bash is **MinGW/Git Bash** (Unix-style):
- ✅ `ls`, `find`, `cat`, `grep`
- ❌ Don't use `dir`, `type`, `findstr` (CMD syntax)

## Protocol: Progressive Disclosure
1. **Level 1**: Read relevant folder's Index file (get the map)
2. **Level 2**: From Index, pick 1-2 notes to read (get content)
3. **Level 3**: Follow `[[wikilinks]]` in read notes (get graph context)

Don't skip Level 1-2. Don't bulk read.

## Search Strategy
- **Priority 1**: `ffgrep` for keyword search (fast, no full file reads)
- **Priority 2**: If `ffgrep` returns thin results, fallback to `bash find <vaultPath> -name "*.md" | xargs grep -l <pattern>`
- If `ffind` errors / not found — don't loop, fallback to priority 1 or 2
- For full context, `read` matched files
- Prioritize Index files as entry point — not direct search

## Token Budget
- Inject max ~500 tokens from vault context into system prompt
- Priority order: active project → recent log entries → relevant Index
- `.log/log.md` — read only last 5 entries for session context

## Memory Facts Location
- `.log/log.md` → session history, decisions, open items
- `Projects/{name}/` → per-project context (architecture, tech stack, decisions)
- `Ideas/` → brainstorming ideas (read-only, don't write here)
- `Scratchpad/` → working notes (agent may write here)
