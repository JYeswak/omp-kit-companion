### Fixed
- The land test fixture matches the project path land passes to Agent Mail (a realpath), so the suite no longer fails 50 of 72 land tests when TMPDIR is unset and temp paths go through the /tmp symlink.
