#!/bin/sh
# pre-push-verification-level.sh — VLEVEL-PUSH1 (ompkit-2w7h.2).
# A push whose range holds a non-exempt commit with no verification level in
# its subject is refused, naming the sha and subject. The fleet's documented
# private-index landing (GIT_INDEX_FILE + hash-object + commit-tree) never runs
# the commit-msg hook, so commit-tree commits reach the push with no level
# unless a pre-push member judges the range. Merge, revert and fixup commits
# stay exempt, matching the paired commit-msg member
# (hooks.d/commit-msg/41-omp-kit-commit-msg-vlevel, canonical source
# scripts/commit-msg-verification-level.sh), which closes the same rule at
# commit time. VLEVELGAP1: the pre-push member alone only strands level-less
# commits at push, so --check refuses a repo with one member and not the other,
# and VLEVELDRIFT1: the installed chain member refuses every push while its
# paired commit-msg member is missing or differs from CM_SHA256.
#
# The level and exempt patterns below are byte-identical in intent to that
# hook's level_of()/exempt(): LEVELS=(pending selftest test mutation oracle
# live); a subject claims one via "[level]", "<level> pending|verified" or
# "<level>-level"; exempt subjects match ^(Merge |Revert |fixup! |squash! ).
# If the commit-msg hook changes, update both and re-run --selftest.
#
# Usage:
#   pre-push-verification-level.sh --repo DIR --base SHA --tip SHA
#       refuse (exit 4) when git rev-list TIP --not BASE holds a non-exempt
#       level-less commit. BASE is the exclusion floor (the remote sha).
#   pre-push-verification-level.sh --pre-push [<remote-name>] [--repo DIR]
#       pre-push hook body: read "<lref> <lsha> <rref> <rsha>" lines on stdin
#       and check each pushed range. Deletions pass; a zero remote sha (new
#       ref) is judged against the remote-tracking refs of <remote-name>.
#   pre-push-verification-level.sh --check [REPO]
#       both installed chain members (pre-push 41 and paired commit-msg 41)
#       present, executable and current (exit 3), like
#       install-commit-msg-bead.sh --check. Prints "hooks fresh" on pass.
#   pre-push-verification-level.sh --selftest
#       planted temp-repo proof: (a) level-less commit-tree push refused and
#       origin unchanged; (b) same with [pending] pushed; (c) levelless merge
#       pushed; (d) empty range passes; (e) --check refuses a repo with the
#       pre-push member but no paired commit-msg member; (f) --check passes
#       with both members fresh. A mutant with the member skipped fails
#       (a), proving the member is the catcher.
#       (g) GATE1-B: a pushed commit deleting the canonical gate source still
#       leaves a level-less tip refused (installed code judges, never pushed
#       content); a no-op'ed installed member passes (a), proving the
#       installed member is the authority.
#       (h) VLEVELDRIFT1: the installed chain member refuses a leveled push
#       when the paired commit-msg member is missing or stale and passes it
#       with both present; a mutant without the paired check passes the
#       missing case. All fixtures live under
#       "${TMPDIR:-/tmp}" and are removed on exit.
set -u

SELF=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")
MEMBER="hooks.d/pre-push/41-omp-kit-pushed-vlevel"
# Paired commit-msg member (VLEVELGAP1): the commit-time close for the same rule.
# Canonical source ships beside this file as commit-msg-verification-level.sh;
# CM_SHA256 pins its bytes so the installed member (no source beside it) can
# still judge the paired member stale. Re-pin when that source changes; the
# selftest refuses a pin that differs from the shipped source.
CM_MEMBER="hooks.d/commit-msg/41-omp-kit-commit-msg-vlevel"
CM_SHA256="07b3208b91f8b01f2966abeb1faf2493b5e4c938ae262d781da278c57a161b98"

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

paired_fresh() {
	# paired_fresh PATH: the paired commit-msg member exists, is executable
	# and carries the pinned canonical bytes; names the failure otherwise.
	if [ ! -x "$1" ]; then
		printf 'pre-push-verification-level: MISSING paired commit-msg member: %s (install executable copy of scripts/commit-msg-verification-level.sh)\n' "$1" >&2
		return 1
	fi
	if [ "$(sha256_of "$1")" != "$CM_SHA256" ]; then
		printf 'pre-push-verification-level: STALE paired commit-msg member: %s differs from canonical sha256 %s\n' "$1" "$CM_SHA256" >&2
		return 1
	fi
}

level_of() {
	# prints the level claimed by the subject, or nothing; mirrors
	# commit-msg-verification-level.sh level_of()
	subject="$1"
	for lv in pending selftest test mutation oracle live; do
		if printf '%s' "$subject" | grep -qiE "\[${lv}\]|\b${lv}[- ](pending|verified)\b|\b${lv}-level\b"; then
			printf '%s' "$lv"
			return 0
		fi
	done
	return 1
}

is_exempt() {
	# mirrors commit-msg-verification-level.sh exempt()
	printf '%s' "$1" | grep -qiE '^(Merge |Revert |fixup! |squash! )'
}

reviewed_commits() {
	# reviewed_commits REPO TIP RREF RSHA: PUSHADMIT1 (ompkit-fp72.120.16.221). With no reviewed plan copy
	# (<git-common-dir>/omp-kit/history-review/*.plan.json) return 3 and spawn nothing. Otherwise
	# ref-txn-witness.py push-admit decides: 3 keeps the ordinary range, 0 prints the range minus the
	# reviewed rewrite's mapped counterparts, anything else refuses the push.
	common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 3
	for plan in "$common"/omp-kit/history-review/*.plan.json; do
		[ -e "$plan" ] || return 3
		break
	done
	dir=${SELF%/*}
	for w in "$dir" "$dir/../reference-transaction"; do
		if [ -f "$w/ref-txn-witness.py" ]; then
			# A literal -c runner keeps the Python argv statically judged (staged-pysafe); the reader is cwd-bound to the repo.
			(CDPATH='' cd -- "$1" && python3 -B -c 'import runpy, sys; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")' "$w/ref-txn-witness.py" push-admit "$2" "$3" "$4" -- "$2" --not "$4")
			return $?
		fi
	done
	return 3
}

check_range() {
	# check_range REPO BASE TIP [RREF]: refuse when the range holds a non-exempt
	# level-less commit. Empty ranges pass. RREF (pre-push only) enables the
	# reviewed-rewrite route for a concrete remote sha BASE.
	repo="$1" base="$2" tip="$3" wrc=3
	if [ -n "${4:-}" ]; then
		commits=$(reviewed_commits "$repo" "$tip" "$4" "$base")
		wrc=$?
		if [ "$wrc" != "0" ] && [ "$wrc" != "3" ]; then
			printf 'pre-push-verification-level: REFUSED %s -> %s: a reviewed history plan claims this push and its witness refused (exit %s)\n' "$tip" "$4" "$wrc" >&2
			return 4
		fi
	fi
	if [ "$wrc" = "3" ]; then
		commits=$(git -C "$repo" rev-list "$tip" --not "$base" 2>/dev/null) || {
			printf 'pre-push-verification-level: cannot list range %s --not %s\n' "$tip" "$base" >&2
			return 2
		}
	fi
	for sha in $commits; do
		subject=$(git -C "$repo" log --format=%s -n 1 "$sha" 2>/dev/null) || {
			printf 'pre-push-verification-level: cannot read %s\n' "$sha" >&2
			return 2
		}
		if is_exempt "$subject"; then
			continue
		fi
		if level_of "$subject" >/dev/null 2>&1; then
			continue
		fi
		printf 'pre-push-verification-level: REFUSED %s subject=%s\n' "$sha" "$subject" >&2
		printf '  a pushed commit subject must say what it PROVED: [pending], [selftest], [test], [mutation], [oracle] or [live].\n' >&2
		printf '  merge, revert and fixup commits are exempt. Land private-index commits only after\n' >&2
		printf '  GIT_INDEX_FILE=<idx> git hook run commit-msg -- <msgfile> exits 0 for the same message.\n' >&2
		return 4
	done
	return 0
}

pre_push() {
	# pre_push REMOTE REPO: check every pushed range from stdin
	remote="${1:-origin}" repo="$2" rc=0 line=""
	# VLEVELDRIFT1: as an installed chain member, refuse the push while the
	# paired commit-msg member is missing or stale (the rule must close at
	# commit time too, not only strand commits here).
	case "$SELF" in
		*/hooks.d/pre-push/41-omp-kit-pushed-vlevel)
			paired_fresh "${SELF%/hooks.d/pre-push/*}/$CM_MEMBER" || {
				printf 'pre-push-verification-level: REFUSED push: repair with install-commit-msg-bead.sh, then push again\n' >&2
				return 4
			}
			;;
	esac
	while IFS= read -r line || [ -n "$line" ]; do
		# shellcheck disable=SC2086
		set -- $line
		[ $# -eq 4 ] || continue
		lsha="$2" rsha="$4" rref="$3"
		case "$lsha" in
			0000000000000000000000000000000000000000) continue ;; # deletion: nothing to judge
		esac
		case "$rsha" in
			0000000000000000000000000000000000000000)
				base="--remotes=$remote" rref=""
				;;
			*) base="$rsha" ;;
		esac
		# shellcheck disable=SC2086
		check_range "$repo" $base "$lsha" "$rref" || rc=$?
	done
	return "$rc"
}

do_check() {
	# do_check REPO: both members must exist, be executable and be current;
	# a repo with one member and not the other is refused (VLEVELGAP1: the
	# pre-push member alone only strands level-less commits at push; the
	# commit-msg member closes the same rule at commit time).
	# Mirrors installer --check language: MISSING / STALE / hooks fresh.
	repo="$1"
	hooks=$(git -C "$repo" rev-parse --git-path hooks 2>/dev/null) || {
		printf 'pre-push-verification-level: %s is not a git repo\n' "$repo" >&2
		return 2
	}
	case "$hooks" in /*) ;; *) hooks="$repo/$hooks" ;; esac
	dest="$hooks/$MEMBER"
	stale=0
	if [ ! -x "$dest" ]; then
		printf 'pre-push-verification-level: MISSING installed member: %s\n' "$dest" >&2
		stale=1
	elif ! cmp -s "$SELF" "$dest"; then
		printf 'pre-push-verification-level: STALE installed member: %s differs from %s\n' "$dest" "$SELF" >&2
		stale=1
	fi
	paired_fresh "$hooks/$CM_MEMBER" || stale=1
	if [ "$stale" -ne 0 ]; then return 3; fi
	printf 'pre-push-verification-level: hooks fresh in %s\n' "$repo"
	return 0
}

do_selftest() {
	# Sourced here, not at the top: the installed hook (and the fixture copies below) run without kitlib beside them.
	# shellcheck source=scripts/kitlib-tmp.sh
	. "${SELF%/*}/kitlib-tmp.sh"
	root='' # assigned by kitlib_tmp via eval
	kitlib_tmp root vlevel-selftest || exit 2
	pass=0 fail=0
	ok() { printf 'selftest: PASS %s\n' "$1"; pass=$((pass + 1)); }
	bad() { printf 'selftest: FAIL %s\n' "$1"; fail=$((fail + 1)); }

	mkfixture() {
		# mkfixture NAME: bare origin + work clone with the member installed
		# as the pre-push hook; echoes the work dir.
		name="$1"
		git init -q --bare "$root/$name.git" || return 1
		git init -q -b main "$root/$name" || return 1
		(cd "$root/$name" && git config user.email t@t && git config user.name t \
			&& git commit -q --allow-empty -m "seed [test]" \
			&& git remote add origin "$root/$name.git" \
			&& git push -q origin main) || return 1
		cp "$SELF" "$root/$name/.git/hooks/pre-push" || return 1
		chmod +x "$root/$name/.git/hooks/pre-push" || return 1
		printf '%s' "$root/$name"
	}

	# (a) level-less commit-tree push: refused, origin unchanged
	w=$(mkfixture a) || { bad "fixture a setup"; w=""; }
	if [ -n "$w" ]; then
		before=$(git --git-dir="$root/a.git" rev-parse refs/heads/main)
		nt=$(cd "$w" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "quiet landing without a level") || nt=""
		(cd "$w" && git update-ref refs/heads/main "$nt")
		out=$(cd "$w" && git push origin main 2>&1); rc=$?
		after=$(git --git-dir="$root/a.git" rev-parse refs/heads/main)
		if [ "$rc" -ne 0 ] && [ "$after" = "$before" ]; then
			case "$out" in *"$nt"*) ok "(a) level-less commit-tree refused naming sha, origin unchanged" ;; *) bad "(a) refused but sha not named" ;; esac
		else
			bad "(a) level-less commit-tree push not refused (rc=$rc origin moved)"
		fi
	fi

	# (b) same commit with [pending]: pushed
	w=$(mkfixture b) || { bad "fixture b setup"; w=""; }
	if [ -n "$w" ]; then
		nt=$(cd "$w" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "quiet landing [pending]") || nt=""
		(cd "$w" && git update-ref refs/heads/main "$nt" && git push -q origin main 2>/dev/null); rc=$?
		after=$(git --git-dir="$root/b.git" rev-parse refs/heads/main)
		if [ "$rc" -eq 0 ] && [ "$after" = "$nt" ]; then ok "(b) [pending] commit-tree pushed"; else bad "(b) [pending] commit-tree not pushed"; fi
	fi

	# (c) merge commit without a level: pushed
	w=$(mkfixture c) || { bad "fixture c setup"; w=""; }
	if [ -n "$w" ]; then
		(cd "$w" && git checkout -qb side && git commit -q --allow-empty -m "side work [test]" \
			&& git checkout -q main && git merge -q --no-ff -m "Merge branch 'side'" side \
			&& git push -q origin main 2>/dev/null); rc=$?
		if [ "$rc" -eq 0 ]; then ok "(c) levelless merge pushed"; else bad "(c) levelless merge refused"; fi
	fi

	# (d) empty range passes
	w=$(mkfixture d) || { bad "fixture d setup"; w=""; }
	if [ -n "$w" ]; then
		sha=$(cd "$w" && git rev-parse HEAD)
		if printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$sha" | (cd "$w" && sh "$SELF" --pre-push origin --repo "$w"); then
			ok "(d) empty range passes"
		else
			bad "(d) empty range refused"
		fi
	fi

	# mutant: member skipped -> (a) is NOT refused (the catcher is gone)
	w=$(mkfixture m) || { bad "mutant fixture setup"; w=""; }
	if [ -n "$w" ]; then
		rm "$w/.git/hooks/pre-push"
		nt=$(cd "$w" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "quiet landing without a level") || nt=""
		(cd "$w" && git update-ref refs/heads/main "$nt" && git push -q origin main 2>/dev/null); rc=$?
		if [ "$rc" -eq 0 ]; then ok "mutant without member fails (a): push unrefused"; else bad "mutant unexpectedly refused (a)"; fi
	fi

	cm_src="${SELF%/*}/commit-msg-verification-level.sh"
	# pin: CM_SHA256 must equal the shipped canonical commit-msg source
	if [ -f "$cm_src" ] && [ "$(sha256_of "$cm_src")" = "$CM_SHA256" ]; then
		ok "(pin) CM_SHA256 equals shipped commit-msg-verification-level.sh"
	else
		bad "(pin) CM_SHA256 differs from $cm_src or the source is missing"
	fi

	chain() {
		# chain NAME: fixture with the pre-push member at its chain path and
		# the paired commit-msg member present; echoes the work dir.
		w=$(mkfixture "$1") || return 1
		mkdir -p "$w/.git/hooks/hooks.d/pre-push" "$w/.git/hooks/hooks.d/commit-msg" || return 1
		mv "$w/.git/hooks/pre-push" "$w/.git/hooks/hooks.d/pre-push/$(basename -- "$MEMBER")" || return 1
		cp "$cm_src" "$w/.git/hooks/hooks.d/commit-msg/$(basename -- "$CM_MEMBER")" || return 1
		chmod +x "$w/.git/hooks/hooks.d/commit-msg/$(basename -- "$CM_MEMBER")" || return 1
		printf '%s' "$w"
	}

	# (e) --check refuses a repo with the pre-push member but no paired member
	w=$(chain e) || { bad "fixture e setup"; w=""; }
	if [ -n "$w" ]; then
		rm "$w/.git/hooks/hooks.d/commit-msg/$(basename -- "$CM_MEMBER")"
		sh "$SELF" --check "$w" >/dev/null 2>&1; rc=$?
		if [ "$rc" -eq 3 ]; then ok "(e) half-installed repo refused by --check"; else bad "(e) --check rc=$rc want 3"; fi
	fi

	# (f) --check passes with both members fresh
	w=$(chain f) || { bad "fixture f setup"; w=""; }
	if [ -n "$w" ]; then
		if sh "$SELF" --check "$w" >/dev/null 2>&1; then ok "(f) both members fresh passes --check"; else bad "(f) both members fresh refused by --check (rc=$?)"; fi
	fi

	# (g) GATE1-B no self-weakening: a pushed commit that deletes the
	# canonical gate source is still judged by the installed (base) member,
	# so a level-less tip in the same push is refused and origin is unchanged.
	w=$(mkfixture g) || { bad "fixture g setup"; w=""; }
	if [ -n "$w" ]; then
		before=$(git --git-dir="$root/g.git" rev-parse refs/heads/main)
		(cd "$w" && mkdir -p scripts && cp "$SELF" scripts/pre-push-verification-level.sh \
			&& git add -A && git commit -q -m "ship canonical gate source [test]" \
			&& git rm -q scripts/pre-push-verification-level.sh \
			&& git commit -q -m "delete the gate step [test]") || w=""
	fi
	if [ -n "$w" ]; then
		nt=$(cd "$w" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "quiet landing without a level") || nt=""
		(cd "$w" && git update-ref refs/heads/main "$nt")
		out=$(cd "$w" && git push origin main 2>&1); rc=$?
		after=$(git --git-dir="$root/g.git" rev-parse refs/heads/main)
		if [ "$rc" -ne 0 ] && [ "$after" = "$before" ]; then
			case "$out" in *"$nt"*) ok "(g) gate-deleting push still refused naming sha, origin unchanged" ;; *) bad "(g) refused but sha not named" ;; esac
		else
			bad "(g) gate-deleting push not refused (rc=$rc origin moved): self-weakening"
		fi
	fi

	# mutant: member no-op'ed -> (a) PASSES (the installed member is the
	# authority; weakening installed code weakens judgment, pushed content cannot)
	w=$(mkfixture n) || { bad "mutant no-op fixture setup"; w=""; }
	if [ -n "$w" ]; then
		printf '#!/bin/sh\nexit 0\n' >"$w/.git/hooks/pre-push"
		chmod +x "$w/.git/hooks/pre-push"
		nt=$(cd "$w" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "quiet landing without a level") || nt=""
		(cd "$w" && git update-ref refs/heads/main "$nt" && git push -q origin main 2>/dev/null); rc=$?
		if [ "$rc" -eq 0 ]; then ok "mutant no-op member fails (a): push unrefused"; else bad "mutant no-op member unexpectedly refused (a)"; fi
	fi

	# (h) VLEVELDRIFT1: the installed chain member judges its paired member
	# on every push. leveled() feeds one [test] commit range to MEMBERFILE.
	leveled() {
		nt=$(cd "$1" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "leveled landing [test]") || return 9
		base=$(cd "$1" && git rev-parse HEAD)
		printf 'refs/heads/main %s refs/heads/main %s\n' "$nt" "$base" | (cd "$1" && sh "$2" --pre-push origin --repo "$1" >/dev/null 2>&1)
	}
	w=$(chain h) || { bad "fixture h setup"; w=""; }
	if [ -n "$w" ]; then
		pm="$w/.git/hooks/hooks.d/pre-push/$(basename -- "$MEMBER")"
		cm="$w/.git/hooks/hooks.d/commit-msg/$(basename -- "$CM_MEMBER")"
		leveled "$w" "$pm"; rc=$?
		if [ "$rc" -eq 0 ]; then ok "(h) both members present: leveled push passes"; else bad "(h) both present refused (rc=$rc)"; fi
		printf '\n# drift\n' >>"$cm"
		leveled "$w" "$pm"; rc=$?
		if [ "$rc" -eq 4 ]; then ok "(h) stale paired member: push refused"; else bad "(h) stale paired member rc=$rc want 4"; fi
		rm "$cm"
		leveled "$w" "$pm"; rc=$?
		if [ "$rc" -eq 4 ]; then ok "(h) missing paired member: push refused"; else bad "(h) missing paired member rc=$rc want 4"; fi
		# mutant: the paired check disabled -> the missing case passes
		# shellcheck disable=SC2016  # the sed pattern names the literal ${SELF%...} text
		sed 's|paired_fresh "${SELF%/hooks.d|true \|\| paired_fresh "${SELF%/hooks.d|' "$pm" >"$pm.mut" && mv "$pm.mut" "$pm"
		leveled "$w" "$pm"; rc=$?
		if [ "$rc" -eq 0 ]; then ok "mutant without paired check passes missing case"; else bad "mutant without paired check still refused (rc=$rc)"; fi
	fi

	printf 'selftest: %d passed, %d failed\n' "$pass" "$fail"
	[ "$fail" -eq 0 ]
}

MODE="" REPO="" BASE="" TIP="" REMOTE="origin"
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) REPO=${2:-}; shift 2 ;;
		--base) BASE=${2:-}; shift 2 ;;
		--tip) TIP=${2:-}; shift 2 ;;
		--pre-push) MODE=prepush; shift ;;
		--check) MODE=check; shift ;;
		--selftest) MODE=selftest; shift ;;
		--) shift; break ;;
		-*) printf 'pre-push-verification-level: unknown argument %s\n' "$1" >&2; exit 2 ;;
		# A bare positional after --check is the repo (usage: --check [REPO]);
		# elsewhere it is the remote name for --pre-push passthrough.
		*) if [ "$MODE" = "check" ] && [ -z "$REPO" ]; then REPO="$1"; else REMOTE="$1"; fi; shift ;;
	esac
done
case "$MODE" in
	prepush)
		[ -n "$REPO" ] || REPO=$(git rev-parse --show-toplevel 2>/dev/null) || {
			printf 'pre-push-verification-level: --pre-push needs --repo DIR or a checkout cwd\n' >&2
			exit 2
		}
		pre_push "$REMOTE" "$REPO"
		;;
	check) do_check "${1:-${REPO:-.}}" ;;
	selftest) do_selftest ;;
	*)
		# No mode flags: behave as the installed pre-push member (git calls
		# the hook as "pre-push <name> <url>" with push lines on stdin). An
		# explicit --repo/--base/--tip triple selects the direct check.
		if [ -n "$REPO" ] && [ -n "$BASE" ] && [ -n "$TIP" ]; then
			check_range "$REPO" "$BASE" "$TIP"
		else
			[ -n "$REPO" ] || REPO=$(git rev-parse --show-toplevel 2>/dev/null) || {
				printf 'usage: pre-push-verification-level.sh --repo DIR --base SHA --tip SHA | [--pre-push [REMOTE] [--repo DIR]] | --check [REPO] | --selftest\n' >&2
				exit 2
			}
			pre_push "$REMOTE" "$REPO"
		fi
		;;
esac
