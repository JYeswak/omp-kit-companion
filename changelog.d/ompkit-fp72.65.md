### Fixed
- Release train certifies the bump inline: the train calls CI on the bump SHA in its own run and tags only when every native receipt records that SHA, so a token-pushed bump no longer waits for a push run that never starts.
