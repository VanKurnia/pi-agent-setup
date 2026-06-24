---
name: improve-codebase-architecture
description: Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

This command is built on a shared design vocabulary:

- Run the `/codebase-design` skill for the architecture vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) and its principles (the deletion test, "the interface is the test surface", "one adapter = hypothetical seam, two = real"). Use these terms exactly in every suggestion — don't drift into "component," "service," "API," or "boundary."

## Process

### 1. Explore

Use the Agent tool with `subagent_type=Explore` to walk the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as a Markdown analysis report

Write a self-contained Markdown file inside the current workspace under `.plans/analysis/architecture-review-<timestamp>.md` (create the directory if it does not exist).

The report should be highly visual, using standard Markdown features and **Mermaid code blocks** (` ```mermaid `) for before/after system visualization.

For each candidate, include:
- **Involved Files**: Provide the exact absolute and repo-relative paths of the files/modules involved, linked to the source tree if supported.
- **Strength**: One of `Strong`, `Worth exploring`, or `Speculative`.
- **Category**: The dependency category (`in-process`, `local-substitutable`, `ports & adapters`, `mock`).
- **Problem**: One sentence. Why the current interface causes friction, referencing the exact lines of code where the friction occurs.
- **Solution**: One sentence. What changes.
- **Before / After Diagrams**: A Mermaid flowchart showing the dependency/call graph and how the shallow modules collapse into a deep module.
- **Wins**: Bullet points of ≤6 words each (e.g. "Tests hit one interface", "pricing logic stops leaking").

End the report with a **Top Recommendation** section indicating which candidate should be tackled first and why.

**Use the `/codebase-design` vocabulary for the architecture.** Talk about modular interfaces rather than implementation details.

See [MARKDOWN-REPORT.md](MARKDOWN-REPORT.md) for the full Markdown scaffold and layout guidance.

Do NOT propose interfaces yet. After writing the file, print the report's path and ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, run the `/grill-me` skill to walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

- **What would you like to do next?**
  - Use `ask_user_question` to offer choices:
    ```
    ask_user_question(
        question="What would you like to do next?",
        options=[
            {"label": "Explore alternative interfaces for the deepened module (Recommended)", "value": "explore_alternatives"},
            {"label": "Proceed with the current design and deepen the module", "value": "proceed_deepen"},
            {"label": "Re-evaluate candidate selection", "value": "re_evaluate"},
            {"label": "Other", "value": "other"}
        ]
    )
    ```
  - If `explore_alternatives` is chosen, run the `/codebase-design` skill and use its design-it-twice parallel sub-agent pattern.
  - If `other` is chosen, capture the user's text input and act accordingly.
