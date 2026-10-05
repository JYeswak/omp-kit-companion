#!/bin/sh
# file-modes.test.sh — committed executable-bit contract.
# Scripts the fleet executes directly (shebang, hook, symlink target) must be
# committed 100755, or fresh clones break (ID1 boxes 3-4 grade FAIL).
# Reads the committed tree, never the worktree.
set -u

pass=0
fail=0
for file in scripts/br-shim.sh scripts/agent-spawn-env.sh scripts/agent-trailer-hook.sh scripts/close-guard.sh; do
	mode=$(git ls-tree HEAD -- "$file" 2>/dev/null | awk '{ print $1 }')
	if [ "$mode" = "100755" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL mode: %s committed as %s, want 100755\n' "$file" "${mode:-missing}"
	fi
done

printf 'file-modes: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
