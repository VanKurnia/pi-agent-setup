# filechanges (pi extension)

Tracks files changed (modified/created) by **pi** via the built-in `edit` and `write` tools.

## Features

- Persistent log (stored in session as custom entries)
- Status line + widget listing changed files
- `/filechanges` overlay to inspect diffs
- `/filechanges-accept` to clear the log (keep files)
- `/filechanges-decline` to revert logged changes (restore original contents / delete created files)

## Usage

1. Reload pi: `/reload`
2. Make changes through pi (using `edit`/`write`)
3. Run:
    - `/filechanges` to inspect
    - `/filechanges-accept` to accept (clear log), in this session only
    - `/filechanges-decline` to decline (revert), in this session only

### Sub-agents

A sub-agent is another pi process in another terminal with its own log, so nothing
here can clear or revert its files. Add `tree` to run the same command in the
sub-agents this session started (and their own, one level at a time):

- `/filechanges-accept tree`
- `/filechanges-decline tree`

The fan-out is never automatic: a plain accept/decline touches this session only.
Sub-agents still working, or waiting for you, are left alone and named in the
summary — typing into them would queue the command mid-turn. Sub-agents whose log
is already empty are skipped silently.

### Non-interactive usage

If `ctx.hasUI` is false (print/json mode), accept/decline require explicit confirmation:

- `/filechanges-accept force`
- `/filechanges-decline force`

The arguments combine: `/filechanges-accept tree force`.

## Notes

- Only tracks changes performed through `edit` and `write` tools.
- To support "decline", the extension stores the original file contents (before the first pi change) in the session file as a custom entry.
