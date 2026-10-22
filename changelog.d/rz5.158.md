### Fixed

- When `git commit --only` names a path that another agent holds exclusively, fleet-guard now refuses with that agent's name and the path ("…names some/path, which PeerHolder holds exclusively; ask PeerHolder to release or hand it over"). It used to say only that the path had no reservation, which left the caller guessing whom to ask. A path held only as shared, or held by nobody, still gets the plain "reserve it first" refusal.
