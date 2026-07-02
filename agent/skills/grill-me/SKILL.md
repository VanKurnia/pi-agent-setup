---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

**One question per turn.** Batching multiple questions hides dependencies — walk the tree one branch at a time.

If a question can be answered by exploring the codebase, explore it instead.

## Question delivery

Prefer the `ask_user_question` tool over plain text when the question has a discrete set of plausible answers. It renders a picker with an "Other" escape hatch, keeping the conversation moving while preserving free-form override.

- **One question per tool call.** Make separate `ask_user_question` calls for each question — don't bundle.
- **Lead with your recommendation.** Put your preferred option first with `(Recommended)` in its label, and explain *why* in `description`.
- **Use `details` for context.** Pass ASCII mockups, code snippets, or layout sketches there — it's shown below the question.
- **Omit `options` for open-ended input.** When the question is genuinely open-ended (e.g., "what are the use cases?"), pass no options — the tool falls back to free-text input.
- **Use `multiSelect: true` only when multiple answers to a single question are valid** (e.g., "which of these frameworks have you used?").
- **Fall back to plain text only when the question is a quick aside** that doesn't warrant a tool invocation.

## Compatibility

This skill works alongside the orchestrator skill. Orchestrator's context-hygiene and investigation rules apply:
- Scout before asking when answers exist in the codebase
- One question per ask_user_question call
- Prefer ask_user_question over plain text for discrete multiple-choice questions

## Termination

Stop interviewing when:

1. All decision branches are resolved (no remaining open questions with dependencies on unanswered ones)
2. The design is sufficiently specified that a scout agent could start implementation without ambiguity
3. The user asks to stop

## Output Artifact

Produce a structured design summary:
- **Decisions made**: each with the chosen option, rationale, and rejected alternatives
- **Open questions**: any unresolved items deferred intentionally with a trigger condition
- **Architecture sketch**: components, data flow, boundaries (3-5 sentences)

The summary goes in a code block (for easy copying) or as a markdown file.