---
name: browser-tools
description: Browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, extract dynamic content, or visually verify UI.
---

# Browser Tools — Usage Guide

Uses the browser-tools extension (custom pi tools). Chrome must be running on `:9222`.

## First Use

```bash
# Start Chrome with remote debugging
/browser
```

The extension will auto-detect your Chrome install and start it with a fresh profile.

## Available Tools

| Tool | Purpose |
|---|---|
| `browser_start` | Start/connect to Chrome on :9222 |
| `browser_nav` | Navigate to a URL (current or new tab) |
| `browser_eval` | Execute JavaScript in the active page |
| `browser_screenshot` | Capture screenshot to temp file |
| `browser_content` | Extract readable content as markdown |
| `browser_cookies` | List cookies for current page |
| `browser_pick` | Interactive element picker (user clicks elements) |

## When to Use

- **Testing frontend code** in a real browser
- **Interacting with JS-heavy pages** that won't render statically
- **Extracting dynamic content** — use `browser_content` for articles, `browser_eval` for structured data
- **Visual verification** — use `browser_screenshot` sparingly, prefer `browser_eval` for DOM inspection
- **Debugging auth issues** — use `browser_cookies`

## Efficiency Tips

**Prefer DOM inspection over screenshots:**
```
browser_eval: code = "document.title"
browser_eval: code = "JSON.stringify({links: document.querySelectorAll('a').length, forms: document.forms.length})"
```

**Batch interactions in one eval call:**
```
browser_eval: code = "(function() { document.querySelector('button').click(); return 'clicked'; })()"
```

**Wait between actions:**
Use `sleep 0.5` between browser_eval calls if the page needs time to update.

**Investigate first:**
Always get page structure before complex interactions.
