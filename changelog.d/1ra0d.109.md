### Fixed

- `kit-no-gh-poll` bash conditions now anchor on their required literals (`gh`, `for`/`while`/`until`) and check the left context with a lookbehind instead of retrying it at every stream position: the pair's live-stream cost fell from ~262 ms to ~66 ms per sweep (budget 500 ms), with zero verdict changes across the corpus, generated, and live-scenario wires.
