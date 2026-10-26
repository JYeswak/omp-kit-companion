### Fixed

- Agent Mail now wakes the seat it is addressed to. The new `kit-inbox-wake` extension runs inside each fleet seat:
  - Every 30 s it reads that seat's own durable inbox events (`am inbox-events --after <cursor>`).
  - New mail becomes one follow-up message. On a working seat omp queues it until the current turn ends, so it never interrupts the work; on an idle seat it starts a turn at once.
  - Sender-side wakes never delivered: the wake ledger held 0 successful wakes in 879 rows. A seat in goal mode is never idle, so a wake that waits for idle never runs, and a paste into a busy seat leaves a draft a person has to submit.
  - The cursor persists per agent and project, so mail sent while a seat restarts arrives on its next start.
  - Each wake writes a `WOKEN_INPROCESS` row to `mail-wake.jsonl` when it is queued. That row means "queued", not "received", so the launch check does not count it.
  - Known limits in this release: a wake dropped by an Esc is not sent again, and a seat busy with a long run can receive queued mail late. Re-sending after an Esc and a separate "received" row were withdrawn before release, because re-sending at every run end delivered each mid-run wake twice; the fix is open on ompkit-uk9wn.2.
