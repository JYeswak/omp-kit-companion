### Fixed

- Inbox wakes no longer redeliver mail the seat already received: a wake now requires the event cursor to advance past the stored cursor and the message id to be unseen, so a re-emitted feed cannot wake twice.
