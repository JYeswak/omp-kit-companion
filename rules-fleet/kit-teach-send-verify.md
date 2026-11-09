---
condition: 'ntm(?<=\bntm|\\nntm|\\tntm)(?=\s|\\t)(?=[^|;&]*(\s|\\t)send(\s|\\t|\\n|$))(?<!\becho(\s|\\t)"?ntm)(?<!\bprintf(\s|\\t)"?ntm)'
scope: tool:bash
interruptMode: never
---
This `ntm send` proves nothing: the call can exit 0 while the message never lands, and nobody re-checks. Message another seat through Agent Mail instead (`send_message` to its agent name); mail wake delivers it to every agent seat (J-2026-11-09-02). Check delivery with `get_message_delivery_receipt`, never the send's exit code. Never type into a busy pane. A literal search for, or prose naming, `ntm send` (for example `echo ntm send ...`) stays quiet; only the shell words fire this reminder.
