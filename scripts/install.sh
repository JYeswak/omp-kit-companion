#!/bin/sh
# install.sh [--dry-run] [--target DIR] [--state DIR]
#
# Installs the managed rules listed in MANIFEST.tsv into the target rule root.
#   --target DIR  rule root omp loads (default ~/.agents/rules)
#   --state  DIR  backups and install record (default ~/.local/state/omp-kit);
#                 must not be inside the target: any *.md there loads as a rule
#   --dry-run     print the plan, write nothing
#
# Refuses unless `build-manifest.sh --check` passes. When anything changes, every file in
# the target is first copied to STATE/backups/<UTC>/. Each rule is installed atomically
# (copy to a non-.md temp name in the target, then rename). Target files named in retired/
# are removed (after the backup). Unknown files are left in place and listed.
# STATE/installed.tsv records name, sha256, pack, UTC time. A second run changes nothing.
set -eu
LC_ALL=C
export LC_ALL

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="$ROOT/MANIFEST.tsv"
target="$HOME/.agents/rules"
state="$HOME/.local/state/omp-kit"
dry=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --target) [ $# -ge 2 ] || { echo "install: --target needs a value" >&2; exit 2; }; target=$2; shift ;;
    --state) [ $# -ge 2 ] || { echo "install: --state needs a value" >&2; exit 2; }; state=$2; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "install: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
say() { if [ "$dry" = 1 ]; then echo "[dry-run] $*"; else echo "$*"; fi; }

# Absolute path of a directory that may not exist yet (resolves the deepest existing parent).
abspath() {
  p=$1 rest=
  while [ ! -d "$p" ]; do
    rest="/$(basename "$p")$rest"
    p=$(dirname "$p")
  done
  echo "$(cd "$p" && pwd -P)$rest"
}

if ! sh "$ROOT/scripts/build-manifest.sh" --check; then
  echo "install: REFUSED: MANIFEST.tsv does not match rules/; run scripts/build-manifest.sh" >&2
  exit 1
fi

target_abs=$(abspath "$target")
state_abs=$(abspath "$state")
case "$state_abs/" in
  "$target_abs"/*) echo "install: REFUSED: state dir $state_abs is inside target $target_abs" >&2; exit 2 ;;
esac

# Managed set: name TAB sha256 TAB pack
managed=$(awk -F'\t' 'NR > 1 { print $1 "\t" $2 "\t" $4 }' "$MANIFEST")
pack=$(printf '%s\n' "$managed" | sed -n '1p' | cut -f3)

is_managed() { printf '%s\n' "$managed" | cut -f1 | grep -qxF "$1"; }
is_retired() { [ -f "$ROOT/retired/$1.md" ]; }

# ---- plan ----
installs=''   # names to (re)install
removes=''    # target file names to retire
unmanaged=''  # target file names left alone
unchanged=0
nl='
'
for name in $(printf '%s\n' "$managed" | cut -f1); do
  want=$(printf '%s\n' "$managed" | awk -F'\t' -v n="$name" '$1 == n { print $2 }')
  if [ -f "$target/$name.md" ] && [ "$(sha256 "$target/$name.md")" = "$want" ]; then
    unchanged=$((unchanged + 1))
  else
    if [ -e "$target/$name.md" ]; then kind=update; else kind=new; fi
    installs="$installs$name $kind$nl"
  fi
done
if [ -d "$target" ]; then
  for f in "$target"/* "$target"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    b=$(basename "$f")
    case "$b" in
      *.md)
        n=${b%.md}
        if is_managed "$n"; then continue; fi
        if is_retired "$n"; then removes="$removes$b$nl"; continue; fi
        ;;
    esac
    unmanaged="$unmanaged$b$nl"
  done
fi

n_inst=$(printf '%s' "$installs" | grep -c . || true)
n_rm=$(printf '%s' "$removes" | grep -c . || true)

echo "install: target $target_abs"
echo "install: state  $state_abs"
echo "install: pack   $pack"
printf '%s' "$installs" | while read -r n k; do say "install $n.md ($k)"; done
printf '%s' "$removes" | while read -r b; do say "retire  $b (backed up, removed)"; done
printf '%s' "$unmanaged" | while read -r b; do echo "unmanaged (left in place): $b"; done
echo "install: plan: $n_inst to install, $n_rm to retire, $unchanged unchanged, $(printf '%s' "$unmanaged" | grep -c . || true) unmanaged"

# ---- install record (name, sha256, pack are the identity; time only moves on change) ----
record_body=$(printf '%s\n' "$managed")
record_current=0
if [ -f "$state/installed.tsv" ]; then
  have=$(awk -F'\t' 'NR > 1 { print $1 "\t" $2 "\t" $3 }' "$state/installed.tsv")
  [ "$have" = "$record_body" ] && record_current=1
fi

if [ "$n_inst" = 0 ] && [ "$n_rm" = 0 ] && [ "$record_current" = 1 ]; then
  echo "install: no changes"
  exit 0
fi

if [ "$dry" = 1 ]; then
  echo "[dry-run] would back up target to $state_abs/backups/<UTC>/ and write $state_abs/installed.tsv"
  echo "install: dry run, nothing written"
  exit 0
fi

# ---- apply ----
mkdir -p "$target" "$state/backups"
if [ "$n_inst" != 0 ] || [ "$n_rm" != 0 ]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  bdir="$state/backups/$stamp"
  i=1
  while [ -e "$bdir" ]; do bdir="$state/backups/$stamp.$i"; i=$((i + 1)); done
  mkdir -p "$bdir"
  for f in "$target"/* "$target"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    cp -Rp "$f" "$bdir/"
  done
  bcount=0
  for f in "$bdir"/* "$bdir"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    bcount=$((bcount + 1))
  done
  echo "install: backed up $bcount target files to $bdir"
fi

printf '%s' "$installs" | while read -r n k; do
  tmp="$target/.$n.omp-kit-tmp.$$"
  cp "$ROOT/rules/$n.md" "$tmp"
  mv -f "$tmp" "$target/$n.md"
  echo "installed $n.md ($k)"
done
printf '%s' "$removes" | while read -r b; do
  rm -f "$target/$b"
  echo "retired $b"
done

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
rec="$state/installed.tsv.tmp.$$"
printf 'name\tsha256\tpack\tinstalled_utc\n' > "$rec"
printf '%s\n' "$managed" | awk -F'\t' -v t="$now" '{ print $1 "\t" $2 "\t" $3 "\t" t }' >> "$rec"
mv -f "$rec" "$state/installed.tsv"
echo "install: wrote $state/installed.tsv"

# ---- verify ----
bad=0
for name in $(printf '%s\n' "$managed" | cut -f1); do
  want=$(printf '%s\n' "$managed" | awk -F'\t' -v n="$name" '$1 == n { print $2 }')
  if [ "$(sha256 "$target/$name.md" 2>/dev/null || echo missing)" != "$want" ]; then
    echo "install: VERIFY FAIL: $name.md" >&2; bad=1
  fi
done
[ "$bad" = 0 ] || exit 1
echo "install: done; $(printf '%s\n' "$managed" | grep -c .) managed rules verified by sha256"
