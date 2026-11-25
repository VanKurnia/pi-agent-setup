# Commit

One message for the staged changes, committed on approval.

1. `git diff --staged`. Nothing staged → tell the user and stop.
2. Draft the title and the body from that diff. A note given with the invocation shapes them; it does not replace reading the diff.
3. Pass the approval gate, then `git commit -m "<message>"` and confirm completion.

Only staged changes are in scope.
