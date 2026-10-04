# smart-web-access

Unified local web access extension for the Pi Coding Agent.

Combines browser-fingerprinted web page fetching (`web_fetch`, `batch_web_fetch`) with DuckDuckGo search (`web_search`).

## Tools Registered

- **`web_search`**: Search the web and return ranked results with snippets and direct links.
- **`web_fetch`**: Fetch a URL using desktop-browser TLS impersonation (via `wreq-js`) and extract clean, readable content (via `Defuddle`).
- **`batch_web_fetch`**: Fetch multiple URLs concurrently with per-item progress in the Pi TUI.

## Performance

All heavy extraction and network dependencies (`wreq-js`, `linkedom`, `defuddle`, `mime-types`, `lodash`) are lazily loaded on first tool execution. Startup overhead is ~20ms.
