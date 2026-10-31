### Changed
- Preflight now refuses in-review or close for grader-queued step 3/4 fixes unless a bead comment records valid code-cited prior art or a complete nothing-found search.
- Added `omp-kit grader next`; it selects from available priorities, reads `grade_wave.py` only from `OMP_KIT_GRADE_WAVE`, and reports unavailable queue sources as UNKNOWN rather than treating them as empty.
