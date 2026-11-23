### Fixed

- `omp-kit land` now schedules the release-qualification verdict from the installed kit: it runs the starter through `python3`, because the kit release packages `.py` files 0644 and executing `releases/<v>/scripts/release-verdict-start.py` directly returned 126, so every land by 0.2.147 reported `release_qualification: UNAVAILABLE` and scheduled no verdict.
