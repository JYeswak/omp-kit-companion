#!/bin/sh
# GAPFADE1 installed-chain integration, not a direct-member substitute.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
t=''
kitlib_tmp t gap-mention-e2e
export TMPDIR="$t"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }
repo="$t/repo"
mkdir -p "$repo/changelog.d"
git -C "$repo" init -q
git -C "$repo" config user.name 'Gap fixture'
git -C "$repo" config user.email 'gap@example.invalid'
export OMP_KIT_COMMIT_MSG_BEAD_SKIP_TRACKER=1
export OMP_KIT_GATE_EVENTS_SKIP=1
log 'installing real hook chains into foreign fixture'
sh "$ROOT/scripts/install-commit-msg-bead.sh" --no-pushed-beads "$repo"
printf 'Gap fixture.\n' > "$repo/changelog.d/ab12c.md"
git -C "$repo" add changelog.d/ab12c.md
printf 'fix: name producer gap [test]\n\nthe gate should say X; second time tonight\n\nBead: ompkit-ab12c\n' > "$t/message"
log 'first installed-chain commit must refuse GAP_UNFILED only'
if git -C "$repo" commit -F "$t/message" > "$t/first" 2>&1; then fail 'unfiled gap committed on first attempt'; fi
cat "$t/first"
grep -q GAP_UNFILED "$t/first" || fail 'missing GAP_UNFILED'
grep -q -F 'commit REFUSED: 1 finding(s)' "$t/first" || fail 'first refusal did not contain exactly one finding'
[ "$(grep -c -F '  commit-gap-mention GAP_UNFILED:' "$t/first")" -eq 1 ] || fail 'expected exactly one gap finding'
log 'identical retry must land'
git -C "$repo" commit -F "$t/message"
for kind in cited waived quoted; do
  printf '%s\n' "$kind" >> "$repo/changelog.d/ab12c.md"
  git -C "$repo" add changelog.d/ab12c.md
  case "$kind" in
    cited) body='the gate should say X, see ompkit-ab12c; second time tonight, see ompkit-ab12c' ;;
    waived) body='the gate should say X

Gap-Bead: none (duplicate of ompkit-ab12c)' ;;
    quoted) body="adds \`a defect row is refused\` and the test \"second time wins\"" ;;
  esac
  printf 'test: %s fixture [test]\n\n%s\n\nBead: ompkit-ab12c\n' "$kind" "$body" > "$t/message"
  log "$kind negative must pass installed chain on first attempt"
  git -C "$repo" commit -F "$t/message"
done
log 'PASS installed refusal, retry, cited bead, waiver and quoted-name negatives'
