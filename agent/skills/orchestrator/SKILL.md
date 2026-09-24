---
name: orchestrator
description: Default session rules governing tool choice (subagent vs direct tools), context-window budgeting, implementation workflow, and output discipline. Load this as the session baseline — it tells you when to delegate to worker vs. work directly, how to explore without blowing your context, how to investigate before fixing, and how to verify before claiming done. Referenced by most other skills as the top-level orchestrator.
---

# Session Orchestration

## When This Applies

This skill is the **default session governor** — it applies to every turn, not just specific situations. Load it whenever you:

- **Start a new task** — sets the baseline workflow: investigate → verify → implement → prove
- **Decide between subagent vs. direct tool** — tells you when to delegate (worker) vs. when to just edit the file yourself
- **Worry about context limits** — gives you the discipline to explore with targeted calls and verify at known file:line instead of reading whole files
- **Fix a bug** — prescribes observe → hypothesize → verify → fix, not guess-and-pray
- **Claim something is done** — requires a concrete verification command and its output
- **Write output** — keeps it concise, no fluff, run stop-slop on anything over 2 sentences
- **Get asked to /improve or /grill-me** — those skills reference this one as the top-level orchestrator

In short: if you're executing a user request in a codebase, this skill applies.

## Understand Before You Build

THE MOST IMPORTANT THING: YOU DON'T ASSUME, YOU VERIFY - YOU GROUND YOUR COMMUNICATION TO THE USER IN EVIDENCE-BASED FACTS  
DON'T JUST RELY ON WHAT YOU KNOW. YOU FOLLOW YOUR KNOWLEDGE BUT ALWAYS CHECK YOUR WORK AND YOUR ASSUMPTIONS TO BACK IT UP WITH HARD, UP-TO-DATE DATA THAT YOU LOOKED UP YOURSELF

Never start implementing until you are **100% certain** of what needs to be done. If you catch yourself thinking "I think this is how it works" or "this should probably be..." — STOP. That's a signal to ask or investigate, not to start coding.

**Fill knowledge gaps with:**
- **`ask_user_question`** — ambiguous requirements, preference between approaches, any detail that would materially change the implementation. One question per call. Never guess what the user wants.
- **`resolve_pi_url`** — read skill docs (`pi://skill/<name>`), workspace state (`pi://workspace/`, `pi://workspace/git`), project databases (`pi://db/`), or health check (`pi://health`). Use when you know the exact path — faster than ff-search/grep.
- **`search_graph`** — First tool for code discovery. Use before grep.
  Query modes: BM25 natural language, name regex, and semantic (vector) search.
- **`search_code`** — Literal text/regex search with graph enrichment (deduplicates
  by function boundary, ranks by structural importance). Use for config keys,
  env vars, route strings, error messages, or when search_graph returns nothing.
- **`read_symbol` / `resolve_symbol`** — Read source from a symbol name.
  resolve_symbol first to find the qualified_name if ambiguous (returns candidates
  without guessing). Then read_symbol to read the source.
- **`get_code_snippet`** — Read source from an exact qualified_name. More efficient
  than reading the whole file. Set `include_neighbors=true` for callers/callees.
- **`trace_path`** — Use instead of grep for callers/callees/impact analysis.
  Supports multi-hop tracing, data-flow mode, and cross-service traces.
- **`get_architecture`** — Structural orientation at the start of a project:
  hotspots, entry points, packages, layers, dependencies.
- **`detect_changes`** — Blast radius analysis before commit or before starting
  work. Shows changed files + transitive impact set (callers of changed symbols).

**CBM override rule:** For code files, use CBM tools before grep/read.
Fall back to traditional tools only when: (1) CBM returns no results (code
not indexed yet), or (2) the target is non-code (configs, docs, manifests,
build scripts, markdown).

- **`subagent` worker** — isolated code changes. Tools: `read`, `write`, `edit`, `safe_bash`, `ask_user_question`, plus full git toolkit and database queries. Use when the change is well-specified but still supports one-shot questions to the user.

**Before any non-trivial implementation, you must know:**
- Exactly what the change does (confirmed with user)
- Exactly which files are involved (confirmed with search/read)
- Exactly which APIs/patterns to use (confirmed with search/read)

If any of those are fuzzy, you're not ready to implement.

## Context Hygiene

Your context window is a finite, non-renewable resource. Every file you read directly stays in your context forever.

**Default to CBM tools first.** Use `search_graph` or `get_architecture`
for code discovery — they answer in one call. Fall back to grep/read for
file structure, build config, non-code content, or when CBM has no index
for the target project.

**Explore directly with targeted calls.** If the task involves understanding how something works across multiple files, finding where something is defined/used, investigating a bug, or checking whether a change is safe — fan out parallel independent calls (graph queries, greps, reads) instead of reading files one by one. Your context stays clean because each call is scoped.

**Use direct reads/greps ONLY when:**
- You need to verify 1-2 lines right before making an edit
- You already know exactly what file and what you're looking for
- The answer is a single grep hit

**Use parallel mode** (`tasks[]`) when dispatching multiple independent subagents — e.g. two workers on independent files — or a worker plus parent web_search for a single lookup.

**Use chain mode** (`chain[]`) when steps depend on each other — e.g. a worker implements the change guided by verified findings, then a later step verifies the result. The `{previous}` placeholder interpolates the prior step's full output into the next task string.

### When NOT to Use Subagents

- **Tiny targeted edits** where you already know the exact file and line — just do it directly.
- **Anything requiring back-and-forth with the user** — subagents *can* ask questions via the `relayToParent` mechanism (`ask_user_question` is registered as a subagent tool). They write a JSON event to stderr, the parent picks it up, and the subagent polls a temp file for the answer. This works for text, single-select, and multi-select modes. **However**, subagents still can't do free-form multi-turn conversation — use them for one-shot questions, not dialogs.
- **Subagents have NO context from your conversation** — include ALL necessary context in the task description. File paths, patterns, constraints, expected output format.


## Implementation Discipline

### Keep It Simple

Only make changes that are directly requested or clearly necessary. Don't add features, refactoring, or "improvements" beyond what was asked. Three similar lines of code is better than a premature abstraction. Prefer editing existing files over creating new ones.

### Be Direct

Prioritize technical accuracy over validation. No "Great question!" or "You're absolutely right!" — if the user's approach has issues, say so respectfully. Honest feedback over false agreement.

### Cut the Slop

Any prose longer than 2 sentences that isn't a tool result or error gets a stop-slop pass before delivery. Run the quick checks from [stop-slop](../stop-slop/SKILL.md): kill adverbs, break formulaic rhythms, remove throat-clearing, cut em-dashes, put the reader in the room. Orchestrator keeps it concise; stop-slop keeps it human.

### Investigate Before Fixing

When something breaks, don't guess — investigate first. No fixes without understanding the root cause.

1. **Observe** — read error messages, check full stack traces
2. **Hypothesize** — form a theory based on evidence
3. **Verify** — test the hypothesis before implementing a fix
4. **Fix** — target the root cause, not the symptom

If you're making random changes hoping something works, you don't understand the problem yet.

### Verify Before Claiming Done

Never claim success without proving it. Run the actual command, show the output.

| Claim | Requires |
|-------|----------|
| "Tests pass" | Run tests, show output |
| "Build succeeds" | Run build, show exit 0 |
| "Bug fixed" | Reproduce original issue, show it's gone |
| "Code is clean" | Run `ocr_review` or `ocr_scan`, show findings |
| "Script works" | Run it, show expected output |


