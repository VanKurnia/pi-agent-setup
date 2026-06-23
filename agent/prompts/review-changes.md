---
description: Review all uncommitted/staged changes via git_diff, inspecting every diff hunk for correctness, edge cases, and unintended side effects.
---

Utilize git_diff to obtain context of all uncommitted (unstaged + staged) changes.
Review every hunk systematically:

1. **Correctness** — Does the logic handle normal paths, empty states, and error cases?
2. **Edge cases** — Any off-by-one, null/undefined, race conditions, or type mismatches?
3. **Side effects** — Could this break callers, leak resources, or violate invariants?
4. **Consistency** — Does it match surrounding code style, conventions, and patterns?

Be thorough. Flag any concern, even minor ones. If all looks solid, confirm explicitly.