#!/bin/sh
# SHIMPATH2 (ompkit-fp72.120.16.226): fresh-gate.sh, which the commit and push gates run, handed its
# seat PATH to the affected tests; an agent-bin br shim first in that PATH refused every fixture actor.
# The scrub is scripts/kitlib-shimpath.sh, shared with release-verdict.sh. FRESH_GATE_UNDER_TEST swaps
# in another gate for the planted negative.
set -u
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REPO_TMP="$KITREPO/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP fresh-gate-shimpath-test || exit 1
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

# The caller's PATH minus any shim, so sh/python3/git stay reachable whatever seat runs the test.
clean=''
ifs=$IFS
IFS=:
for d in $PATH; do
	case "$d" in ''|*/.local/share/omp-kit/agent-bin) continue ;; esac
	[ -e "$d/br-shim.sh" ] && continue
	clean="${clean:+$clean:}$d"
done
IFS=$ifs

# Planted fixture: an agent-bin dir under a fixture HOME, br linked to the repo's shim, plus a real-br
# dir and a plain dir that must both survive in place.
home="$TMP/home"
agent_bin="$home/.local/share/omp-kit/agent-bin"
mkdir -p "$agent_bin" "$TMP/realbin" "$TMP/plain"
ln -s "$KITREPO/scripts/br-shim.sh" "$agent_bin/br"
printf '#!/bin/sh\necho real-br\n' >"$TMP/realbin/br"
chmod 755 "$TMP/realbin/br"
planted="$agent_bin:$TMP/plain:$TMP/realbin:$clean"

# 1. The helper: br on the cleaned PATH is not the shim, and only the shim dir went.
out=$(HOME=$home PATH=$planted sh -c '. "$1/scripts/kitlib-shimpath.sh"; kitlib_drop_agent_bin probe; printf "path=%s\nbr=%s\n" "$PATH" "$(command -v br)"' sh "$KITREPO")
printf '%s\n' "$out" | grep -qxF "probe: PATH sanitized (removed $agent_bin)"; ok $? "helper prints the sanitized line"
printf '%s\n' "$out" | grep -qxF "br=$TMP/realbin/br"; ok $? "br resolves past the shim"
printf '%s\n' "$out" | grep -qxF "path=$TMP/plain:$TMP/realbin:$clean"; ok $? "other PATH entries kept in order"
out=$(HOME=$home PATH="$TMP/realbin:$clean" sh -c '. "$1/scripts/kitlib-shimpath.sh"; kitlib_drop_agent_bin probe' sh "$KITREPO")
if [ -z "$out" ]; then ok 0 control; else ok 1 "control: a clean PATH prints nothing"; fi

# 2. fresh-gate's real call site: a gate copy in a fixture repo, run against an empty archive dir. It
# stops at "archive is missing the gate scripts", after the scrub and before any step or test child.
gate_run() { # $1 = gate script to install
	repo="$TMP/repo.$2"
	mkdir -p "$repo/scripts" "$TMP/archive.$2"
	cp "$1" "$repo/scripts/fresh-gate.sh"
	cp "$KITREPO/scripts/kitlib-shimpath.sh" "$repo/scripts/"
	HOME=$home PATH=$planted sh "$repo/scripts/fresh-gate.sh" --archive-dir "$TMP/archive.$2" 2>&1
}
out=$(gate_run "${FRESH_GATE_UNDER_TEST:-$KITREPO/scripts/fresh-gate.sh}" real)
printf '%s\n' "$out" | grep -qxF "fresh-gate: PATH sanitized (removed $agent_bin)"; ok $? "fresh-gate scrubs the planted PATH: $out"
printf '%s\n' "$out" | grep -qF "archive is missing the gate scripts"; ok $? "fresh-gate reached its first archive check"

# 3. Mutant: the same gate with the helper call removed keeps the shim; the planted case must fail.
grep -v '^kitlib_drop_agent_bin fresh-gate$' "$KITREPO/scripts/fresh-gate.sh" >"$TMP/fresh-gate.mutant.sh"
if cmp -s "$TMP/fresh-gate.mutant.sh" "$KITREPO/scripts/fresh-gate.sh"; then
	ok 1 "mutant differs from the gate (call site present)"
else
	out=$(gate_run "$TMP/fresh-gate.mutant.sh" mutant)
	if printf '%s\n' "$out" | grep -qF "PATH sanitized"; then ok 1 "mutant must not sanitize"; else ok 0 mutant; fi
fi

printf 'fresh-gate-shimpath: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
