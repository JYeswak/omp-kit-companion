### Fixed

- Planning conversion no longer silently skips a changed acceptance under an existing `<mission>:<slug>` contribution token. When the stored acceptance boxes differ from the plan item's, the run refuses with a `STALE_ACCEPTANCE` finding naming the slug, bead id, missing boxes and stored boxes, before any write in that group.
- `omp-kit planning convert --apply` accepts `--amend-acceptance` to append only the missing acceptance boxes through the existing native `update --if-unchanged` revision gate; concurrent target changes are still refused, manually authored boxes are never deleted or rewritten, and stored boxes absent from the plan are reported as superseded so an old PASS on them is not counted.
