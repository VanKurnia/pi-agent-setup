# Set Scope

The target is the paths given after the mode: understand them deeply before touching them.

## Scope

- Each argument is a workspace-relative or absolute file or directory.
- No paths — ask for them and stop.
- A path that does not exist is reported and skipped. Never substitute a guessed alternative.
- Stay inside the given paths; a cheap dependency check is the only exception.

## Read

- **A file** — read it whole: role, key interfaces, imports, and who depends on it (grep for the import when cheap).
- **A directory** — tree 2–3 levels deep, then entry points, READMEs, config, and tests. Interfaces and types before implementation, deeper only where the task will need it.

## Report

- confirmed scope: the paths, and file versus directory;
- understanding of the scope as a whole: purpose in one or two sentences, how the pieces fit, key interfaces and their contracts, external dependencies and dependents;
- what is now in context;
- proposed next step;
- open questions or ambiguities.
