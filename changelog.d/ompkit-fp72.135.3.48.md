### Fixed

- Bead lint's `elapsed-time-mix` check (TIMEAC1) no longer flags a runtime counter or a finished time item. "N consecutive" counts as an observation window only when it counts reports, runs or time periods (for example "6 consecutive hourly sitreps"); "after 3 consecutive wakes" is code behavior. A ticked time item can no longer hold a close open, so it no longer makes a bead mixed. The selftest now checks that controls pass as well as that planted violators fail; before, only the violators were checked. (ompkit-fp72.135.3.48)
