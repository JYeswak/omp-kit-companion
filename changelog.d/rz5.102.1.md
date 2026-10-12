### Fixed
- Fleet-watch never offers parked workflow states for grading: `deferred` and `blocked` are excluded from review statuses even when the policy lets them close, so a deferred bead is not pulled for verification while `in_review` work still is.
