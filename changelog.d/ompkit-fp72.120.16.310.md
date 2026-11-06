### Fixed
- Tern sends reconcile rewritten journals by exact typed message identity; unproven replacements remain blocked until explicitly acknowledged with `send --ack-pending RECORD`, which never resends the old message.
