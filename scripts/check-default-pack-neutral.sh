#!/bin/sh
# check-default-pack-neutral.sh [--check] [--selftest]
#
# The default pack (rules/) ships to every stock user: no rule body or condition
# may prescribe fleet protocol. Fail if any rules/*.md matches one of:
#   var/agent-tmp, AGENTS.md (Storing|Pushing), Agent Mail, \bntm\b, \bdirector\b,
#   \bJosh\b, infisical
# (word boundaries so ordinary words like "directory" stay green). Fleet-protocol
# rules live in rules-fleet/ and install only through the explicit fleet pack
# (`apply rules --fleet`, `scripts/install.sh --fleet`).
#
# --check    scan the real rules/ dir, exit 1 on the first offending rule.
# --selftest plant each denylisted token into a scratch copy of a default rule and
#            prove the scan goes RED (plus a clean copy stays GREEN). Exit 1 unless
#            every plant is caught.
set -eu
LC_ALL=C
export LC_ALL

ROOT=$(cd "$(dirname "$0")/.." && pwd)

mode=check
case "${1:-}" in
  --check) mode=check ;;
  --selftest) mode=selftest ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  '') ;;
  *) echo "check-default-pack-neutral: unknown argument: $1" >&2; exit 2 ;;
esac

# scan <rulesdir>: print offending "file:line:token" rows, exit 0 when clean.
scan() {
  dir=$1
  bad=0
  for f in "$dir"/*.md; do
    [ -f "$f" ] || continue
    hits=$(grep -n -E 'var/agent-tmp|AGENTS\.md \(?(Storing|Pushing)|Agent Mail|\bntm\b|\bdirector\b|\bJosh\b|infisical' "$f" || true)
    if [ -n "$hits" ]; then
      bad=1
      printf '%s\n' "$hits" | while IFS= read -r line; do printf '%s:%s\n' "$(basename "$f")" "$line"; done
    fi
  done
  return "$bad"
}

if [ "$mode" = check ]; then
  if hits=$(scan "$ROOT/rules"); then
    set -- "$ROOT"/rules/*.md
    echo "default-pack-neutral: OK ($# rules scanned)"
    exit 0
  else
    echo "default-pack-neutral: FAIL: fleet-protocol token in default pack:" >&2
    printf '%s\n' "$hits" >&2
    exit 1
  fi
fi

# --selftest: every denylisted token must trip the scan; a clean copy must pass.
work=$(mktemp -d "${TMPDIR:-/tmp}/default-pack-neutral.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$ROOT"/rules/*.md "$work"/
plant=0
for token in 'var/agent-tmp' 'AGENTS.md (Storing)' 'AGENTS.md (Pushing)' 'Agent Mail' 'ntm spawn' 'director-only' 'Josh' 'infisical-secrets'; do
  cp "$ROOT/rules/kit-test-skip.md" "$work/kit-test-skip.md"
  printf '\n%s\n' "$token" >> "$work/kit-test-skip.md"
  if scan "$work" >/dev/null 2>&1; then
    echo "default-pack-neutral selftest: FAIL: plant '$token' not caught" >&2
    plant=1
  else
    echo "default-pack-neutral selftest: plant '$token' RED as intended"
  fi
done
cp "$ROOT/rules/kit-test-skip.md" "$work/kit-test-skip.md"
if scan "$work" >/dev/null 2>&1; then
  echo "default-pack-neutral selftest: clean copy GREEN"
else
  echo "default-pack-neutral selftest: FAIL: clean copy went RED" >&2
  plant=1
fi
[ "$plant" = 0 ] || exit 1
echo "default-pack-neutral selftest: GREEN (8 plants caught, clean copy passes)"
