### Fixed

- Agent Mail now wakes the seat it is addressed to. The new `kit-inbox-wake` extension runs inside each fleet seat:
  - Every 30 s it reads that seat's own durable inbox events (`am inbox-events --after <cursor>`).
  - New mail becomes one follow-up message. On a working seat omp queues it until the current turn ends, so it never interrupts the work; on an idle seat it starts a turn at once.
  - If you press Esc while a wake is still queued, omp drops it. The wake is then sent once more when that run ends, so the mail is not left unannounced. A wake the seat already received is never sent again.
  - Sender-side wakes never delivered: the wake ledger held 0 successful wakes in 879 rows. A seat in goal mode is never idle, so a wake that waits for idle never runs, and a paste into a busy seat leaves a draft a person has to submit.
  - The cursor persists per agent and project, so mail sent while a seat restarts arrives on its next start.
  - Each wake writes a `WAKE_ENQUEUED` row to `mail-wake.jsonl` when it is queued, and a `WAKE_CONSUMED` row once the seat has actually received it. The launch check counts only received wakes.
