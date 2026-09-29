#!/bin/sh
# check-readiness.sh: machine-check a planning packet for its 12 required
# sections before execution starts.
#
# Adapted from the MIT-licensed franken-research starter-kit
# (starter-kit/scripts/check-readiness.sh), with fail-closed fixes.
# Packet and root are explicit arguments; no private repo is required.
#
# Defects in the zip checker that this port closes (measured 2026-09-23):
# - cwd resolution. The zip resolves a relative packet against the caller
#   cwd, so `sh /path/to/check-readiness.sh notes/packet.md` from /tmp says
#   "not found". Here a relative packet is resolved against <root> only.
# - SIGN-OFF accepted the substring "sign", so a sign-off that only says
#   "design" passed. It now needs the whole word "signed" or "sign-off".
# - SOTA passed on the bare word "version". It now needs the whole word
#   "commit" or "sha".
# - Scan set. When <packet> resolves to a directory, every *.md in it that
#   carries a <!-- CHECK: marker is a packet. A directory with no such file
#   is NOT READY ("empty scan set"), never a vacuous READY.
#
# What it checks: section markers, >= N real content lines per section (blank
# lines, "> " guidance and HTML comments do not count), no line repeated 3+
# times, per-section vocabulary, and a dated sign-off. It cannot check that
# the prose is true; independent review is the semantic backstop.
#
# Usage: check-readiness.sh <packet.md|packet-dir> <root>
#        check-readiness.sh --selftest
#        KIT_MIN_LINES=3 overrides the floor for sections without a spec.
# Exit 0: READY. Exit 1: NOT READY. Exit 2: usage error.
set -u

MIN_LINES="${KIT_MIN_LINES:-3}"

case "$0" in
  /*) SELF=$0 ;;
  *)  SELF=$(pwd)/$0 ;;
esac

# The shell running this script; selftest sub-runs reuse it.
self_sh() {
  if [ -n "${KIT_SH:-}" ]; then printf '%s\n' "$KIT_SH"; return; fi
  if [ -n "${BASH:-}" ]; then printf '%s\n' "$BASH"; return; fi
  c=$(ps -p $$ -o comm= 2>/dev/null | sed 's/^-//')
  if [ -n "$c" ] && p=$(command -v "$c" 2>/dev/null) && [ -n "$p" ]; then
    printf '%s\n' "$p"
    return
  fi
  printf '%s\n' /bin/sh
}

# section_spec <marker>: line 1 = minimum content lines; line 2 = need|kw,...
# At least `need` keywords must appear (case-insensitive); "w:" = whole word.
section_spec() {
  case "$1" in
    *PROBLEM*)          printf '3\n0|\n' ;;
    *NON-GOALS*)        printf '3\n1|w:not,w:never,w:no,out of scope,will not,won'"'"'t,does not\n' ;;
    *SOTA*)             printf '3\n1|w:commit,w:sha\n' ;;
    *PACKETS*)          printf '3\n5|goal,anchor,target,oracle,fixture,risk,acceptance\n' ;;
    *CLAIM-INVENTORY*)  printf '3\n1|planned,claims.tsv\n' ;;
    *EVIDENCE-DESIGN*)  printf '3\n2|commit,version,host,worker\n' ;;
    *HONESTY-MACHINERY*) printf '3\n2|ledger,demot,resurrect,predicate\n' ;;
    *PROOF-TAXONOMY*)   printf '3\n1|non-proof,non_proof\n' ;;
    *RELEASE-GATE*)     printf '3\n1|waiv\n' ;;
    *EXIT-CRITERIA*)    printf '3\n2|exit,entry\n' ;;
    *REVIEW*)           printf '3\n1|chang\n' ;;
    *SIGN-OFF*)         printf '2\n1|w:signed,w:sign-off\n' ;;
    *)                  printf '%s\n0|\n' "$MIN_LINES" ;;
  esac
}

SECTIONS='<!-- CHECK: PROBLEM -->|problem statement
<!-- CHECK: NON-GOALS -->|non-goals ("what this is not")
<!-- CHECK: SOTA -->|state-of-the-art survey
<!-- CHECK: PACKETS -->|work packets
<!-- CHECK: CLAIM-INVENTORY -->|claim inventory
<!-- CHECK: EVIDENCE-DESIGN -->|evidence design
<!-- CHECK: HONESTY-MACHINERY -->|honesty machinery
<!-- CHECK: PROOF-TAXONOMY -->|proof taxonomy
<!-- CHECK: RELEASE-GATE -->|release gate
<!-- CHECK: EXIT-CRITERIA -->|phase exit criteria
<!-- CHECK: REVIEW -->|independent review
<!-- CHECK: SIGN-OFF -->|execution sign-off'

resolve() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *)  printf '%s\n' "$2/$1" ;;
  esac
}

check_packet() {
  PACKET=$1
  if [ ! -f "$PACKET" ]; then
    echo "NOT READY: $PACKET not found."
    echo "A relative packet path is resolved against <root>, never the caller cwd."
    return 1
  fi

  TMPD=$(mktemp -d "${TMPDIR:-/tmp}/kit-readiness.XXXXXX") || {
    echo "NOT READY: cannot create temp dir."
    return 1
  }
  SECF="$TMPD/section.txt"

  fail=0
  checked=0
  missing=""
  OLDIFS="$IFS"
  NL='
'
  IFS="$NL"
  for entry in $SECTIONS; do
    IFS="$OLDIFS"
    if [ -z "$entry" ]; then
      IFS="$NL"
      continue
    fi
    checked=$((checked + 1))
    marker="${entry%%|*}"
    label="${entry#*|}"
    : > "$SECF"

    if ! grep -qF -- "$marker" "$PACKET"; then
      missing="${missing}  - ${label}: marker ${marker} not found
"
      fail=1
      IFS="$NL"
      continue
    fi

    awk -v m="$marker" '
      /^## / { if (found) exit; next }
      /^<!-- CHECK:/ { if (found) exit; if (index($0, m)) found = 1; next }
      found { print }
    ' "$PACKET" | grep -v '^[[:space:]]*$' | grep -v '^[[:space:]]*>' | grep -v '^[[:space:]]*<!--' > "$SECF"

    spec=$(section_spec "$marker")
    min_lines=$(printf '%s\n' "$spec" | sed -n '1p')
    vocspec=$(printf '%s\n' "$spec" | sed -n '2p')
    need="${vocspec%%|*}"
    kws="${vocspec#*|}"

    n=$(wc -l < "$SECF" | tr -d ' ')
    if [ "$n" -lt "$min_lines" ]; then
      missing="${missing}  - ${label}: only ${n} content line(s); need >= ${min_lines} real (non-guidance) lines
"
      fail=1
      IFS="$NL"
      continue
    fi

    if tr '[:upper:]' '[:lower:]' < "$SECF" | tr -s ' \t' ' ' | grep -v '^ *$' \
        | sort | uniq -c | sort -rn | head -1 | grep -qE '^ *([3-9]|[1-9][0-9])'; then
      missing="${missing}  - ${label}: a line is repeated 3+ times; filler, not content
"
      fail=1
      IFS="$NL"
      continue
    fi

    if [ "$need" -gt 0 ] && [ -n "$kws" ]; then
      hits=0
      IFS=','
      for kw in $kws; do
        IFS="$OLDIFS"
        case "$kw" in
          w:*)
            w="${kw#w:}"
            if grep -qiE "(^|[^[:alnum:]_])${w}([^[:alnum:]_]|$)" "$SECF"; then
              hits=$((hits + 1))
            fi
            ;;
          *)
            if grep -qiF -- "$kw" "$SECF"; then
              hits=$((hits + 1))
            fi
            ;;
        esac
        IFS=','
      done
      IFS="$OLDIFS"
      if [ "$hits" -lt "$need" ]; then
        missing="${missing}  - ${label}: section vocabulary too thin (${hits}/${need} required terms: ${kws})
"
        fail=1
        IFS="$NL"
        continue
      fi
    fi

    case "$marker" in
      *SIGN-OFF*)
        if ! grep -qE '[0-9]{4}-[0-9]{2}-[0-9]{2}' "$SECF"; then
          missing="${missing}  - ${label}: sign-off must carry a date (YYYY-MM-DD)
"
          fail=1
        fi
        ;;
    esac
    IFS="$NL"
  done
  IFS="$OLDIFS"
  rm -rf "$TMPD"

  if [ "$checked" -ne 12 ]; then
    echo "NOT READY: $PACKET: checker evaluated $checked of 12 sections (internal section list is broken)."
    return 1
  fi
  if [ "$fail" -eq 0 ]; then
    echo "READY: $PACKET: all 12 planning-packet sections present with substance."
    return 0
  fi
  printf 'NOT READY: %s is missing/incomplete in:\n' "$PACKET"
  printf '%s' "$missing"
  return 1
}

check_target() {
  target=$(resolve "$1" "$2")
  if [ ! -d "$target" ]; then
    check_packet "$target"
    return $?
  fi
  # sh has no locals: check_packet uses n, fail, missing; keep distinct names.
  scanned=0
  scan_rc=0
  for scan_f in "$target"/*.md; do
    [ -f "$scan_f" ] || continue
    grep -qF -- '<!-- CHECK:' "$scan_f" || continue
    scanned=$((scanned + 1))
    check_packet "$scan_f" || scan_rc=1
  done
  if [ "$scanned" -eq 0 ]; then
    echo "NOT READY: empty scan set: no *.md with a <!-- CHECK: marker in $target"
    return 1
  fi
  echo "check-readiness: $scanned packet(s) scanned in $target"
  return $scan_rc
}

# Selftest fixtures ---------------------------------------------------------

# write_packet <file> [omit-marker]: 11 filled sections, SIGN-OFF appended by
# the caller. A section whose marker contains <omit-marker> is left out.
write_packet() {
  omit=${2:-NONE}
  skipping=0
  : > "$1"
  while IFS= read -r line; do
    case "$line" in
      "<!-- CHECK: "*) skipping=0
        case "$line" in *"$omit"*) skipping=1 ;; esac ;;
    esac
    [ "$skipping" -eq 1 ] && continue
    printf '%s\n' "$line" >> "$1"
  done << 'EOF'
<!-- CHECK: PROBLEM -->
Agents claim capabilities the repo cannot prove.
Claims drift from the README over time.
Nothing blocks a release on an unproven claim.
<!-- CHECK: NON-GOALS -->
This will not rank models.
It never edits proof artifacts.
It does not publish anything.
<!-- CHECK: SOTA -->
Pinned at commit abcdef1.
The sha is recorded in the ledger.
The incumbent is named.
<!-- CHECK: PACKETS -->
goal anchor target oracle fixture risk acceptance are the fields.
Second line of the packet body.
Third line of the packet body.
<!-- CHECK: CLAIM-INVENTORY -->
planned claims live in claims.tsv.
Second inventory line.
Third inventory line.
<!-- CHECK: EVIDENCE-DESIGN -->
Receipts record commit and version.
They also name the host.
Third evidence line.
<!-- CHECK: HONESTY-MACHINERY -->
The ledger has a retry predicate.
Demotion is written down.
Resurrection is a cadence, not a rumor.
<!-- CHECK: PROOF-TAXONOMY -->
The non-proof list is explicit.
Second taxonomy line.
Third taxonomy line.
<!-- CHECK: RELEASE-GATE -->
A waiver must be public.
Second release line.
Third release line.
<!-- CHECK: EXIT-CRITERIA -->
Phase entry is this packet.
Phase exit is the checker.
Third exit line.
<!-- CHECK: REVIEW -->
Nothing was changed by review.
Second review line.
Third review line.
EOF
}

selftest() {
  sh_bin=$(self_sh)
  d=$(mktemp -d "${TMPDIR:-/tmp}/kit-readiness-selftest.XXXXXX") || {
    echo "SELFTEST_FAIL: cannot make temp dir"
    exit 1
  }
  trap 'rm -rf "$d"' EXIT INT TERM
  run() { "$sh_bin" "$SELF" "$@"; }
  echo "selftest shell: $sh_bin (BASH_VERSION=${BASH_VERSION:-none})"
  mkdir -p "$d/root/plans" "$d/elsewhere" "$d/decoy" "$d/emptyroot" "$d/root/noscan"

  signoff() { printf '<!-- CHECK: SIGN-OFF -->\n%s\n%s\n' "$1" "$2"; }

  write_packet "$d/root/plans/design.md"
  signoff 'The design review happened on 2026-09-23.' 'The design board accepted the date.' >> "$d/root/plans/design.md"
  write_packet "$d/root/plans/signed.md"
  signoff 'Signed as draft: pane, 2026-09-23.' 'No execution is authorized.' >> "$d/root/plans/signed.md"
  write_packet "$d/root/plans/signoff.md"
  signoff 'Sign-off recorded: pane, 2026-09-23.' 'No execution is authorized.' >> "$d/root/plans/signoff.md"
  write_packet "$d/root/plans/noreview.md" REVIEW
  signoff 'Signed as draft: pane, 2026-09-23.' 'No execution is authorized.' >> "$d/root/plans/noreview.md"
  cp "$d/root/plans/signed.md" "$d/decoy/packet.md"

  # Arm 1: relative packet, cwd elsewhere, resolved against <root>.
  if ! out=$(cd "$d/elsewhere" && run plans/signed.md "$d/root" 2>&1); then
    echo "SELFTEST_FAIL: relative packet was not resolved against root from another cwd"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"READY: $d/root/plans/signed.md"*) ;;
    *) echo "SELFTEST_FAIL: READY did not name the root-resolved path"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM relative-path-uses-root: $out"
  # Arm 1b: a READY packet at the same relative path in cwd must not be used.
  if out=$(cd "$d/decoy" && run packet.md "$d/emptyroot" 2>&1); then
    echo "SELFTEST_FAIL: relative packet resolved against the caller cwd"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"$d/emptyroot/packet.md not found"*) ;;
    *) echo "SELFTEST_FAIL: not-found RED did not name the root-resolved path"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM cwd-decoy-ignored: $(printf '%s\n' "$out" | sed -n 1p)"

  # Arm 2: sign-off that only says "design" is RED and names the sign-off.
  if out=$(run plans/design.md "$d/root" 2>&1); then
    echo "SELFTEST_FAIL: design-only sign-off was accepted"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"execution sign-off: section vocabulary too thin"*) ;;
    *) echo "SELFTEST_FAIL: RED did not name the sign-off"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM design-only-signoff: RED: $(printf '%s\n' "$out" | grep 'execution sign-off')"
  # Arm 2b: "signed" and "sign-off" both pass.
  for f in signed signoff; do
    if ! out=$(run "plans/$f.md" "$d/root" 2>&1); then
      echo "SELFTEST_FAIL: sign-off wording in $f.md was refused"
      printf '%s\n' "$out"
      exit 1
    fi
    echo "ARM signoff-word-$f: $out"
  done

  # Arm 3: a missing section is RED and names it.
  if out=$(run plans/noreview.md "$d/root" 2>&1); then
    echo "SELFTEST_FAIL: packet without the REVIEW section was accepted"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"independent review: marker <!-- CHECK: REVIEW --> not found"*) ;;
    *) echo "SELFTEST_FAIL: missing-section RED did not name REVIEW"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM missing-section: RED: $(printf '%s\n' "$out" | grep 'independent review')"

  # Arm 4: an empty scan set is RED, not a vacuous READY.
  printf '# notes\nno markers here\n' > "$d/root/noscan/notes.md"
  if out=$(run noscan "$d/root" 2>&1); then
    echo "SELFTEST_FAIL: empty scan set was accepted"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"empty scan set"*"$d/root/noscan"*) ;;
    *) echo "SELFTEST_FAIL: empty-scan RED did not say so"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM empty-scan-set: RED: $out"
  # Arm 4b: a non-empty scan set with one bad packet is RED and names it.
  if out=$(run plans "$d/root" 2>&1); then
    echo "SELFTEST_FAIL: scan set containing bad packets was accepted"
    printf '%s\n' "$out"
    exit 1
  fi
  case "$out" in
    *"NOT READY: $d/root/plans/design.md"*"4 packet(s) scanned"*) ;;
    *) echo "SELFTEST_FAIL: scan-set RED did not name design.md over 4 packets"; printf '%s\n' "$out"; exit 1 ;;
  esac
  echo "ARM scan-set-names-bad-packet: $(printf '%s\n' "$out" | grep 'packet(s) scanned')"

  echo "SELFTEST_PASS: relative path uses root not cwd, design-only sign-off refused, signed and sign-off passed, missing section refused, empty scan set refused"
  exit 0
}

case "${1:-}" in
  --selftest) selftest ;;
esac

if [ $# -ne 2 ]; then
  echo "usage: $0 <packet.md|packet-dir> <root> | --selftest" >&2
  exit 2
fi
check_target "$1" "$2"
