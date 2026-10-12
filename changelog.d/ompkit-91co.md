### Fixed
- `skills/fleet-round`: the report validator accepts `MISSION: PROPOSED` in round 0 with the drafted text in `mission_proposed`, as the round-0 plan allows, when the repo states no mission; it still rejects a draft after round 0, a draft without text, or a draft where the repo already states a mission.
