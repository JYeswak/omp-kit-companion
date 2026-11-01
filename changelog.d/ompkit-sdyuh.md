### Fixed
- Separate the CASS status deadline from classification fixtures: callers retain the 2000 ms production default, tests use an explicit larger budget, and timed-out probes remain explicitly UNVERIFIED. CASS probes now use the owned async execution helper.
