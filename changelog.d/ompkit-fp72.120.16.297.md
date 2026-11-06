### Fixed
- Scratch durability admission retries its first Git read once only when the two-second execution deadline terminates it, tolerating cold executable startup while keeping persistent hangs and other read failures fail-closed.
