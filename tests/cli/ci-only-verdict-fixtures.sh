#!/bin/sh
# CIONLY1 fixtures shared by ci-only-verdict.test.sh and release-local-ci-only-reuse.test.sh (sourced, never run).
# cio_fixture REPO: a git repo holding the store, its judge files, release-verdict.sh, a passing stub full-suite runner
# and stub copies of its declared ci-only test files, committed once. CIO_STORE_UNDER_TEST swaps the store (mutants).
# cio_stub_bin DIR: a `bun` whose --version is the real one and whose `test` run logs argv, cwd, OMP_KIT_CASE_CWD,
# OMP_KIT_HEAVY_MAX_WAIT_S and the export's FETCH_HEAD to $CIO_LOG, and fails the files CIO_FAIL names, printing
# boom-stdout/boom-stderr lines; plus a `timeout` that drops its bound (as release-verdict.test.sh's does).
cio_fixture() {
	cio_repo=$1
	mkdir -p "$cio_repo/scripts" "$cio_repo/tests/cli" "$cio_repo/.github" || return 1
	git -C "$cio_repo" init -q --template= -b main || return 1
	git -C "$cio_repo" config user.email t@example.invalid
	git -C "$cio_repo" config user.name t
	cio_judging=$(PYTHONPATH="$KITREPO/scripts" python3 -m suite-metrics judging-files) || return 1
	for cio_path in scripts/release-verdict.sh scripts/gate-ci-only.tsv $cio_judging; do
		mkdir -p "$cio_repo/$(dirname "$cio_path")" || return 1
		cp "$KITREPO/$cio_path" "$cio_repo/$cio_path" || return 1
	done
	cp "${CIO_STORE_UNDER_TEST:-$KITREPO/scripts/full-suite-verdict-store.py}" "$cio_repo/scripts/full-suite-verdict-store.py" || return 1
	# shellcheck disable=SC2016 # the stub's own $1, expanded when it runs
	printf '#!/bin/sh\ncase "${1:-}" in --test-workers) printf "1\\n" ;; *) exit 0 ;; esac\n' >"$cio_repo/scripts/fresh-gate.sh"
	printf '#!/bin/sh\nexit 0\n' >"$cio_repo/scripts/full-suite-verdict.sh"
	for cio_case in tests/cli/package-release.test.ts tests/cli/kit-update.test.ts \
		tests/cli/kit-update-nplus-two.test.ts tests/cli/kit-update-compiled.test.ts \
		tests/cli/kit-update-relink.test.ts tests/cli/package-release-live.test.ts; do
		printf '// stub CI-only file\n' >"$cio_repo/$cio_case" || return 1
	done
	git -C "$cio_repo" add -A && git -C "$cio_repo" commit -qm "[test] ci-only fixture"
}

cio_stub_bin() {
	mkdir -p "$1" || return 1
	cio_bun_version=$(bun --version) || return 1
	cat >"$1/bun" <<EOF
#!/bin/sh
case "\${1:-}" in --version) printf '%s\n' "$cio_bun_version"; exit 0 ;; esac
file=\$3
printf '%s|%s|%s|%s|%s\n' "\$*" "\$(pwd -P)" "\${OMP_KIT_CASE_CWD:-}" "\${OMP_KIT_HEAVY_MAX_WAIT_S:-}" \\
	"\$(git -C "\${OMP_KIT_CASE_CWD:-.}" rev-parse FETCH_HEAD 2>/dev/null)" >>"\$CIO_LOG"
case " \${CIO_FAIL:-} " in
	*" \${file##*/} "*) printf 'boom-stdout %s\n' "\$file"; printf 'boom-stderr %s\n' "\$file" >&2; exit 1 ;;
esac
printf 'ok %s\n' "\$file"
EOF
	printf '#!/bin/sh\nshift\nexec "$@"\n' >"$1/timeout"
	chmod +x "$1/bun" "$1/timeout"
}
