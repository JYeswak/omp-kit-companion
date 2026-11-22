#!/bin/sh
# br-shim-separator.test.sh — BRSHIMSEP1 (ompkit-d4uv3) separator contract.
# A single-bead read through the shim returns the bead with --actor inserted
# BEFORE the `--` end-of-options separator; a mutation with a wrong actor is
# still refused. A fake `br` records its argv and emulates the real binary's
# separator semantics: any option-looking word after `--` is a literal id, so
# a trailing `--actor NAME` fails with rc 3.
# Follows ~/AGENTS.md producer truth: every verdict comes from the recorded
# argv file plus exit codes and stdout, never from a filtered excerpt.
set -u

SHIM=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/br-shim.sh
REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$SHIM")/.." && pwd)
REPO_TMP="$REPO_ROOT/var/agent-tmp"
# shellcheck source=scripts/kitlib-tmp.sh
. "$REPO_ROOT/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP br-shim-separator || exit 1
export XDG_STATE_HOME="$TMP/state"

mkdir -p "$TMP/realbin" "$TMP/shimbindir"
cat > "$TMP/realbin/br" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$BR_SHIM_TEST_ARGV"
seen_sep=0
for arg in "$@"; do
	if [ "$seen_sep" = 1 ]; then
		case "$arg" in
			--*) printf 'br: unknown id %s\n' "$arg" >&2; exit 3 ;;
		esac
	elif [ "$arg" = "--" ]; then
		seen_sep=1
	fi
done
if [ "$1" = "show" ]; then
	printf '{"id":"bead-1","status":"in_progress","assignee":"%s"}\n' "${AGENT_NAME:-}"
fi
exit 0
EOF
cat > "$TMP/realbin/am" <<'EOF'
#!/bin/sh
printf '<%s>' "${AM_FAKE_MODE:-clear}" >> "$AM_LOG"
for arg do printf ' <%s>' "$arg" >> "$AM_LOG"; done
printf '\n' >> "$AM_LOG"
printf 'No conflicts detected.\n'
exit 0
EOF
chmod +x "$TMP/realbin/br" "$TMP/realbin/am"
ln -s "$SHIM" "$TMP/shimbindir/br"

pass=0
fail=0
export BR_SHIM_TEST_ARGV="$TMP/argv"
export AM_LOG="$TMP/am.log"
export AM_FAKE_MODE=clear
: > "$AM_LOG"
export PATH="$TMP/shimbindir:$TMP/realbin:/usr/bin:/bin"
export AGENT_NAME="TestShim"

# 1. single-bead read: --actor lands before `--`, real br answers rc 0.
: > "$TMP/argv"
BEADS_DB="$TMP/fixture/.beads/beads.db" br show --json -- bead-1 > "$TMP/out" 2>&1
got_rc=$?
recorded=$(tr '\n' ' ' < "$TMP/argv" | sed 's/ $//')
if [ "$got_rc" = "0" ] && [ "$recorded" = "show --json --actor TestShim -- bead-1" ] \
	&& grep -Fq '"id":"bead-1"' "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL read-actor-before-separator: rc=%s argv<<<%s>>> out<<<%s>>>\n' \
		"$got_rc" "$recorded" "$(cat "$TMP/out")"
fi

# 2. planted negative: a mutation carrying another agent's name is refused
# before the real br runs.
: > "$TMP/argv"
BEADS_DB="$TMP/fixture/.beads/beads.db" br close bead-1 --actor WrongActor > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] \
	&& grep -Fq "BR_SHIM_ACTOR_MISMATCH" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL wrong-actor-mutation-refused: rc=%s argv-bytes=%s out<<<%s>>>\n' \
		"$got_rc" "$(wc -c < "$TMP/argv")" "$(cat "$TMP/out")"
fi

# 3. equals-spelling wrong actor is refused the same way.
: > "$TMP/argv"
BEADS_DB="$TMP/fixture/.beads/beads.db" br update bead-1 --status open --actor=WrongActor > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] \
	&& grep -Fq "BR_SHIM_ACTOR_MISMATCH" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL wrong-actor-equals-refused: rc=%s argv-bytes=%s out<<<%s>>>\n' \
		"$got_rc" "$(wc -c < "$TMP/argv")" "$(cat "$TMP/out")"
fi

printf 'br-shim-separator: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
