#!/bin/sh
# Fixture Git commands must not inherit caller's repository, tracker or config selectors.
unset BEADS_DB
for name in $(env | cut -d= -f1); do
	case "$name" in
		GIT_*) [ "$name" = GIT_TERMINAL_PROMPT ] || [ "$name" = GIT_CEILING_DIRECTORIES ] || unset "$name" ;;
	esac
done

# /usr/bin/git is an Xcode launcher on macOS. Resolve the same selected Git once,
# rather than repeating launcher discovery for every command in a fixture.
if [ "$(uname -s)" = Darwin ] && fixture_git=$(xcrun --find git 2>/dev/null); then
	PATH="${fixture_git%/*}:$PATH"
	export PATH
fi
unset fixture_git
