### Changed
- Commit preflight reminders stay quiet when commit-preflight is next to that git commit in the same command, and on git commit --dry-run, --help, and -h, including incomplete streamed option prefixes.
- Frontend foundations reminders fire on a first HTML page shell or a missing frontend.foundations.json signal, not on ordinary component or stylesheet edits.
- Regex reminders fire on a dynamic constructor or a nested quantifier, and stay quiet when regexploit or regex-engineering is next to that constructor.
- Shell edit, search, and wait reminders match the live command text, including an unwrapped command, and stay quiet on stream edits, phrase searches, and a single sleep.
- Frontend and regex reminders check their required shell or constructor text before nearby exclusions, keeping legacy streamed checks within the existing budgets without changing their match windows.
- Retired kit-rea-heavy-summary, kit-solo-review-not-review, and rs-unsafe-added-router after zero recorded reminders. The pack no longer ships a router class.
