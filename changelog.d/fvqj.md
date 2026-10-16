### Fixed
- MCP acceptance checks support Tern's standalone OMP layout and reuse the installed version's verified SDK cache under isolated HOME, without downloading a new SDK for each fixture.
- Scratch failure-reporting checks isolate descriptor and process-census inputs while retaining real filesystem permission failures, so acceptance cannot signal unrelated host processes or depend on host-wide descriptor discovery.
