### Fixed

- The fleet guard's amend refusal also catches git called by its full path (`/usr/bin/git commit --amend`). It no longer misreads commit option values (`-m`, `--message`, `-F`, `--file`, `--author`, `--date`, reuse/reedit, and a trailing `-m` in a flag bundle) as flags. (ompkit-xa5s.25)
