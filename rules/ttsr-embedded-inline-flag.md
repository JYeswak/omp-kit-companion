---
condition: 'condition:[^\n]*\|\s*\(\?[a-z]{1,5}\)'
scope: tool:write, tool:edit
interruptMode: never
---
**This TTSR condition has an EMBEDDED inline flag, and the rule you are writing will never fire.**

TTSR conditions are **JavaScript** `RegExp`, not Rust regex or PCRE. A **leading** `(?i)` is fine — omp lifts it to the `i` flag. An **embedded** one (`foo|(?i)bar`) is a syntax error.

Why this is worse than an error: `omp ttsr test` reports it, but a live session does **not**. Per `omp://ttsr-injection-lifecycle.md`, an invalid condition is *"logged as a warning and ignored"* — so the rule **loads, never fires, and looks installed**. Every arm you write against it can pass while it guards nothing.

Measured 2026-09-20: the first draft of `absence-from-one-probe` shipped exactly this defect and was caught only because a compile arm was added to the selftest the same hour.

Fix: drop the inline flag and use character classes — `[Ii]nstalled`, `[Rr]eady`. A named `bash` service's `ready.log` (`bash` with `name` and `ready`) is also a JS `RegExp` compiled with `u`, and there even a leading `(?i)` is invalid; that one fails loudly at start (`Invalid readiness regex`) instead of silently.

INVARIANT rule. Verify with `omp ttsr test --rule <file> --source text 'zzzz_cannot_exist_9c42'`: the message *"has no usable TTSR condition"* means dead, not quiet.
