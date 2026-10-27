#!/bin/sh
# check-commit-kitlib-reversal.sh MSGFILE — validate named Revert authority for exact published-origin admissions.
set -u
msg=${1:?usage: check-commit-kitlib-reversal.sh MSGFILE}
if ! { [ -f "$msg" ] && [ -r "$msg" ]; }; then
	printf 'commit-kitlib-reversal: REFUSED: commit message is unreadable\n' >&2
	exit 1
fi
budget=${KITLIB_GATE_TIMEOUT:-60}
case "$budget" in
	'' | *[!0-9]* | 0) printf 'commit-kitlib-reversal: REFUSED: KITLIB_GATE_TIMEOUT must be a positive whole number of seconds\n' >&2; exit 1 ;;
esac
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || { printf 'commit-kitlib-reversal: cannot locate installed member\n' >&2; exit 1; }
helpers=$(CDPATH='' cd -- "$here/../pre-commit" && pwd -P) || { printf 'commit-kitlib-reversal: pre-commit ratchet helpers are missing\n' >&2; exit 1; }
for helper in pysafe.py kitlib_ratchet_core.py kitlib_ratchet.py; do
	[ -f "$helpers/$helper" ] || { printf 'commit-kitlib-reversal: REFUSED: %s is missing beside the pre-commit ratchet; reinstall the kit hooks\n' "$helper" >&2; exit 1; }
done
py=$(command -v python3) || { printf 'commit-kitlib-reversal: REFUSED: python3 is absent\n' >&2; exit 1; }
"$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' < /dev/null ||
	{ printf 'commit-kitlib-reversal: REFUSED: python3 >= 3.9 is required\n' >&2; exit 1; }
root=$(git rev-parse --show-toplevel) || { printf 'commit-kitlib-reversal: not inside a work tree\n' >&2; exit 1; }
out=$("$py" -B "$helpers/pysafe.py" run --timeout "$budget" -- "$py" -B "$helpers/kitlib_ratchet.py" \
	--verify-reversal-message "$msg" --repo "$root" < /dev/null 2>&1)
rc=$?
case "$rc" in
	0)
		printf '%s\n' "$out" | while IFS= read -r line; do
			case "$line" in kitlib-reversal:*) printf '%s\n' "$line" ;; esac
		done
		exit 0
		;;
	1) printf 'commit-kitlib-reversal: REFUSED: staged reversal did not satisfy native proof\n%s\n' "$out" >&2 ;;
	124) printf 'commit-kitlib-reversal: REFUSED: checker exceeded %s s and was killed\n%s\n' "$budget" "$out" >&2 ;;
	*) printf 'commit-kitlib-reversal: REFUSED: checker failed (exit %s)\n%s\n' "$rc" "$out" >&2 ;;
esac
exit 1
