### Fixed
- The close-evidence tripwire no longer mistakes quoted Agent Mail send/reply payloads, including JSON-escaped shell line continuations, for close attempts. Actual reasonless closes following mail or inside command substitutions remain blocked; unrelated acceptance updates remain quiet.
- Single-quoted argument values containing parentheses are consumed as data before checking active command terminators, preserving evidence-bearing closes with parenthesized database paths.
