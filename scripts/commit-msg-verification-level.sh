#!/usr/bin/env bash
# commit-msg-verification-level.sh — CANONICAL SOURCE (VLEVELGAP1 ompkit-fp72.120.16.23.3).
# A commit subject must say what it PROVED, or it is refused. Installed as the
# executable chain member hooks.d/commit-msg/41-omp-kit-commit-msg-vlevel in every
# repo that carries the pre-push sibling (scripts/pre-push-verification-level.sh,
# member hooks.d/pre-push/41-omp-kit-pushed-vlevel); that sibling's --check refuses
# a repo with one member and not the other. Git calls: commit-msg MSG_FILE.
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
  local tmp='' fails=0 here
  # kitlib-tmp.sh sits beside this file both as installed member (the installer's
  # kitlib_tmp commit-msg row) and as source in scripts/.
  here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
  [ -f "$here/kitlib-tmp.sh" ] || { echo "selftest: FAIL — kitlib-tmp.sh missing beside $0"; exit 2; }
  # shellcheck source=scripts/kitlib-tmp.sh
  . "$here/kitlib-tmp.sh"
  kitlib_tmp tmp commit-msg-vlevel-selftest || exit 2
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
