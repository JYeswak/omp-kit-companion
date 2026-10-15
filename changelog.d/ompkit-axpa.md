### Added

- Fleet-round barrier timer wakes seats when the config opts in (`barrier.deliver: true`, default false): a newly REJECTED report notifies that project's `director` seat only, and a first-seen MET/MISSED barrier or new ESCALATE notifies the `chief` seat, all via `omp-kit send` with dedup keys in `barrier-state.json`. (ompkit-axpa)
