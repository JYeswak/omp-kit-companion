# Native certification and work doctor fixes

Native certification now derives the expected rule count from the release manifest instead of a fixed 22, so adding a rule no longer refuses every platform candidate. `omp-kit doctor --scope work` is routed to the work-fleet inspector again; adding `--scope sessions` had replaced its dispatch.
