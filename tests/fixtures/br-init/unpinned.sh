#!/bin/sh
set -eu
created=$(br --no-auto-import --no-auto-flush create "unpinned fixture mutation probe" --acceptance-criteria "- [ ] parent tracker changed" --silent --actor BrInitFixture)
br init -vv
printf '%s\n' "$created"
