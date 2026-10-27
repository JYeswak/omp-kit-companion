### Fixed

- ARCHIVEMODE1 (ompkit-774u.34): `tests/cli/file-modes.test.sh` judges its four scripts from the tree it runs in, with no `OMP_KIT_CASE_CWD` needed. In an exact `git archive` export (revision stamp substituted, nested anywhere) it reads the exported files' own executable bits — tar preserves the committed bit — consulting no ambient Git object store, so an enclosing checkout cannot mask a committed 100644. In the live repo it still reads the committed tree (HEAD), so a dirty worktree chmod cannot mask one either. A real committed 100644 still fails in both layouts.
