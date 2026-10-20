#!/bin/sh
# check-shipped-config.sh: refuse fleet literals in shipped config/ and src defaults (oq1h.7).
#
# Scans every file under config/ plus the src modules that hold shipped
# defaults, for the fixed strings in checkers/shipped-config-denylist.txt
# (~/Developer, /Users/josh, JYeswak/, fleet seat names). Full-line comments
# (//, #, *, /*) are stripped before matching so prose about the rule itself
# does not trip it; trailing literals still fail. config/dcg/ is the
# operator-private overlay and is never scanned.
#
# Usage: check-shipped-config.sh [<root>]
#        check-shipped-config.sh --selftest
# Exit 0: clean. Exit 1: violation. Exit 2: usage error.
set -u

case "${1:-}" in
	--selftest) SELFTEST=1; ROOT="." ;;
	"") SELFTEST=0; ROOT="." ;;
	/*) SELFTEST=0; ROOT=$1 ;;
	*) SELFTEST=0; ROOT=$1 ;;
esac

case "$0" in
	/*) SELF=$0 ;;
	*) SELF=$(pwd)/$0 ;;
esac
HERE=$(dirname "$SELF")
DENYLIST="$HERE/shipped-config-denylist.txt"
SRC_DEFAULTS="src/fleet-lessons.ts src/planning-score.ts src/ci-cache.ts src/claude-save-job.ts src/fleet-user-config.ts"

if [ ! -f "$DENYLIST" ]; then
	echo "check-shipped-config: denylist missing: $DENYLIST" >&2
	exit 2
fi

# Strip full-line comments (sh/TOML/YAML `#`, TS `//`, block `*` and `/*`)
# before matching; trailing literals on code lines still fail.
strip_comments() {
	sed -e 's/^[[:space:]]*#[^!].*//' \
		-e 's/^[[:space:]]*\/\/.*//' \
		-e 's/^[[:space:]]*\*[[:space:]].*//' \
		-e 's/^[[:space:]]*\/\*.*//'
}

scan_target() {
	target=$1
	hits=0
	while IFS= read -r pattern; do
		case "$pattern" in ''|\#*) continue ;; esac
		if strip_comments < "$target" | grep -qF -- "$pattern"; then
			echo "check-shipped-config: forbidden literal '$pattern' in $target" >&2
			hits=1
		fi
	done < "$DENYLIST"
	return "$hits"
}

fail=0
if [ ! -d "$ROOT/config" ]; then
	echo "check-shipped-config: no config/ under $ROOT" >&2
	exit 2
fi
# config/dcg/ is the private overlay: operator-local, never shipped, never scanned.
for file in $(find "$ROOT/config" -type f -not -path "*/dcg/*" | sort); do
	if ! scan_target "$file"; then fail=1; fi
done
for rel in $SRC_DEFAULTS; do
	if [ -f "$ROOT/$rel" ]; then
		if ! scan_target "$ROOT/$rel"; then fail=1; fi
	fi
done

if [ "$SELFTEST" = "1" ]; then
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/shipped-config-selftest.XXXXXX")
	trap 'rm -rf "$tmp"' EXIT INT TERM
	mkdir -p "$tmp/config"
	cp "$DENYLIST" "$tmp-denylist"
	pass=0
	# Positive: the real tree is clean.
	if ! sh "$SELF" "$ROOT" >/dev/null 2>&1; then
		echo "check-shipped-config --selftest: clean tree failed" >&2
		pass=1
	fi
	# Planted negative: re-add a ~/Developer repo to config/lessons.toml.
	mkdir -p "$tmp/config"
	printf '[fleet]\nrepos = [\n  { name = "x", path = "~/Developer/x" },\n]\n' > "$tmp/config/lessons.toml"
	# Run the real scan logic against the planted file using the real denylist.
	planted_hits=0
	while IFS= read -r pattern; do
		case "$pattern" in ''|\#*) continue ;; esac
		if strip_comments < "$tmp/config/lessons.toml" | grep -qF -- "$pattern"; then
			planted_hits=1
		fi
	done < "$DENYLIST"
	if [ "$planted_hits" != "1" ]; then
		echo "check-shipped-config --selftest: planted ~/Developer re-add passed" >&2
		pass=1
	fi
	# Full-line comments must not trip the lint.
	printf '# ~/Developer/josh\n// JYeswak/x\n' > "$tmp/config/comment.toml"
	comment_hits=0
	while IFS= read -r pattern; do
		case "$pattern" in ''|\#*) continue ;; esac
		if strip_comments < "$tmp/config/comment.toml" | grep -qF -- "$pattern"; then
			comment_hits=1
		fi
	done < "$DENYLIST"
	if [ "$comment_hits" != "0" ]; then
		echo "check-shipped-config --selftest: full-line comment tripped the lint" >&2
		pass=1
	fi
	rm -f "$tmp-denylist"
	if [ "$pass" = "0" ]; then echo "check-shipped-config --selftest: PASS"; fi
	exit "$pass"
fi

exit "$fail"
