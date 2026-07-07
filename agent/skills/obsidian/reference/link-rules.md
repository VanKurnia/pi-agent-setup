# Vault Link Rules

## Problem
Multiple projects share identical filenames (e.g. `Architecture Overview.md`, `Config System.md`, `Database Schema Overview.md`). Bare `[[Database Schema Overview]]` or even `[[Database/Database Schema Overview]]` resolves non-deterministically — Obsidian finds both `Projects/HRIS/MHI/System Design/Database/Database Schema Overview.md` and `Projects/Recruitment/System Design/Database/Database Schema Overview.md` because both end with the same path suffix.

## Rule

### When to qualify
If **more than one file** in the vault matches the link's path suffix, you must use the full vault-root path.

### How to qualify
Replace:
```
[[Config System]]
# or
[[Architecture/Config System|Config System]]
```
With:
```
[[Projects/HRIS/MHI/System Design/Architecture/Config System|Config System]]
```

### How to detect
Before writing any `[[Wikilink]]` that includes a path prefix, run:
```bash
find . -path "*{path}/{name}.md" | wc -l
```
If count > 1, qualify with the full `Projects/{Project Folder}/{...}` path.

For a fast scan of ALL shared filenames across project folders:
```bash
find "Projects/HRIS" -name "*.md" -exec basename {} \; | sort -u > /tmp/a
find "Projects/Recruitment" -name "*.md" -exec basename {} \; | sort -u > /tmp/b
comm -12 /tmp/a /tmp/b
```

### When reading existing wikilinks
If you see a bare `[[Name]]` or a short-path `[[Folder/Name]]` and `Name.md` exists in multiple projects, **do not** assume it resolves correctly. Flag it — the user's Obsidian may have resolved to the wrong file.

### Accepted patterns
- `[[Projects/HRIS/MHI/System Design/Architecture/Config System|Config System]]` ✓
- `[[Projects/HRIS/MHI/System Design/Architecture/Config System#anchor|Config System#anchor]]` ✓ (anchors preserved)
- `[[Projects/Recruitment/System Design/Database/Database Schema Overview|Database Schema Overview]]` ✓

### Not accepted (ambiguous)
- `[[Config System]]` ✗ — two files match
- `[[Database/Database Schema Overview]]` ✗ — two files match (same path suffix)
- `[[Architecture/Config System|Config System]]` ✗ — regardless of current file's location, the path suffix is ambiguous

### Exception
Links within the **same file** (e.g. a note linking to a heading inside itself) don't need qualification. `[[#section]]` is fine.
