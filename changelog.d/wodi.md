### Added

- Fleet guard now applies the hot-path TTL cap (default 30 min, paths in `.omp/hot-paths`) to the `am file_reservations reserve` and `am file_reservations renew` CLI route as well as the MCP tools: `--ttl` (default 3600 s) on an exclusive reserve and `--extend-seconds` / hold age on a renew are refused with a message naming the cap and the hot path. Calls without `--shared` are judged exclusive; quoted or echoed `am` text is ignored; non-hot paths are unaffected.
