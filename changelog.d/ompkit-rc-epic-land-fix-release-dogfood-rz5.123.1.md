### Fixed
- Planning conversion scopes native identities and parent epics to the selected mission, supports preflighted explicit local parents for new items, refuses explicit parents with open native blockers, rejects conflicting amendment identities, and preserves existing target contracts on reapply.
- Applying a plan now requires `--actor ACTOR` for explicit native audit attribution and always disables native auto-import and JSONL auto-export; the actor flag does not verify pane identity or bypass native policy.
