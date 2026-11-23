### Fixed

- A service install or update no longer drops a hand-set `OMP_KIT_AM_RSS_CEILING_BYTES` from the load-watch job: a re-render from a shell without it keeps the installed value, an explicit positive integer replaces it, an empty string clears it, and a bad explicit value is refused as `AM_CEILING_INVALID`. The 0.2.145 install dropped it, the 6 GiB default applied to a 6.7 GB Agent Mail server, and am-watch killed it. The default Agent Mail RSS ceiling of the am-watch job is now 24 GiB (was 6 GiB), so a dropped variable can no longer restart a healthy large server.
