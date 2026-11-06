### Fixed
- Kit updates run the target release's own full postcheck once, preserving its stage expectations, harness environment, service-state policy and watched state root instead of using the previous version's test runtime. Invalid or exit-inconsistent candidate reports cannot certify an update.
