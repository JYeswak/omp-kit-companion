#!/bin/sh
# Fixture Git commands must not inherit a caller's repository or config selectors.
for name in $(env | cut -d= -f1); do
	case "$name" in
		GIT_*) [ "$name" = GIT_TERMINAL_PROMPT ] || [ "$name" = GIT_CEILING_DIRECTORIES ] || unset "$name" ;;
	esac
done
