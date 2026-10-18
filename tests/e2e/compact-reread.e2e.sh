#!/bin/sh
# compact-reread e2e (ompkit-xa5s.24 AC4): the native leg of the
# post-compaction reread gate in extensions/kit-flywheel-guard.ts.
#
# Starts one owned `omp --mode=rpc --no-extensions -e <guard>` child with its
# own --session-dir, in a fixture project under the work dir, and proves:
#   1. after compaction a write is BLOCKED with the COMPACTION_REREAD reason;
#   2. planted negative: reading AGENTS.md plus PLAIN-TEXT `br show` keeps it blocked;
#   3. `br show <id> --json` (fake br in a private bin dir, called by path) clears it; the write is allowed.
# It records false blocks (pre-compaction writes refused) and startup ms.
#
# Usage: sh tests/e2e/compact-reread.e2e.sh [--work-dir ABS] [--guard ABS.ts]
#   --work-dir: scratch root (default <repo>/var/agent-tmp/compact-reread.<pid>,
#               with an .owner file); everything stays beneath it.
#   --guard:    guard source to load (default <repo>/extensions/kit-flywheel-guard.ts).
# Env: OMP_E2E_PROFILE, OMP_E2E_MODEL pass --profile / --model to omp (optional).
# Needs omp, bun, git. Real model turns: costs tokens, takes minutes.
#
# Exit: 0 PASS; 1 FAIL; 2 usage error; 77 SKIP (omp or bun absent).

set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK=""
GUARD="$REPO/extensions/kit-flywheel-guard.ts"

while [ $# -gt 0 ]; do
	case "$1" in
		--work-dir) WORK="${2:?--work-dir needs a value}"; shift 2 ;;
		--guard) GUARD="${2:?--guard needs a value}"; shift 2 ;;
		*) echo "usage: $0 [--work-dir ABS] [--guard ABS.ts]" >&2; exit 2 ;;
	esac
done

for bin in omp bun git; do
	if ! command -v "$bin" >/dev/null 2>&1; then
		printf '{"result":"SKIP","reason":"%s not on PATH"}\n' "$bin"
		exit 77
	fi
done

if [ -z "$WORK" ]; then
	WORK="$REPO/var/agent-tmp/compact-reread.$$"
	mkdir -p "$WORK" || exit 2
	printf '{"pid":%d,"label":"compact-reread","repo":"%s","created":"%s"}\n' \
		"$$" "$REPO" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$WORK/.owner"
fi
case "$WORK" in /*) ;; *) echo "e2e needs an absolute --work-dir" >&2; exit 2 ;; esac
case "$GUARD" in /*) ;; *) echo "--guard must be absolute" >&2; exit 2 ;; esac
[ -f "$GUARD" ] || { echo "missing guard: $GUARD" >&2; exit 2; }
mkdir -p "$WORK/bin" "$WORK/proj" || exit 2
export TMPDIR="$WORK"

# Fake br: JSON row only under --json; plain text otherwise (the planted negative).
cat >"$WORK/bin/br" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$(dirname "$0")/br.calls"
json=0
for a in "$@"; do [ "$a" = "--json" ] && json=1; done
case "$1" in
	show)
		if [ "$json" = 1 ]; then
			printf '[{"id":"%s","title":"native probe bead","status":"in_progress","assignee":"NativeProbe"}]\n' "$2"
		else
			printf '%s  [in_progress]  native probe bead\nAssignee: NativeProbe\n' "$2"
		fi ;;
	list) if [ "$json" = 1 ]; then echo '{"issues":[]}'; else echo 'No issues found.'; fi ;;
	*) echo "fake br: unsupported: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$WORK/bin/br"
: >"$WORK/bin/br.calls"

cat >"$WORK/proj/AGENTS.md" <<'EOF'
# Fixture AGENTS.md
Rule: you are NativeProbe. Edits to target.txt are allowed only after rereading this file.
EOF
i=1
: >"$WORK/proj/big.txt"
while [ "$i" -le 400 ]; do
	echo "filler line $i: the quick brown fox jumps over the lazy dog to pad the session for compaction" >>"$WORK/proj/big.txt"
	i=$((i + 1))
done
[ -d "$WORK/proj/.git" ] || git -C "$WORK/proj" init -q || exit 2

PATH="$WORK/bin:$PATH" nice -n 10 bun "$REPO/tests/e2e/compact-reread.drive.ts" "$WORK" "$GUARD" "$WORK/bin/br"
rc=$?
[ "$rc" = 0 ] || rc=1
exit "$rc"
