#!/bin/sh
# hook_dedup_test.sh — HOOKDEDUP1 (ompkit-1ra0d.60): one verification-stamp
# member and one bead-id verdict reused at push and ref-transaction time.
# Usage: bash tests/scripts/hook_dedup_test.sh [--push]
#   default: [a] the installed commit-msg chain refuses a stamp-less commit
#     once under the 55 aggregator (the retired legacy 10-commit-msg member is
#     gone; the folded 41 check keeps the same refusal text as a finding), and
#     a commit with no bead id is refused once with one finding naming the
#     missing id; planted negative: a commit naming a real bead id passes all
#     members.
#   --push:  [b] a push of commits that passed commit-time checks runs no `br`
#     per commit (a PATH shim counts `br` invocations: the commit-msg member
#     and the post-commit recorder wrote verdict records keyed by the exact
#     commit sha under .git/omp-kit/bead-verdicts/); planted negative: a
#     commit-tree commit that bypassed commit-msg is still refused at push,
#     and a real update-ref of main to it is refused with main unmoved.
# Real git objects and the real installer throughout; a stub `br` answers
# show <id> from KNOWN_IDS and logs every invocation. Zero fixture .beads
# state is shared between modes: each mode builds its own fixture repo.
set -u

MODE="commit"
if [ "${1:-}" = "--push" ]; then MODE="push"; fi

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
INSTALLER="$ROOT/scripts/install-commit-msg-bead.sh"
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
kitlib_tmp TMP hook-dedup-test || exit 1
TMP=$(CDPATH='' cd -- "$TMP" && pwd -P) || exit 1
export TMPDIR="$TMP"
HOST_PATH=$PATH

pass=0
fail=0
ok() { # ok <got> <want> <name>
	if [ "$1" = "$2" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}

export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@invalid.example
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@invalid.example

mkdir -p "$TMP/bin"
cat > "$TMP/bin/br" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$BR_CALLS"
id=""
for arg in "$@"; do id="$arg"; done
case " $KNOWN_IDS " in
	*" $id "*) exit 0 ;;
	*) exit 3 ;;
esac
EOF
chmod +x "$TMP/bin/br"
export BR_CALLS="$TMP/br-calls"
: > "$BR_CALLS"
export KNOWN_IDS="ompkit-2w7h"
# The counting stub stays first in PATH (the installed members resolve plain
# `br`, exactly as git runs them); host tools remain available behind it.
export PATH="$TMP/bin:$HOST_PATH"

new_repo() { # new_repo <name>: fixture repo with an id-less root, no tracker
	dir="$TMP/$1"
	mkdir -p "$dir" || return 1
	git -C "$dir" init -q -b main 2>/dev/null || return 1
	git -C "$dir" config user.email "test@invalid.example" || return 1
	git -C "$dir" config user.name "Test" || return 1
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* \
		"$dir/.git/hooks/pre-commit" "$dir/.git/hooks/pre-push" \
		"$dir/.git/hooks/reference-transaction" || return 1
	git -C "$dir" -c core.hooksPath=/dev/null commit -q --allow-empty --message "root" 2>/dev/null || return 1
	printf '%s\n' "$dir"
}

plant_legacy() { # plant_legacy <chain-dir>: the exact retired pre-canonical pair
	dir=$1
	cat > "$dir/10-commit-msg" <<'HOOKDEDUP_LEGACY_WRAPPER'
#!/usr/bin/env bash
# commit-msg — every commit subject names its verification level (stamp item h).
#
# RESOLUTION RULE (measured 2026-08-22, wave 11, bead cp-hfei — all four forms tested):
#   $0                                -> CORRECT in main worktree, linked worktree, AND clone
#   git rev-parse --show-toplevel     -> WRONG in a linked worktree (returns the worktree root,
#                                        which has no githooks/ unless committed; the hook errors)
#   an absolute /Users/... path       -> WRONG on relocation (a clone/CI checkout at another path
#                                        execs a file outside itself, or nothing at all)
#   git rev-parse --git-common-dir    -> resolves to the MAIN .git from everywhere, but pins every
#                                        worktree to the main checkout's hook version
# git invokes this wrapper by the path it resolved from core.hooksPath, so dirname "$0" is
# always the githooks/ directory git actually chose. The impl is its sibling, by construction.
set -euo pipefail
_hookdir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
_impl="$_hookdir/commit-msg-verification-level.sh"
# FAIL CLOSED: a missing impl refuses the commit. A gate that cannot find itself must never
# wave the commit through — that is the fail-open shape this whole bead exists to kill.
if [ ! -x "$_impl" ]; then
  printf 'verification-level REFUSE reason=impl-missing path=%s\n' "$_impl" >&2
  printf '  the commit-msg gate is wired (core.hooksPath) but its impl is absent here.\n' >&2
  printf '  re-run: bash %s/flywheel/stamp-install.sh --repo <this-repo>\n' "${FOUNDRY_DIR:-/Users/josh/Developer/foundry}" >&2
  exit 1
fi
exec "$_impl" "$@"
HOOKDEDUP_LEGACY_WRAPPER
	cat > "$dir/commit-msg-verification-level.sh" <<'HOOKDEDUP_LEGACY_IMPL'
#!/usr/bin/env bash
# commit-msg-verification-level.sh — a commit subject must say what it PROVED, or it is refused.
#
# WHY THIS EXISTS. Measured 2026-08-22 from the Dicklesworthstone mirror: franken_lean shipped
# 1,353 commits in 24 h, avg 1.0 file / 61 lines, and 227 of the subjects literally say
# "code-first, batch-test pending". frankensqlite: "lexer-level-verified only". The subject
# carries the epistemic state of the commit, so the ledger never overclaims. Ours said
# "verified" with no level, and four gates shipped that night with a verdict they could not
# distinguish from its opposite (docs-staleness, composer_nonempty, check-lock, UNRUN→red).
#
# Jeff, in his own pre-commit header: "It is a missing mechanism, not a knowledge gap. Four
# separate agents violated the rule on 2026-07-25 alone, each of whom knew it and had followed
# it correctly earlier the same day... nothing fails at commit time, and the agent who forgets
# is never the one who sees the red." This is the mechanism.
#
# THE LEVELS, rank-ordered. A subject claims exactly one. Higher is stronger.
#   pending    code-first, nothing run            (Jeff: "code-first, batch-test pending")
#   selftest   the gate's own --selftest passed
#   test       the suite is green
#   mutation   named killers die on a planted mutant
#   oracle     differential against the named external reference (oracles.tsv row)
#   live       firing where it runs, observed in the production ledger
#
# FORM. Either `[level]` anywhere in the subject, or the Jeff-style prose tail
# `(…, <level> pending)` / `<level>-verified`. Merge commits, reverts, and fixups are exempt
# (they carry no new claim). A subject with NO level is refused with the list.
#
# FAIL-CLOSED. A malformed or unreadable message file refuses. An empty level list is an
# authoring error and refuses. --selftest proves both legs: known-bad refused, known-good passed.
set -uo pipefail

LEVELS=(pending selftest test mutation oracle live)

usage() { printf 'usage: commit-msg-verification-level.sh <commit-msg-file> | --selftest\n' >&2; }

level_of() {
  # prints the level claimed by the subject, or nothing
  local subject="$1" lv
  for lv in "${LEVELS[@]}"; do
    if printf '%s' "$subject" | grep -qiE "\[${lv}\]|\b${lv}[- ](pending|verified)\b|\b${lv}-level\b"; then
      printf '%s' "$lv"; return 0
    fi
  done
  return 1
}

exempt() {
  local subject="$1"
  printf '%s' "$subject" | grep -qiE '^(Merge |Revert |fixup! |squash! )'
}

check_file() {
  local f="$1" subject lv
  [ -r "$f" ] || { printf 'verification-level REFUSE reason=unreadable-message-file path=%s\n' "$f"; return 1; }
  subject=$(grep -m1 -v '^#' "$f" | head -1)
  [ -n "$subject" ] || { printf 'verification-level REFUSE reason=empty-subject\n'; return 1; }
  if exempt "$subject"; then
    printf 'verification-level PASS exempt=%s\n' "${subject%% *}"; return 0
  fi
  if lv=$(level_of "$subject"); then
    printf 'verification-level PASS level=%s\n' "$lv"; return 0
  fi
  printf 'verification-level REFUSE reason=no-level subject=%q\n' "$subject"
  printf '  a commit subject must say what it PROVED. add one of: %s\n' "${LEVELS[*]}" >&2
  printf '  forms: "[test]"  or  "(code-first, test pending)"  or  "selftest-verified"\n' >&2
  printf '  the level stands ALONE in its brackets: "[test]" not "[cp-123; test]" — a bead id is not a claim\n' >&2
  printf '  example: "fix(gate): split admission lock from worker lock [selftest]"\n' >&2
  return 1
}

selftest() {
  local tmp fails=0
  tmp=$(mktemp -d) || exit 2
  [ "${#LEVELS[@]}" -gt 0 ] || { echo "selftest: FAIL — empty level list (authoring error)"; exit 1; }

  # KNOWN-BAD: no level ⇒ must REFUSE
  printf 'feat(oracles): wire domain-indexed external oracle catalogue\n' >"$tmp/bad1"
  check_file "$tmp/bad1" >/dev/null 2>&1 && { echo "selftest: FAIL — bare subject accepted (known-bad leg)"; fails=$((fails+1)); }
  # KNOWN-BAD: the word "verified" with no level ⇒ must REFUSE (the overclaim we are killing)
  printf 'fix(controller): distinguish autosuggestion, verified\n' >"$tmp/bad2"
  check_file "$tmp/bad2" >/dev/null 2>&1 && { echo "selftest: FAIL — bare 'verified' accepted (overclaim leg)"; fails=$((fails+1)); }
  # KNOWN-BAD: level bundled with a bead id ⇒ must REFUSE (measured: control-plane wrote
  # "[cp-spcc; test]" on its first commit through the hook, 2026-08-22 05:5x; a bead id is not a claim)
  printf 'fix(loop): bound the tick wait [cp-spcc; test]\n' >"$tmp/bad3"
  check_file "$tmp/bad3" >/dev/null 2>&1 && { echo "selftest: FAIL — bundled [bead; level] accepted"; fails=$((fails+1)); }
  # KNOWN-BAD: unreadable file ⇒ must REFUSE (fail-closed)
  check_file "$tmp/does-not-exist" >/dev/null 2>&1 && { echo "selftest: FAIL — missing file accepted (fail-open)"; fails=$((fails+1)); }

  # KNOWN-GOOD: each form must PASS
  printf 'fix(gate): split admission lock [selftest]\n' >"$tmp/good1"
  check_file "$tmp/good1" >/dev/null 2>&1 || { echo "selftest: FAIL — [selftest] bracket form refused"; fails=$((fails+1)); }
  printf 'fln-l8f: nothing asked whether there was room (code-first, test pending)\n' >"$tmp/good2"
  check_file "$tmp/good2" >/dev/null 2>&1 || { echo "selftest: FAIL — Jeff prose form refused"; fails=$((fails+1)); }
  printf 'feat(p9): scripts registry, oracle-verified\n' >"$tmp/good3"
  check_file "$tmp/good3" >/dev/null 2>&1 || { echo "selftest: FAIL — '<level>-verified' form refused"; fails=$((fails+1)); }
  printf 'Merge remote-tracking branch origin/main\n' >"$tmp/good4"
  check_file "$tmp/good4" >/dev/null 2>&1 || { echo "selftest: FAIL — merge commit not exempt (over-strict leg)"; fails=$((fails+1)); }
  # KNOWN-GOOD: a level word used as ordinary prose must NOT count as a claim
  printf 'docs: note that the live demo row is still in production\n' >"$tmp/prose"
  check_file "$tmp/prose" >/dev/null 2>&1 && { echo "selftest: FAIL — 'live' as prose accepted as a level claim"; fails=$((fails+1)); }

  rm -rf "$tmp"
  if [ "$fails" -eq 0 ]; then echo "selftest: PASS (4 known-bad refused, 4 known-good passed, 1 prose-not-claim refused)"; exit 0; fi
  echo "selftest: FAIL ($fails leg(s))"; exit 1
}

case "${1:-}" in
  --selftest) selftest ;;
  -h|--help|'') usage; exit 2 ;;
  *) check_file "$1" ;;
esac
HOOKDEDUP_LEGACY_IMPL
	chmod +x "$dir/10-commit-msg" "$dir/commit-msg-verification-level.sh"
}

if [ "$MODE" = "commit" ]; then
	A=$(new_repo a) || exit 1
	PATH="$TMP/bin:$HOST_PATH" sh "$INSTALLER" "$A" > "$TMP/install.out" 2>&1
	ok "$?" "0" "install-rc"
	CM="$A/.git/hooks/hooks.d/commit-msg"
	PC="$A/.git/hooks/hooks.d/post-commit"
	[ -x "$PC/50-omp-kit-bead-record" ] && [ -f "$PC/bead-verdict.sh" ] && [ -f "$CM/bead-verdict.sh" ]
	ok "$?" "0" "recorder-and-helpers-installed"

	# A long-lived repo carries the pre-canonical pair; reinstalling retires it.
	plant_legacy "$CM"
	[ -x "$CM/10-commit-msg" ] && [ -f "$CM/commit-msg-verification-level.sh" ]
	ok "$?" "0" "legacy-pair-planted"
	PATH="$TMP/bin:$HOST_PATH" sh "$INSTALLER" "$A" > "$TMP/reinstall.out" 2>&1
	ok "$?" "0" "reinstall-rc"
	if [ ! -e "$CM/10-commit-msg" ] && [ ! -e "$CM/commit-msg-verification-level.sh" ] && [ ! -e "$CM/41-omp-kit-commit-msg-vlevel" ] && [ -x "$CM/55-omp-kit-commit-gate" ] && [ -f "$CM/scripts/commit-msg-bead.sh" ] && [ -f "$CM/scripts/commit-msg-verification-level.sh" ]; then rc=0; else rc=1; fi
	ok "$rc" "0" "legacy-pair-retired-canonical-kept"
	PATH="$TMP/bin:$HOST_PATH" sh "$INSTALLER" --check "$A" > /dev/null 2>&1
	ok "$?" "0" "check-fresh-after-retire"

	# [a] one finding naming the missing bead id.
	mkdir -p "$A/.beads"
	: > "$A/.beads/beads.db"
	export BEADS_DB="$A/.beads/beads.db"
	export BR_BIN="$TMP/bin/br"
	export OMP_KIT_FINDINGS_JSON=1
	printf '[test] widget work with no identity\n' > "$TMP/a1"
	(CDPATH='' cd -- "$A" && sh "$A/.git/hooks/commit-msg" "$TMP/a1" > "$TMP/a1.out" 2> "$TMP/a1.err"); rc=$?
	ok "$rc" "1" "id-less-refused-rc"
	ok "$(grep -c '^FINDING' "$TMP/a1.out")" "1" "id-less-one-finding"
	ok "$(grep '^FINDING' "$TMP/a1.out" | cut -f2)" "55-omp-kit-commit-gate" "id-less-finding-member"
	if grep -qi 'bead' "$TMP/a1.out"; then rc=0; else rc=1; fi
	ok "$rc" "0" "id-less-finding-names-bead"

	# Planted negative: a real bead id passes all members.
	printf '[test] fix widgets ompkit-2w7h\n' > "$TMP/a2"
	(CDPATH='' cd -- "$A" && sh "$A/.git/hooks/commit-msg" "$TMP/a2" > "$TMP/a2.out" 2> "$TMP/a2.err"); rc=$?
	ok "$rc" "0" "real-id-passes-rc"
	ok "$(grep -c '^FINDING' "$TMP/a2.out")" "0" "real-id-no-findings"

	# The stamp is enforced exactly once, with the same text as a finding under the aggregator code.
	printf 'fix widgets ompkit-2w7h\n' > "$TMP/a3"
	(CDPATH='' cd -- "$A" && sh "$A/.git/hooks/commit-msg" "$TMP/a3" > "$TMP/a3.out" 2> "$TMP/a3.err"); rc=$?
	ok "$rc" "1" "no-stamp-refused-rc"
	ok "$(grep -c '^FINDING' "$TMP/a3.out")" "1" "no-stamp-one-finding"
	ok "$(grep '^FINDING' "$TMP/a3.out" | cut -f2)" "55-omp-kit-commit-gate" "no-stamp-finding-member"
	if grep -q 'must say what it PROVED' "$TMP/a3.err"; then rc=0; else rc=1; fi
	ok "$rc" "0" "no-stamp-same-refusal-text"
else
	P=$(new_repo p) || exit 1
	PATH="$TMP/bin:$HOST_PATH" sh "$INSTALLER" "$P" > "$TMP/install.out" 2>&1
	ok "$?" "0" "install-rc"
	ROOT_SHA=$(git -C "$P" rev-parse HEAD)
	git -C "$P" update-ref refs/remotes/origin/main "$ROOT_SHA"
	mkdir -p "$P/.beads"
	: > "$P/.beads/beads.db"
	export BEADS_DB="$P/.beads/beads.db"
	export BR_BIN="$TMP/bin/br"
	PATH="$TMP/bin:$HOST_PATH" git -C "$P" commit -q --allow-empty --message "[test] first ompkit-2w7h" 2> "$TMP/c1.err"
	ok "$?" "0" "first-commit-rc"
	PATH="$TMP/bin:$HOST_PATH" git -C "$P" commit -q --allow-empty --message "[test] second ompkit-2w7h" 2> "$TMP/c2.err"
	ok "$?" "0" "second-commit-rc"
	TIP1=$(git -C "$P" rev-parse 'HEAD^')
	TIP2=$(git -C "$P" rev-parse HEAD)
	VR="$P/.git/omp-kit/bead-verdicts"
	if [ -f "$VR/$TIP1" ] && [ -f "$VR/$TIP2" ] && grep -q '^PASS ompkit-2w7h ' "$VR/$TIP1" && grep -q '^PASS ompkit-2w7h ' "$VR/$TIP2"; then rc=0; else rc=1; fi
	ok "$rc" "0" "sha-records-written"

	# [b] the push of recorded commits runs no `br` per commit.
	: > "$BR_CALLS"
	PP="$P/.git/hooks/hooks.d/pre-push"
	printf 'refs/heads/main %s refs/heads/main %s\n' "$TIP2" "$ROOT_SHA" | (CDPATH='' cd -- "$P" && sh "$PP/40-omp-kit-pushed-beads") > "$TMP/push.out" 2> "$TMP/push.err"
	ok "$?" "0" "recorded-push-rc"
	if [ -s "$BR_CALLS" ]; then rc=1; else rc=0; fi
	ok "$rc" "0" "recorded-push-no-br-calls"

	# Planted negative: a commit-tree commit that bypassed commit-msg is refused.
	TREE=$(git -C "$P" rev-parse "$TIP2^{tree}")
	# shellcheck disable=SC2034
	PLANTED=$(git -C "$P" commit-tree "$TREE" -p "$TIP2" -m "quiet tweak with no id" 2>/dev/null)
	printf 'refs/heads/main %s refs/heads/main %s\n' "$PLANTED" "$TIP2" | (CDPATH='' cd -- "$P" && sh "$PP/40-omp-kit-pushed-beads") > "$TMP/pp.out" 2> "$TMP/pp.err"
	ok "$?" "4" "planted-push-refused-rc"
	if grep -q "$PLANTED" "$TMP/pp.err"; then rc=0; else rc=1; fi
	ok "$rc" "0" "planted-push-names-sha"
	if [ -s "$BR_CALLS" ]; then rc=0; else rc=1; fi
	ok "$rc" "0" "planted-push-ran-br-fallback"

	# Planted negative: a commit-tree commit that reuses a recorded commit's exact message gets
	# no record and is judged live (a message-keyed record would have admitted it unchecked).
	REUSED=$(git -C "$P" commit-tree "$TREE" -p "$TIP2" -m "[test] second ompkit-2w7h" 2>/dev/null)
	: > "$BR_CALLS"
	printf 'refs/heads/main %s refs/heads/main %s\n' "$REUSED" "$TIP2" | (CDPATH='' cd -- "$P" && sh "$PP/40-omp-kit-pushed-beads") > "$TMP/pr.out" 2> "$TMP/pr.err"
	if [ -s "$BR_CALLS" ]; then rc=0; else rc=1; fi
	ok "$rc" "0" "reused-message-judged-live"
	ok "$(find "$VR" -name 'pending-*' | wc -l | tr -d ' ')" "0" "pending-records-consumed"
	for pending in "$VR"/pending-*; do [ -f "$pending" ] && printf 'leftover %s: %s\n' "$pending" "$(cat "$pending")"; done

	# The ref guard reuses records too: the planted main move is refused and
	# main stays put; a recorded main move costs no `br` call.
	if git -C "$P" update-ref refs/heads/main "$PLANTED" "$TIP2" 2> "$TMP/rt.err"; then rc=1; else rc=0; fi
	ok "$rc" "0" "planted-ref-update-refused"
	ok "$(git -C "$P" rev-parse refs/heads/main)" "$TIP2" "planted-main-unmoved"
	git -C "$P" update-ref refs/heads/main "$TIP1" "$TIP2" > /dev/null 2>&1
	ok "$?" "0" "main-step-back-rc"
	: > "$BR_CALLS"
	git -C "$P" update-ref refs/heads/main "$TIP2" "$TIP1" > /dev/null 2>&1
	ok "$?" "0" "recorded-ref-update-rc"
	ok "$(git -C "$P" rev-parse refs/heads/main)" "$TIP2" "recorded-main-moved"
	if [ -s "$BR_CALLS" ]; then rc=1; else rc=0; fi
	ok "$rc" "0" "recorded-ref-update-no-br-calls"
fi

printf 'hook_dedup: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
