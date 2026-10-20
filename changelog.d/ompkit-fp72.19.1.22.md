### Added

- SHAFIND1 (ompkit-fp72.19.1.22): `omp-kit sha <sha>` resolves a cited commit across every fleet repo (omp-kit, omp-kit-companion, `~/.claude`, project repos), printing each holding repo with its subject and origin/main containment; exit 0 found, 1 absent everywhere. Graders must run it before declaring a commit missing, and `grade_apply.py` refuses a REWORK verdict that cites a missing commit without the verb's `SHA-ABSENT-EVERYWHERE` output.
