### Fixed
- Hosted planning scores now require `ci.required_workflow` (a workflow ID or YAML filename/path) and a successful latest attempt at the exact configured local branch head. Unrelated workflows and historical greens no longer pass; missing identity, unpublished heads and pending runs remain UNKNOWN. JSON evidence includes workflow ID/path, run ID, attempt and head SHA.
