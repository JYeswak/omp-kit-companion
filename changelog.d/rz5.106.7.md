### Security

- The publishability scan no longer prints what it finds (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.7). It reported each finding with the whole matching line, so a planted or real token, or a user's home path, went into CI logs (public for this repo) and into the pre-push `gate.log`. It now prints only `class: file:line`. Binary tracked files are scanned instead of skipped, and a missing or unreadable tracked file ends the run incomplete instead of a silent skip.
