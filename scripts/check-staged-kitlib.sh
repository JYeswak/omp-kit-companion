#!/bin/sh
# check-staged-kitlib.sh — pre-commit member (ompkit-qwqh1, KITLIB-RATCHET).
# Staged .py/.ts/.tsx/.js/.mjs/.cjs/.sh/.bash files (and extensionless sh or
# python scripts) must add no new hand-rolled copy of a kitlib primitive, as
# judged by scripts/kitlib_ratchet.py. Rule raw-spawn: subprocess.run & co,
# os.system/popen/spawn*/exec*, asyncio.create_subprocess_*, Bun.spawn,
# child_process spawn/exec/fork and a call-site `timeout N cmd` spawn with no
# deadline, group cancel or output cap. Use kitlib_run.run
# (scripts/kitlib_run.py) or run() (src/kitlib/run.ts), or justify the line
# inline with "kitlib: <reason>".
# Judges the index git is about to commit (GIT_INDEX_FILE is respected, so
# `git commit --only` temporary indexes are judged) against HEAD: a finding is
# new when its (rule, line text) occurs more often than in HEAD, so untouched
# pre-existing sites never block and new ones always do. The checker runs
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
staged=$(git diff --cached --name-only --diff-filter=AMRT) || { printf 'staged-kitlib: cannot list staged paths\n' >&2; exit 1; }
printf '%s\n' "$staged" | grep -Eq '\.(py|ts|tsx|js|mjs|cjs|sh|bash)$|(^|/)\.?[^/.]+$' || exit 0
py=$(command -v python3) || { printf 'staged-kitlib: REFUSED: judged files are staged and python3 is absent\n' >&2; exit 1; }
"$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' < /dev/null ||
	{ printf 'staged-kitlib: REFUSED: python3 >= 3.9 is required to judge staged files\n' >&2; exit 1; }
for helper in pysafe.py kitlib_ratchet_core.py kitlib_ratchet.py; do
	[ -f "$here/$helper" ] || { printf 'staged-kitlib: REFUSED: %s is missing beside %s; rerun the kit hook installer\n' "$helper" "$0" >&2; exit 1; }
done
out=$("$py" -B "$here/pysafe.py" run --timeout "$budget" -- "$py" -B "$here/kitlib_ratchet.py" --staged --repo "$root" < /dev/null 2>&1)
rc=$?
case "$rc" in
	0) exit 0 ;;
	1) printf 'staged-kitlib: REFUSED: staged files hand-roll a kitlib primitive (spawn through kitlib_run.run from scripts/kitlib_run.py or run() from src/kitlib/run.ts; or justify the line inline with "kitlib: <reason>")\n%s\n' "$out" >&2 ;;
	124) printf 'staged-kitlib: REFUSED: the checker exceeded %s s and was killed\n%s\n' "$budget" "$out" >&2 ;;
	*) printf 'staged-kitlib: REFUSED: the checker failed (exit %s)\n%s\n' "$rc" "$out" >&2 ;;
esac
exit 1
