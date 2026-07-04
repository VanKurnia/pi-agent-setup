---
description: Scan vault for structural issues — orphans, stale scratchpad, broken wikilinks, missing Index entries.
---
Check the vault for structural issues. For each category, list findings:

1. **Orphan notes** — .md files with no inbound [[wikilinks]] from any Index file. Use `bash find` + `ffgrep` to detect.
2. **Stale Scratchpad** — notes in Scratchpad/ older than 2 weeks that describe implemented work (should be in Projects/).
3. **Missing Index entries** — folders with .md files but no corresponding entry in their Index.
4. **Broken [[wikilinks]]** — links to notes that don't exist (ffgrep for `[[.*]]` patterns, cross-reference with actual files).

Output grouped by category. Do not move or edit anything — just report.
