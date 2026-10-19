# Safe operator interrupt for a looping turn (LOOPGUARD1 AC4)

Measured 2026-10-19 on installed omp 18.12.3 (Tern), owned tmux pane,
isolated profile (`--profile loopguard-ac4`), local keyless model
`ollama/qwen3.8:27b-mlx`, zero API cost. No foreign pane touched
(a live `omp --profile claude` process on ttys011 was observed and left alone).

## Answer

Press **single `Escape`** while the turn runs. It stops the turn and preserves
both queued and composer input. No other key or command is needed.

## Evidence

Setup: prompt `Call the bash tool with command "sleep 60" ...` produced a
`Working…` turn (pane read, ~50s elapsed, tool executing).

1. **Queued message.** While the turn ran, `QUEUED-MARKER-PRESERVE-ME` + Enter
   landed in `Steering · 1` (queued, editable via `⌥↑`), turn still `Working…`.
   Single `Escape` → within ~3s the spinner cleared and the status line
   returned to idle (`π-loopguard-ac4`). The queued message was NOT sent and
   NOT lost: it sat intact in the composer (`╰─ QUEUED-MARKER-PRESERVE-ME`).
2. **Unsent composer draft.** Second `sleep 60` turn; typed
   `DRAFT-MARKER-UNSENT` with no Enter (visible in composer during `Working…`).
   Single `Escape` → turn stopped in ~4s, draft text intact in the composer.
3. **Tool kill.** After each interrupt, `ps` showed no `sleep 60` process:
   the running tool is terminated, not orphaned.

## Operator procedure

1. Confirm the pane is yours (never input into a foreign or BUSY fleet seat;
   orchestration8: bounded OWNED validation only).
2. If you have text to preserve, leave it in the composer or send it so it
   queues under `Steering` — both survive the interrupt.
3. Press `Escape` once. Wait ~5s; the spinner clears and the status line goes
   idle while your text stays in the composer.
4. Resume by editing/sending the preserved composer text.

## Not measured here

Double-`Escape`, `Ctrl-C`, and `/cancel` semantics; interrupt latency while a
model is mid-stream (both specimens interrupted a running tool, not token
streaming); queued subagents of an interrupted turn.
