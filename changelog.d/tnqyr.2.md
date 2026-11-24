### Added
- `kit-inbox-wake` can wake an idle seat from the local Board: with `FLEET_MAIL_BACKEND=board` it holds a long-poll on the Board's `/events` feed for mentions of the seat and wakes the pane once per new mention (about 90 ms instead of a 30 s Agent Mail poll). Agent Mail stays the default and is unchanged.
- One cursor file per seat (`inbox-wake/<seat>.board.json` under the kit state dir) records the last event and the mentions already woken, so a mention at or before the cursor never wakes and a restarted seat replays nothing.
