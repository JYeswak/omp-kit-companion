### Fixed

- An ack-required Agent Mail ask resolves its bead in the tracker of the message's project_key (the recipient's repo), so a seat whose session cwd is outside that repo can send a real QUESTION, BLOCKED or APPROVAL. The refusal names the tracker it read.
