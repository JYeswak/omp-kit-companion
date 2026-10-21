---
condition: 'ntm(?<=\bntm|\\nntm|\\tntm)(?=\s|\\t)(?=[^|;&]*(\s|\\t)send(\s|\\t|\\n|$))(?<!\becho(\s|\\t)"?ntm)(?<!\bprintf(\s|\\t)"?ntm)'
scope: tool:bash
interruptMode: never
---
This `ntm send` proves nothing: the call can exit 0 while the message never lands, and nobody re-checks. Send cross-session messages with `omp-kit send SESSION PANE MESSAGE` instead: it appends a unique marker, polls the target capture up to 15 s, retries once, then writes the full text to the shared drop folder and reports NOT_DELIVERED with the drop path. Exit code reflects delivery, not the send call. Measured 2026-10-19: two `omp-kit send` calls to idle Tern seats reported NOT_DELIVERED with drop files while the raw transport worked, because the CLI drove the tmux/ntm path for a `tern:<id>` pane; `tern:<id>` panes now route to the verified native Tern delivery with session-file proof.

Use `omp-kit send omp-test tern:5 "status update"` for Tern seats and `omp-kit send omp-test %54 "status update"` for tmux panes. A work dispatch must cite its bead id or pass `--no-bead-reason "<why>"`. Never type into a busy pane: a spinner in the last lines means the turn owns the composer, so the send is held or refused, never forced with Enter. A literal search for, or prose naming, `ntm send` (for example `echo ntm send ...`) stays quiet; only the shell words fire this reminder.
