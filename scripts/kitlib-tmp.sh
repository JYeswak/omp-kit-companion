# shellcheck shell=sh
# kitlib tmp: the kit's one owned-temp-dir primitive for POSIX sh (ompkit-41l85, KITLIB-TMP v1).
#
# J-2026-10-22-06: 77,299 leaked temp dirs (88 GB) came from kit tests and
# scripts that made a temp dir and never removed it, or removed it only on a
# normal exit. This file is the sh third of a three-language contract;
# src/kitlib/tmp.ts and scripts/kitlib_tmp.py are the other two, and all three
# pass the one conformance corpus tests/fixtures/kitlib-tmp/corpus.json.
#
# Source it, never execute it:
#
#   . "$KITLIB/kitlib-tmp.sh"
#   kitlib_tmp work my-label || exit 1     # $work is now the owned dir
#   kitlib_tmp_atexit 'printf "done\n"'    # extra exit work (kitlib owns the traps)
#   kitlib_tmp_cleanup "$work"             # optional early removal; idempotent
#
# NEVER call kitlib_tmp as work=$(kitlib_tmp ...): the dir and its traps would
# belong to the $(...) subshell, whose exit removes the dir at once. kitlib_tmp
# assigns the path to the named variable in the CURRENT shell instead.
#
# The dir is <root>/<label>.<pid>.<6 random [a-z0-9]>, mode 0700, where <root>
# is KITLIB_TMP_ROOT if set, else ${TMPDIR:-/tmp}, and must already exist.
# Labels match ^[a-z0-9][a-z0-9-]{0,47}$. The dir holds a .owner (mode 0600)
# in the key=value owner-record form src/scratch.ts parseOwnerFile accepts:
# pid, label, repo (the working directory), created (ISO time) and, when
# KITLIB_TMP_BEAD is set, bead -- the identity-free field set (see
# src/kitlib/tmp.ts). <pid> is $$, the sourcing shell.
#
# kitlib owns the EXIT, HUP, INT and TERM traps: do not set them yourself,
# register extra work with kitlib_tmp_atexit (it runs before the dirs go). On
# a normal exit the registry runs and the exit status is kept. On HUP, INT or
# TERM it runs, the trap is reset to the default and the signal re-sent to $$,
# so the shell still dies of that signal (status 128+signum, e.g. 143 for
# TERM). A trap runs only once the foreground command returns. SIGKILL cannot
# be caught: the dir survives with its .owner, which is what the reaper reads.
# A temp FILE goes inside an owned dir; there is no separate file API. Removal
# that fails (a 0555 dir inside, as installs make releases/<v>) is retried once
# after chmod -R u+rwx on the owned dir, which never follows symlinks inside.
#
# KITLIB_TMP_AUTO_CLEANUP=0 kitlib_tmp VAR LABEL (ompkit-b3zgu) is for a dir that must outlive the shell: the same
# dir and .owner, but no trap is installed for it and it never enters the exit registry. kitlib_tmp_cleanup still
# removes it on demand; after a crash the scratch reaper reads its .owner (dead pid, no open fds) like any other.
#
# Shells: /bin/sh, dash, bash (POSIX function and trap semantics). zsh is refused: it scopes an EXIT trap set in
# a function to that function. Names: public kitlib_tmp*, private kitlib__tmp_*; state lives in
# KITLIB__TMP_DIRS, KITLIB__TMP_KEPT (auto-cleanup off) and KITLIB__TMP_ATEXIT (newline-separated).

KITLIB__TMP_DIRS=
KITLIB__TMP_KEPT=
KITLIB__TMP_ATEXIT=
KITLIB__TMP_NL='
'
# a-z plus 0-9 (KITLIB__TMP_LOWER) and with A-Z (KITLIB__TMP_ALNUM), spelled out for bracket patterns.
KITLIB__TMP_LOWER=abcdefghijklmnopqrstuvwxyz0123456789
KITLIB__TMP_ALNUM=ABCDEFGHIJKLMNOPQRSTUVWXYZ$KITLIB__TMP_LOWER

# A tree holding a non-writable dir (an install's 0555 releases/<v>) cannot be emptied, so on failure give the
# owner rwx on everything inside and retry once. POSIX chmod -R does not follow symlinks met while walking.
kitlib__tmp_remove() {
	rm -rf -- "$1" 2>/dev/null && return 0
	chmod -R u+rwx -- "$1" 2>/dev/null || :
	rm -rf -- "$1"
}

kitlib__tmp_run_registry() {
	kitlib__tmp_cmds=$KITLIB__TMP_ATEXIT
	KITLIB__TMP_ATEXIT=
	kitlib__tmp_ifs=$IFS
	IFS=$KITLIB__TMP_NL
	for kitlib__tmp_cmd in $kitlib__tmp_cmds; do
		IFS=$kitlib__tmp_ifs
		eval "$kitlib__tmp_cmd" || :
		IFS=$KITLIB__TMP_NL
	done
	kitlib__tmp_dirs=$KITLIB__TMP_DIRS
	KITLIB__TMP_DIRS=
	for kitlib__tmp_dir in $kitlib__tmp_dirs; do
		kitlib__tmp_remove "$kitlib__tmp_dir" || :
	done
	IFS=$kitlib__tmp_ifs
}

kitlib__tmp_on_exit() {
	kitlib__tmp_status=$?
	kitlib__tmp_run_registry
	exit "$kitlib__tmp_status"
}

kitlib__tmp_on_signal() {
	# Retain EXIT so EOF reaches Bash's deferred-signal checkpoint after this trap returns.
	trap - HUP INT TERM
	kitlib__tmp_run_registry
	kill -s "$1" "$$"
}

kitlib__tmp_install_traps() {
	# zsh scopes an EXIT trap set in a function to that function, so the dir would vanish on return; refuse it.
	if [ -n "${ZSH_VERSION:-}" ]; then
		printf "kitlib tmp: zsh is not supported; source this file from /bin/sh, dash or bash\n" >&2
		return 2
	fi
	trap 'kitlib__tmp_on_exit' EXIT
	trap 'kitlib__tmp_on_signal HUP' HUP
	trap 'kitlib__tmp_on_signal INT' INT
	trap 'kitlib__tmp_on_signal TERM' TERM
}

kitlib__tmp_bad_label() {
	printf "kitlib tmp: label '%s' is invalid; want ^[a-z0-9][a-z0-9-]{0,47}\$\n" "$1" >&2
}

kitlib__tmp_suffix() {
	# Bound entropy before filtering: inherited ignored SIGPIPE must not keep tr running.
	# Judge the six-character result, not the pipeline status (pipefail callers).
	kitlib__tmp_out=$(head -c 128 /dev/urandom | LC_ALL=C tr -dc 'a-z0-9' 2>/dev/null | head -c 6)
	case $kitlib__tmp_out in
		*[!$KITLIB__TMP_LOWER]*) return 1 ;;
	esac
	[ "${#kitlib__tmp_out}" -eq 6 ]
}

# kitlib_tmp VAR LABEL: create an owned dir and assign its path to VAR in this shell.
kitlib_tmp() {
	# Bracket ranges like [a-z] follow the locale's collation in some shells; spell the sets out.
	case $1 in
		''|[0123456789]*|*[!_$KITLIB__TMP_ALNUM]*) printf "kitlib tmp: variable name '%s' is invalid\n" "$1" >&2; return 2 ;;
	esac
	case $2 in
		[$KITLIB__TMP_LOWER]*) ;;
		*) kitlib__tmp_bad_label "$2"; return 2 ;;
	esac
	case $2 in
		*[!$KITLIB__TMP_LOWER-]*) kitlib__tmp_bad_label "$2"; return 2 ;;
	esac
	if [ "${#2}" -gt 48 ]; then
		kitlib__tmp_bad_label "$2"
		return 2
	fi
	if [ -n "${KITLIB_TMP_BEAD:-}" ]; then
		case $KITLIB_TMP_BEAD in
			[$KITLIB__TMP_ALNUM]*) ;;
			*) printf "kitlib tmp: bead '%s' is invalid\n" "$KITLIB_TMP_BEAD" >&2; return 2 ;;
		esac
		case $KITLIB_TMP_BEAD in
			*[!$KITLIB__TMP_ALNUM._-]*) printf "kitlib tmp: bead '%s' is invalid\n" "$KITLIB_TMP_BEAD" >&2; return 2 ;;
		esac
		if [ "${#KITLIB_TMP_BEAD}" -gt 64 ]; then
			printf "kitlib tmp: bead '%s' is invalid\n" "$KITLIB_TMP_BEAD" >&2
			return 2
		fi
	fi
	kitlib__tmp_root=${KITLIB_TMP_ROOT:-${TMPDIR:-/tmp}}
	kitlib__tmp_root=${kitlib__tmp_root%/}
	[ -n "$kitlib__tmp_root" ] || kitlib__tmp_root=/
	case $kitlib__tmp_root in
		*"$KITLIB__TMP_NL"*) printf "kitlib tmp: root holds a newline\n" >&2; return 2 ;;
	esac
	if [ ! -d "$kitlib__tmp_root" ]; then
		printf "kitlib tmp: root '%s' is not a directory\n" "$kitlib__tmp_root" >&2
		return 2
	fi
	case ${KITLIB_TMP_AUTO_CLEANUP:-1} in
		0) kitlib__tmp_auto= ;;
		1) kitlib__tmp_auto=1 ;;
		*) printf "kitlib tmp: KITLIB_TMP_AUTO_CLEANUP '%s' is invalid; want 0 or 1\n" "$KITLIB_TMP_AUTO_CLEANUP" >&2; return 2 ;;
	esac
	if [ -n "$kitlib__tmp_auto" ]; then
		kitlib__tmp_install_traps || return 2
	fi
	kitlib__tmp_path=
	kitlib__tmp_try=0
	while [ "$kitlib__tmp_try" -lt 16 ]; do
		kitlib__tmp_try=$((kitlib__tmp_try + 1))
		kitlib__tmp_suffix || continue
		kitlib__tmp_candidate=$kitlib__tmp_root/$2.$$.$kitlib__tmp_out
		if mkdir -m 0700 -- "$kitlib__tmp_candidate" 2>/dev/null; then
			kitlib__tmp_path=$kitlib__tmp_candidate
			break
		fi
	done
	if [ -z "$kitlib__tmp_path" ]; then
		printf "kitlib tmp: could not create a dir for label '%s' under '%s'\n" "$2" "$kitlib__tmp_root" >&2
		return 1
	fi
	if [ -n "$kitlib__tmp_auto" ]; then
		KITLIB__TMP_DIRS=$KITLIB__TMP_DIRS$kitlib__tmp_path$KITLIB__TMP_NL
	else
		KITLIB__TMP_KEPT=$KITLIB__TMP_KEPT$kitlib__tmp_path$KITLIB__TMP_NL
	fi
	kitlib__tmp_repo=$(pwd 2>/dev/null) || kitlib__tmp_repo=/
	case $kitlib__tmp_repo in
		/*) ;;
		*) kitlib__tmp_repo=/ ;;
	esac
	case $kitlib__tmp_repo in
		*"$KITLIB__TMP_NL"*|*"$(printf '\t')"*|*"$(printf '\r')"*) kitlib__tmp_repo=/ ;;
	esac
	kitlib__tmp_created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	if ! (
		umask 077 &&
		set -C &&
		{
			printf 'pid=%s\nlabel=%s\nrepo=%s\ncreated=%s\n' "$$" "$2" "$kitlib__tmp_repo" "$kitlib__tmp_created"
			[ -z "${KITLIB_TMP_BEAD:-}" ] || printf 'bead=%s\n' "$KITLIB_TMP_BEAD"
		} >"$kitlib__tmp_path/.owner"
	); then
		kitlib_tmp_cleanup "$kitlib__tmp_path"
		printf "kitlib tmp: could not write '%s/.owner'\n" "$kitlib__tmp_path" >&2
		return 1
	fi
	chmod 0600 "$kitlib__tmp_path/.owner"
	eval "$1=\$kitlib__tmp_path"
}

# kitlib_tmp_cleanup PATH: remove one owned dir now (auto-cleanup on or off); a no-op for a path already removed.
# Returns non-zero (and keeps PATH registered where it was) when the tree still cannot be removed.
kitlib_tmp_cleanup() {
	kitlib__tmp_keep=
	kitlib__tmp_found=
	kitlib__tmp_ifs=$IFS
	IFS=$KITLIB__TMP_NL
	for kitlib__tmp_dir in $KITLIB__TMP_DIRS; do
		if [ "$kitlib__tmp_dir" = "$1" ]; then
			kitlib__tmp_found=dirs
		else
			kitlib__tmp_keep=$kitlib__tmp_keep$kitlib__tmp_dir$KITLIB__TMP_NL
		fi
	done
	KITLIB__TMP_DIRS=$kitlib__tmp_keep
	kitlib__tmp_keep=
	for kitlib__tmp_dir in $KITLIB__TMP_KEPT; do
		if [ "$kitlib__tmp_dir" = "$1" ]; then
			kitlib__tmp_found=kept
		else
			kitlib__tmp_keep=$kitlib__tmp_keep$kitlib__tmp_dir$KITLIB__TMP_NL
		fi
	done
	KITLIB__TMP_KEPT=$kitlib__tmp_keep
	IFS=$kitlib__tmp_ifs
	[ -n "$kitlib__tmp_found" ] || return 0
	kitlib__tmp_remove "$1" && return 0
	if [ "$kitlib__tmp_found" = kept ]; then
		KITLIB__TMP_KEPT=$KITLIB__TMP_KEPT$1$KITLIB__TMP_NL
	else
		KITLIB__TMP_DIRS=$KITLIB__TMP_DIRS$1$KITLIB__TMP_NL
	fi
	return 1
}

# kitlib_tmp_atexit 'CMD': run CMD (eval'd, one line) at exit or on HUP/INT/TERM, before the dirs are removed.
kitlib_tmp_atexit() {
	case $1 in
		*"$KITLIB__TMP_NL"*) printf "kitlib tmp: atexit command must be one line\n" >&2; return 2 ;;
	esac
	kitlib__tmp_install_traps || return 2
	KITLIB__TMP_ATEXIT=$KITLIB__TMP_ATEXIT$1$KITLIB__TMP_NL
}
