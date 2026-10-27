#!/bin/sh
# check-staged-kitlib.sh — pre-commit member (ompkit-qwqh1, KITLIB-RATCHET).
# Staged .py/.ts/.tsx/.js/.mjs/.cjs/.sh/.bash files (and extensionless sh or
# python scripts) must add no new hand-rolled copy of a kitlib primitive, as
# judged by scripts/kitlib_ratchet.py. Rule raw-spawn: subprocess.run & co,
# os.system/popen/spawn*/exec*, asyncio.create_subprocess_*, Bun.spawn,
# child_process spawn/exec/fork and a call-site `timeout N cmd` spawn with no
# deadline, group cancel or output cap. Use kitlib_run.run
# (scripts/kitlib_run.py) or run() (src/kitlib/run.ts).
# Judges the index git is about to commit (GIT_INDEX_FILE is respected, so
# `git commit --only` temporary indexes are judged) against HEAD: a finding is
# new when its (rule, line text) occurs more often than in HEAD, so untouched
# pre-existing sites never block and new ones always do. Where the repo
# commits scripts/kitlib-ratchet-baseline.json (per-path site counts), a path
# over its count is refused, and so is a staged allowlist that raises a count,
# adds an entry or deletes the file (its zero state is empty counts); lowering
# or removing entries passes. There a
# "kitlib: <reason>" pragma documents an allowlisted site and admits no new
# one; a repo without the allowlist keeps the git ratchet alone, where the
# pragma suppresses. The checker runs
# under `pysafe.py run` with a process-group deadline, so this member cannot
# hang a commit. kitlib_ratchet.py, kitlib_ratchet_core.py (the engine it
# shares with tempsafe_check.py) and pysafe.py (the bounded-run library the
# engine imports; it never imports pysafe_check.py) sit beside this file (the
# installer copies them; in the companion and in a kit release they are its
# siblings in scripts/); if any is missing, or python3 is older than 3.9, the
# commit is refused rather than passed unjudged. Exit 1 refuses.
# KITLIB_GATE_TIMEOUT (whole seconds, default 60) sets the checker deadline.
set -u
budget=${KITLIB_GATE_TIMEOUT:-60}
case "$budget" in
	'' | *[!0-9]* | 0) printf 'staged-kitlib: REFUSED: KITLIB_GATE_TIMEOUT must be a positive whole number of seconds\n' >&2; exit 1 ;;
esac
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(git rev-parse --show-toplevel) || { printf 'staged-kitlib: not inside a work tree\n' >&2; exit 1; }
staged=$(git diff --cached --name-only --diff-filter=AMRTD) || { printf 'staged-kitlib: cannot list staged paths\n' >&2; exit 1; }
printf '%s\n' "$staged" | grep -Eq '\.(py|ts|tsx|js|mjs|cjs|sh|bash)$|(^|/)\.?[^/.]+$|^scripts/kitlib-ratchet-baseline\.json$' || exit 0
reversal_member="$here/../commit-msg/50-omp-kit-staged-kitlib-reversal"
py=$(command -v python3) || { printf 'staged-kitlib: REFUSED: judged files are staged and python3 is absent\n' >&2; exit 1; }
"$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' < /dev/null ||
	{ printf 'staged-kitlib: REFUSED: python3 >= 3.9 is required to judge staged files\n' >&2; exit 1; }
for helper in pysafe.py kitlib_ratchet_core.py kitlib_ratchet.py; do
	[ -f "$here/$helper" ] || { printf 'staged-kitlib: REFUSED: %s is missing beside %s; rerun the kit hook installer\n' "$helper" "$0" >&2; exit 1; }
done
out=$("$py" -B "$here/pysafe.py" run --timeout "$budget" -- "$py" -B "$here/kitlib_ratchet.py" --staged --repo "$root" < /dev/null 2>&1)
rc=$?
has_admission=0
case "$out" in
	*"ADMITTED incumbent raw-spawn entry matches exact staged path at origin/main@"*) has_admission=1 ;;
esac
printf '%s\n' "$out" | while IFS= read -r line; do
	case "$line" in
		*"ADMITTED incumbent raw-spawn entry matches exact staged path at origin/main@"*) printf '%s\n' "$line" ;;
	esac
done
case "$rc" in
	0)
		if [ "$has_admission" = 1 ] && [ ! -x "$reversal_member" ]; then
			printf 'staged-kitlib: REFUSED: commit-msg reversal validator is missing at %s; reinstall the kit hooks\n' "$reversal_member" >&2
			exit 1
		fi
		exit 0
		;;
	1) printf 'staged-kitlib: REFUSED: staged files hand-roll a kitlib primitive or raise scripts/kitlib-ratchet-baseline.json (spawn through kitlib_run.run from scripts/kitlib_run.py or run() from src/kitlib/run.ts; the allowlist only shrinks, and a "kitlib: <reason>" pragma admits no site it does not count)\n%s\n' "$out" >&2 ;;
	124) printf 'staged-kitlib: REFUSED: the checker exceeded %s s and was killed\n%s\n' "$budget" "$out" >&2 ;;
	*) printf 'staged-kitlib: REFUSED: the checker failed (exit %s)\n%s\n' "$rc" "$out" >&2 ;;
esac
exit 1
