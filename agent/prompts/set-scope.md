---
description: Set working scope to given paths and understand them deeply before proceeding
argument-hint: "<path...> [path...]"
---

We are going to work on $@. Understand it deeply before going further.

## Scope

- Each argument is a workspace-relative or absolute file or directory path.
- If no paths are given, ask for them and stop.
- If a path does not exist, report it and skip it. Do not guess alternatives.
- Stay inside the given paths except for cheap dependency checks (who imports what). Do not wander the codebase.

## How to understand

- For files: read the full file. Note its role, key interfaces/functions, imports, and who depends on it (grep for imports if cheap).
- For directories: list the tree 2-3 levels deep, identify entry points, READMEs, config, and tests. Read entry points and type/interface definitions first, then go deeper as needed.
- Skip noise: `node_modules/`, `dist/`, build output, large generated files. Prioritize interfaces and entry points over implementation details in large scopes.

## Rules

- Comprehension only. Do not implement, fix, or refactor yet.
- For the whole scope together, work out: purpose (one or two sentences), structure (how the pieces fit), key interfaces and their contracts, external dependencies and dependents, and open questions.

## Completion

Report and wait for go-ahead before doing further work:

- confirmed scope (paths, file vs dir);
- understanding summary (purpose, structure, key interfaces);
- what is loaded into context;
- proposed next step;
- open questions or ambiguities.
