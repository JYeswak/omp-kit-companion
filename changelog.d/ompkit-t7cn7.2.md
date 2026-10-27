### Fixed

- Pushing a brand-new tag that points at a commit already on origin/main no longer runs fresh-gate or the full-suite verdict: the gate fetches the literal refs/heads/main from origin, confirms the tag target is an ancestor, and admits the push with a named reason. Tag moves, tags pointing off main, and branch pushes still run the full gate. (ompkit-t7cn7.2)
- The tag admit judgment uses the pushed-to remote from git's pre-push $1 and names it in the reason; when the chain runner drops argv the gate falls back to origin and says so in the line. (ompkit-t7cn7.2)
