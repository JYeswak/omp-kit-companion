#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-incomplete.test.sh — FULLSUITELOG1 (ompkit-lrbd.6).
# Incomplete evidence is kept at the path printed by the runner. Complete records and logs use
# full-suite-verdict-store's judge-keyed stem, not the tree hash alone.
# FULLSUITEPAR1 (ompkit-9t6f2): parallel shell suites give the serial
# GREEN/RED lines and counts, and a hung parallel suite is killed by the deadline and named.
set -u
# HERMETIC1 (ompkit-kup44.4): the environment scrub and the macOS fence are opt-in for every other suite until
# their full-suite control passes; this suite turns both on so the scrub and the fence's write and network denials
# stay proven on every run.
OMP_KIT_SUITE_HERMETIC_ENABLE=1
OMP_KIT_SUITE_FENCE_ENABLE=1
export OMP_KIT_SUITE_HERMETIC_ENABLE OMP_KIT_SUITE_FENCE_ENABLE

KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
# FULL_SUITE_VERDICT_UNDER_TEST lets a planted-negative run point at a scratch copy of the judge.
VERDICT=${FULL_SUITE_VERDICT_UNDER_TEST:-"$KITROOT_DIR/scripts/full-suite-verdict.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-verdict-incomplete-test || exit 1

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }

# mkrepo_begin NAME: empty fixture tree; addfile REL BODY adds files; mkrepo_commit commits them.
mkrepo_begin() {
	repo="$TMP/$1"
	rm -rf "$repo" "$repo.cache"
	mkdir -p "$repo/scripts" "$repo/tests/cli"
	cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
}
addfile() { mkdir -p "$(dirname "$repo/$1")"; printf '%s\n' "$2" >"$repo/$1"; }
mkrepo_commit() {
	git -C "$repo" init -q
	git -C "$repo" config user.name "FULLSUITELOG1 test"
	git -C "$repo" config user.email "fullsuitelog1@example.invalid"
	git -C "$repo" add -A
	git -C "$repo" commit -q -m "[test] FULLSUITELOG1 fixture"
}
# mkrepo NAME PY_BODY: fixture repo whose candidate commit holds one python suite.
mkrepo() {
	mkrepo_begin "$1"
	addfile tests/cli/fixture_test.py "$2"
	mkrepo_commit
}

resolve_cache_paths() {
	tree_hash=$(git -C "$repo" rev-parse 'HEAD^{tree}') || return 1
	cache="$repo.cache"
	judge_dir=$(CDPATH='' cd -- "$(dirname -- "$VERDICT")" && pwd -P) || return 1
	judge_root=$(CDPATH='' cd -- "$judge_dir/.." && pwd -P) || return 1
	checks=$(python3 "$judge_dir/suite-metrics.py" identity --root "$judge_root" --scope full) || return 1
	runtime=$(python3 "$judge_dir/suite-metrics.py" runtime) || return 1
	entry=$(python3 "$judge_dir/full-suite-verdict-store.py" path --repo "$repo" --tree "$tree_hash" \
		--role base --checks "$checks" --runtime "$runtime" --judge-root "$judge_root" \
		--cache-dir "$cache") || return 1
	tree=${entry##*/}
	tree=${tree%.json}
	incomplete_log=$(python3 - "$out" <<'PY'
import sys
from pathlib import Path

marker = "partial log: "
result = ""
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    index = line.find(marker)
    if index >= 0:
        result = line[index + len(marker):]
print(result)
PY
)
}

run_verdict() {
	out="$TMP/$1.out"
	KITROOT=$KITROOT_DIR OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$out" 2>&1
	rc=$?
	resolve_cache_paths || { rc=2; echo "test harness: cannot resolve verdict cache paths" >>"$out"; }
}
run_verdict_with_env() {
	out="$TMP/$1.out"
	env "$2=$3" KITROOT="$KITROOT_DIR" OMP_KIT_OMP_SRC_FETCH=0 \
		sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$out" 2>&1
	rc=$?
	resolve_cache_paths || { rc=2; echo "test harness: cannot resolve verdict cache paths" >>"$out"; }
}

run_verdict_with_envs() {
	out="$TMP/$1.out"
	shift
	env "$@" KITROOT="$KITROOT_DIR" OMP_KIT_OMP_SRC_FETCH=0 \
		sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$out" 2>&1
	rc=$?
	resolve_cache_paths || { rc=2; echo "test harness: cannot resolve verdict cache paths" >>"$out"; }
}

refusal_case() {
	label=$1
	name=$2
	value_kind=$3
	marker="$TMP/$label.ran"
	rm -f "$marker"
	mkrepo_begin "$label"
	addfile tests/cli/fixture_test.py "from pathlib import Path
Path('$marker').write_text('ran')"
	mkrepo_commit
	case "$value_kind" in
		git-dir) value="$repo/.git" ;;
		work-tree) value="$repo" ;;
		live-db) value="$KITROOT_DIR/.beads/beads.db" ;;
		*) not_ok "unknown refusal fixture value $value_kind"; return 1 ;;
	esac
	run_verdict_with_env "$label" "$name" "$value"
	if [ "$rc" -ne 0 ] && grep -F "FULL-SUITE: REFUSED caller $name is set" "$out" >/dev/null && [ ! -e "$marker" ]; then
		ok "$name is named and no suite starts"
	else
		not_ok "$name did not refuse before starting a suite (rc=$rc)"; cat "$out"
	fi
}

fresh_refusal_case() {
	name=$1
	value_kind=$2
	case "$value_kind" in
		git-dir) value="$repo/.git" ;;
		work-tree) value="$repo" ;;
		live-db) value="$KITROOT_DIR/.beads/beads.db" ;;
	esac
	fresh_out="$TMP/fresh-$name.out"
	if env "$name=$value" sh "$KITROOT_DIR/scripts/fresh-gate.sh" --test-workers >"$fresh_out" 2>&1; then fresh_rc=0; else fresh_rc=$?; fi
	if [ "$fresh_rc" -ne 0 ] && grep -F "FRESH-GATE: REFUSED caller $name is set" "$fresh_out" >/dev/null; then
		ok "fresh gate refuses caller $name before its command proceeds"
	else
		not_ok "fresh gate did not refuse caller $name (rc=$fresh_rc)"; cat "$fresh_out"
	fi
}
# side_files_gone: no runner-private file or dir is left beside the cache entry.
side_files_gone() {
	for side in status bun shell runner timed-out; do
		for side_file in "$cache/$tree.running."*.log."$side"; do
			[ ! -e "$side_file" ] || return 1
		done
	done
	for running_log in "$cache/$tree.running."*.log; do
		[ ! -e "$running_log" ] || return 1
	done
	return 0
}
no_incomplete_log() {
	for incomplete_file in "$cache/$tree.incomplete."*.log; do
		[ ! -e "$incomplete_file" ] || return 1
	done
	return 0
}

# Incomplete: the python suite prints a marker, then SIGKILLs the runner loop that would print
# its GREEN/RED line, so the run never accounts for it.
mkrepo incomplete 'import os, signal
print("FULLSUITELOG1-MARKER before runner death", flush=True)
os.kill(os.getppid(), signal.SIGKILL)'
run_verdict incomplete
cache="$repo.cache"
if [ "$rc" -ne 0 ]; then ok "incomplete run exits non-pass (rc=$rc)"; else not_ok "incomplete run exited 0"; fi
if [ ! -e "$cache/$tree.json" ]; then ok "incomplete run caches no verdict"; else not_ok "incomplete run cached $cache/$tree.json"; fi
if [ ! -e "$cache/$tree.log" ]; then ok "incomplete run writes no reusable evidence log"; else not_ok "incomplete run left $cache/$tree.log"; fi
if side_files_gone; then ok "incomplete run leaves no running log"; else not_ok "running log left behind"; fi
inc=$incomplete_log
if [ -n "$inc" ] && grep -F "partial log: $inc" "$out" >/dev/null; then ok "RED line prints the incomplete log path"; else not_ok "RED line lacks the incomplete log path"; cat "$out"; fi
if [ -f "$inc" ] && grep -F 'FULLSUITELOG1-MARKER before runner death' "$inc" >/dev/null; then
	ok "incomplete log holds the suite output"
else
	not_ok "incomplete log missing or lacks suite output"
fi

# Control: a complete run records <tree>.log plus the cached verdict.
mkrepo complete 'print("FULLSUITELOG1-CONTROL ok")'
run_verdict complete
cache="$repo.cache"
if [ "$rc" -eq 0 ]; then ok "complete run passes"; else not_ok "complete run rc=$rc"; cat "$out"; fi
if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "PASS"' "$cache/$tree.json" >/dev/null; then ok "complete run caches PASS verdict"; else not_ok "complete run cached no PASS verdict"; fi
if grep -F 'FULLSUITELOG1-CONTROL ok' "$cache/$tree.log" >/dev/null 2>&1; then ok "complete run keeps the paired evidence log"; else not_ok "complete run has no paired evidence log"; fi
if no_incomplete_log; then ok "complete run writes no incomplete log"; else not_ok "complete run wrote an incomplete log"; fi

# HERMETIC1: caller Git/tracker authority is refused before an actual suite can start.
refusal_case inherited-git-dir GIT_DIR git-dir
refusal_case inherited-git-work-tree GIT_WORK_TREE work-tree
refusal_case inherited-beads-db BEADS_DB live-db
fresh_refusal_case GIT_DIR git-dir
fresh_refusal_case GIT_WORK_TREE work-tree
fresh_refusal_case BEADS_DB live-db

# HERMETIC1: suite processes see only wrapper-owned locations and declared base variables.
mkrepo_begin hermetic-env
addfile tests/cli/fixture_test.py "import os
from pathlib import Path
import subprocess
home = Path(os.environ['HOME']).resolve()
scratch = Path(os.environ['TMPDIR']).resolve()
assert home != Path('$HOME').resolve(), home
assert home.is_relative_to(scratch), (home, scratch)
for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'GIT_CONFIG_GLOBAL'):
    assert Path(os.environ[name]).resolve().is_relative_to(home), (name, os.environ[name], home)
assert Path(os.environ['GIT_CEILING_DIRECTORIES']).resolve() == Path.cwd().resolve().parent
assert Path(os.environ['GIT_CONFIG_GLOBAL']).is_file()
assert subprocess.run(['git', 'config', '--global', '--get', 'user.email'],
    check=True, text=True, capture_output=True).stdout.strip() == 'omp-kit-tests@example.invalid'
for name in ('AGENT_NAME', 'AGENT_MAIL_TOKEN', 'FLEET_GUARD_LIVE',
             'OMP_KIT_UNDECLARED', 'TMUX', 'TMUX_PANE'):
    assert name not in os.environ, name
assert os.environ['PATH'] and os.environ['LANG']
print('HERMETIC1_ENV_BOUNDARY home=' + str(home), flush=True)"
mkrepo_commit
run_verdict_with_envs hermetic-env AGENT_NAME=SilverCondor AGENT_MAIL_TOKEN=synthetic-token-never-real \
	FLEET_GUARD_LIVE=1 OMP_KIT_UNDECLARED=synthetic-value TMUX=synthetic TMUX_PANE=%999
cache="$repo.cache"
if [ "$rc" -eq 0 ] && grep -F 'HERMETIC1_ENV_BOUNDARY home=' "$cache/$tree.log" >/dev/null 2>&1; then
	ok "the real suite runner scrubs authority and gives the suite an owned home and Git boundary"
else
	not_ok "the real suite runner leaked env or lacked an owned home/Git boundary (rc=$rc)"; cat "$out"
	[ ! -f "$cache/$tree.log" ] || cat "$cache/$tree.log"
fi

# HERMETIC1: exercise denied writes through the real runner. All protected targets are
# synthetic siblings of the child archive, so a regression cannot damage a user's files.
file_state() {
	if [ -f "$1" ]; then
		shasum -a 256 "$1" | cut -d' ' -f1
	elif [ -e "$1" ]; then
		printf 'PRESENT_NONREGULAR\n'
	else
		printf 'ABSENT\n'
	fi
}
expect_runner_denial() {
	label=$1
	row=$2
	needle=$3
	cache="$repo.cache"
	if [ "$rc" -ne 0 ] && grep -F 'VERDICT FAIL' "$out" >/dev/null \
		&& grep -F "$row" "$cache/$tree.log" >/dev/null 2>&1 \
		&& grep -F "$needle" "$cache/$tree.log" >/dev/null 2>&1 \
		&& { grep -F 'Operation not permitted' "$cache/$tree.log" >/dev/null 2>&1 \
			|| grep -F 'EPERM' "$cache/$tree.log" >/dev/null 2>&1; }; then
		ok "$label is RED in the real runner with the denied path named"
	else
		not_ok "$label did not record the real-runner denial (rc=$rc, target=$needle)"
		cat "$out"
		[ ! -f "$cache/$tree.log" ] || cat "$cache/$tree.log"
	fi
}
if [ "$(uname -s)" = Darwin ]; then
	mkrepo_begin hermetic-git-ref
	addfile tests/cli/fixture_test.py "from pathlib import Path
target = Path('$repo/.git/refs/remotes/origin/main')
target.write_text('changed')"
	mkrepo_commit
	ref_target="$repo/.git/refs/remotes/origin/main"
	mkdir -p "$(dirname "$ref_target")"
	printf 'synthetic ref sentinel\n' >"$ref_target"
	ref_before=$(file_state "$ref_target")
	run_verdict hermetic-git-ref
	ref_after=$(file_state "$ref_target")
	expect_runner_denial 'HERMETIC1 protected Git ref' \
		'RED python-suite tests/cli/fixture_test.py' "$ref_target"
	if [ "$ref_before" = "$ref_after" ]; then
		ok "HERMETIC1 protected Git ref bytes remain unchanged"
	else
		not_ok "HERMETIC1 protected Git ref changed ($ref_before -> $ref_after)"
	fi

	if command -v br >/dev/null 2>&1; then
		mkrepo_begin hermetic-br-default
		addfile tests/cli/fixture_test.py "import subprocess
from pathlib import Path
root = Path('$repo')
print('HERMETIC_BR_DEFAULT_TARGET ' + str(root / '.beads' / 'beads.db'), flush=True)
subprocess.run(['br', '--no-daemon', '--no-auto-import', '--no-auto-flush',
    'create', 'implicit database containment probe', '--json'], cwd=root, check=True)"
		mkrepo_commit
		br_actor=hermetic-fixture
		br_db="$repo/.beads/beads.db"
		if (
			cd "$repo" &&
			env -u BEADS_DB br --db "$br_db" --actor "$br_actor" --no-auto-import \
				--no-auto-flush --no-daemon init --prefix hermetic --json >"$TMP/hermetic-br-init.out" 2>&1 \
				&& env -u BEADS_DB br --db "$br_db" --actor "$br_actor" --no-auto-import \
					--no-auto-flush --no-daemon create 'retained tracker sentinel' --json >"$TMP/hermetic-br-seed.out" 2>&1
		); then
			br_before=$(file_state "$br_db")
			run_verdict hermetic-br-default
			br_after=$(file_state "$br_db")
			expect_runner_denial 'HERMETIC1 br create without --db' \
				'RED python-suite tests/cli/fixture_test.py' "$br_db"
			if [ "$br_before" = "$br_after" ]; then
				ok "HERMETIC1 implicit br create leaves the synthetic tracker bytes unchanged"
			else
				not_ok "HERMETIC1 implicit br create changed the tracker ($br_before -> $br_after)"
			fi
		else
			not_ok "HERMETIC1 synthetic br tracker setup failed"
			cat "$TMP/hermetic-br-init.out" "$TMP/hermetic-br-seed.out" 2>/dev/null
		fi
	else
		echo "HERMETIC1 br create negative NOT_RUN: br unavailable"
	fi

	external_home="$TMP/protected-home"
	home_target="$external_home/.local/opt/omp-kit/x"
	mkdir -p "$(dirname "$home_target")"
	printf 'synthetic home sentinel\n' >"$home_target"
	home_before=$(file_state "$home_target")
	mkrepo_begin hermetic-home-write
	addfile tests/cli/fixture_test.py "from pathlib import Path
Path('$home_target').write_text('changed')"
	mkrepo_commit
	run_verdict hermetic-home-write
	home_after=$(file_state "$home_target")
	expect_runner_denial 'HERMETIC1 absolute HOME write' \
		'RED python-suite tests/cli/fixture_test.py' "$home_target"
	if [ "$home_before" = "$home_after" ]; then
		ok "HERMETIC1 protected HOME bytes remain unchanged"
	else
		not_ok "HERMETIC1 protected HOME changed ($home_before -> $home_after)"
	fi

	external_config="$TMP/protected-global.gitconfig"
	printf '[user]\n\tname = synthetic\n\temail = synthetic@example.invalid\n' >"$external_config"
	config_before=$(file_state "$external_config")
	outer_global_before=$(file_state "$HOME/.gitconfig")
	mkrepo_begin hermetic-global-config
	addfile tests/cli/fixture_test.py "import os, subprocess
from pathlib import Path
global_config = Path(os.environ['GIT_CONFIG_GLOBAL']).resolve()
assert global_config.is_relative_to(Path(os.environ['TMPDIR']).resolve())
subprocess.run(['git', 'config', '--global', 'hermetic.probe', 'scratch'], check=True)
value = subprocess.run(['git', 'config', '--global', '--get', 'hermetic.probe'],
    check=True, text=True, capture_output=True).stdout.strip()
assert value == 'scratch', value
print('HERMETIC_GLOBAL_REDIRECTED ' + str(global_config), flush=True)
subprocess.run(['git', 'config', '--file', '$external_config',
    'hermetic.probe', 'escaped'], check=True)"
	mkrepo_commit
	run_verdict hermetic-global-config
	config_after=$(file_state "$external_config")
	outer_global_after=$(file_state "$HOME/.gitconfig")
	expect_runner_denial 'HERMETIC1 absolute global-config write' \
		'RED python-suite tests/cli/fixture_test.py' "$external_config"
	if [ -f "$repo.cache/$tree.log" ] && grep -F 'HERMETIC_GLOBAL_REDIRECTED ' "$repo.cache/$tree.log" >/dev/null; then
		ok "git config --global writes through the suite-owned GIT_CONFIG_GLOBAL control"
	else
		not_ok "git config --global did not prove its scratch-config control"
	fi
	if [ "$config_before" = "$config_after" ] \
		&& [ "$outer_global_before" = "$outer_global_after" ]; then
		ok "HERMETIC1 protected global-config bytes remain unchanged"
	else
		not_ok "HERMETIC1 global config changed (synthetic $config_before -> $config_after; caller $outer_global_before -> $outer_global_after)"
	fi

	compiled_dir="$TMP/protected-compiled-output"
	mkrepo_begin hermetic-compiled-output
	addfile fixture.ts 'export const value = 1;'
	addfile tests/cli/compiled.test.sh "printf 'HERMETIC_COMPILED_TARGET %s\\n' '$compiled_dir'
bun build \"\$KITROOT/fixture.ts\" --outdir '$compiled_dir'"
	mkrepo_commit
	compiled_before=$(file_state "$compiled_dir")
	run_verdict hermetic-compiled-output
	compiled_after=$(file_state "$compiled_dir")
	expect_runner_denial 'HERMETIC1 compiled output outside scratch' \
		'RED script-suite tests/cli/compiled.test.sh' "$compiled_dir"
	if [ "$compiled_before" = "$compiled_after" ]; then
		ok "HERMETIC1 compiled output target remains absent"
	else
		not_ok "HERMETIC1 compiled output target changed ($compiled_before -> $compiled_after)"
	fi

	symlink_target="$TMP/protected-symlink-target"
	printf 'synthetic symlink sentinel\n' >"$symlink_target"
	symlink_before=$(file_state "$symlink_target")
	mkrepo_begin hermetic-symlink-escape
	addfile tests/cli/fixture_test.py "import os
from pathlib import Path
target = Path('$symlink_target')
link = Path(os.environ['TMPDIR']) / 'escape'
link.symlink_to(target)
print('HERMETIC_SYMLINK_ESCAPE ' + str(link) + ' -> ' + str(target), flush=True)
link.write_text('changed')"
	mkrepo_commit
	run_verdict hermetic-symlink-escape
	symlink_after=$(file_state "$symlink_target")
	expect_runner_denial 'HERMETIC1 symlink escape from suite scratch' \
		'RED python-suite tests/cli/fixture_test.py' "$symlink_target"
	if [ "$symlink_before" = "$symlink_after" ]; then
		ok "HERMETIC1 symlink target bytes remain unchanged"
	else
		not_ok "HERMETIC1 symlink target changed ($symlink_before -> $symlink_after)"
	fi
fi

# HERMETIC1: the shared helper must preserve declared controls, scrub authority, and fence writes.
helper="$KITROOT_DIR/scripts/suite-hermetic-env.sh"
helper_archive="$TMP/hermetic-helper-archive"
helper_scratch_root="$helper_archive/var/agent-tmp"
helper_scratch=
helper_override_scratch=
protected="$TMP/hermetic-helper-protected"
helper_out="$TMP/hermetic-helper-control.out"
mkdir -p "$helper_archive/work" "$helper_scratch_root"
helper_previous_root=${KITLIB_TMP_ROOT-}
helper_previous_auto=${KITLIB_TMP_AUTO_CLEANUP-}
helper_previous_pwd=$PWD
cd "$helper_archive" || exit 1
KITLIB_TMP_ROOT=$helper_scratch_root
KITLIB_TMP_AUTO_CLEANUP=0
kitlib_tmp helper_scratch hermetic-helper-env || exit 1
kitlib_tmp helper_override_scratch hermetic-helper-env-override || exit 1
cd "$helper_previous_pwd" || exit 1
if [ -n "$helper_previous_root" ]; then KITLIB_TMP_ROOT=$helper_previous_root; else unset KITLIB_TMP_ROOT; fi
if [ -n "$helper_previous_auto" ]; then KITLIB_TMP_AUTO_CLEANUP=$helper_previous_auto; else unset KITLIB_TMP_AUTO_CLEANUP; fi
helper_loopback_port=$(python3 -c 'import os, socket
p = int(os.environ.get("KIT_TEST_LOOPBACK_PORT", "0"))
for _ in range(8):
    server = socket.socket()
    try:
        server.bind(("127.0.0.1", p))
        p = server.getsockname()[1]
    finally:
        server.close()
    if p != 8765:
        print(p)
        break
    p = 0
else:
    raise SystemExit("cannot choose a suite test loopback port")') || exit 1
printf 'protected sentinel\n' >"$protected"
cp "$protected" "$protected.before"
if (
	cd "$helper_archive/work"
	env AGENT_NAME=synthetic-agent AGENT_MAIL_TOKEN=synthetic-token-never-real \
		FLEET_GUARD_LIVE=1 OMP_KIT_UNDECLARED=synthetic-value TMUX=synthetic \
		HERMETIC_CONTROL=declared \
		sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
		--suite tests/cli/fixture_test.py --loopback-port "$helper_loopback_port" \
		--allow-env HERMETIC_CONTROL -- \
		python3 -c 'import os, pathlib, subprocess, sys
home = pathlib.Path(os.environ["HOME"]).resolve()
scratch = pathlib.Path(os.environ["TMPDIR"]).resolve()
assert home.is_relative_to(scratch)
for name in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "GIT_CONFIG_GLOBAL"):
    assert pathlib.Path(os.environ[name]).resolve().is_relative_to(home)
assert pathlib.Path(os.environ["GIT_CEILING_DIRECTORIES"]).resolve() == pathlib.Path.cwd().resolve().parent.parent
assert pathlib.Path(os.environ["GIT_CONFIG_GLOBAL"]).is_file()
assert subprocess.run(["git", "config", "--global", "--get", "user.email"],
    check=True, text=True, capture_output=True).stdout.strip() == "omp-kit-tests@example.invalid"
assert os.environ["HERMETIC_CONTROL"] == "declared"
for name in ("AGENT_NAME", "AGENT_MAIL_TOKEN", "FLEET_GUARD_LIVE", "OMP_KIT_UNDECLARED", "TMUX"):
    assert name not in os.environ, name
assert os.environ["PATH"] and os.environ["LANG"]
pathlib.Path(os.environ["TMPDIR"], "scratch-write").write_text("allowed")
pathlib.Path.cwd().joinpath("archive-write").write_text("allowed")
workdir = subprocess.run(["sh", sys.argv[1], "--workdir"], check=True,
    text=True, capture_output=True)
workdir_path = pathlib.Path(workdir.stdout.strip()).resolve()
assert workdir_path.is_relative_to(scratch), (workdir_path, scratch, workdir.stderr)
assert "falling back to /tmp" not in workdir.stderr, workdir.stderr
print("HERMETIC_HELPER_CONTROL", flush=True)' "$KITROOT_DIR/scripts/runtime-adapter.sh"
) >"$helper_out" 2>&1; then helper_rc=0; else helper_rc=$?; fi
if [ "$helper_rc" -eq 0 ] && grep -F 'HERMETIC_HELPER_CONTROL' "$helper_out" >/dev/null \
	&& grep -F 'suite=tests/cli/fixture_test.py' "$helper_out" >/dev/null \
	&& grep -F 'allow=' "$helper_out" >/dev/null \
	&& grep -F "home=\"$helper_scratch/home\"" "$helper_out" >/dev/null \
	&& grep -F 'fence=' "$helper_out" >/dev/null \
	&& grep -F 'policy_sha256=' "$helper_out" >/dev/null \
	&& ! grep -F 'synthetic-token-never-real' "$helper_out" >/dev/null \
	&& ! grep -F 'xcrun_db' "$helper_out" >/dev/null; then
	ok "the shared helper logs suite authority without values and keeps declared env with owned HOME/Git config"
else
	not_ok "shared helper environment control failed (rc=$helper_rc)"; cat "$helper_out"
fi
git_shim_out="$TMP/hermetic-git-shim.out"
if (
	cd "$helper_archive/work"
	env PATH="$helper_scratch/bin:/usr/bin:/bin" \
		sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
		--suite tests/cli/fixture_test.py --loopback-port "$helper_loopback_port" -- \
		python3 -c 'import pathlib, subprocess
repo = pathlib.Path("git-shim-probe")
created = subprocess.run(["git", "init", "-q", str(repo)], text=True, capture_output=True)
assert created.returncode == 0, created.stderr
assert "xcrun_db-" not in created.stderr, created.stderr
resolved = subprocess.run(["git", "rev-parse", "--git-dir"], cwd=repo, text=True, capture_output=True)
assert resolved.returncode == 0 and resolved.stdout.strip() == ".git", (resolved.stdout, resolved.stderr)
assert "xcrun_db-" not in resolved.stderr, resolved.stderr
print("HERMETIC_GIT_SHIM_CONTROL")'
) >"$git_shim_out" 2>&1; then
	git_shim_rc=0
else
	git_shim_rc=$?
fi
if [ "$git_shim_rc" -eq 0 ] && grep -F 'HERMETIC_GIT_SHIM_CONTROL' "$git_shim_out" >/dev/null \
	&& ! grep -F 'xcrun_db-' "$git_shim_out" >/dev/null; then
	ok "suite helper replaces the xcrun system Git shim with the developer Git executable"
else
	not_ok "suite helper's developer Git control failed (rc=$git_shim_rc)"; cat "$git_shim_out"
fi
helper_override_out="$TMP/hermetic-helper-override.out"
helper_override_rc=0
env OMP_KIT_TEST_WORK_ROOT="$helper_override_scratch" \
	sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
	--suite tests/cli/fixture_test.py --loopback-port "$helper_loopback_port" \
	--allow-env OMP_KIT_TEST_WORK_ROOT -- \
	sh "$KITROOT_DIR/scripts/runtime-adapter.sh" --workdir \
	>"$helper_override_out" 2>&1 || helper_override_rc=$?
if [ "$helper_override_rc" -ne 0 ] \
	&& ! grep -F "$helper_override_scratch/omp-kit-work." "$helper_override_out" >/dev/null; then
	ok "suite helper prevents caller override of the runtime adapter work root"
else
	not_ok "suite helper allowed caller override of the runtime adapter work root"
	cat "$helper_override_out"
fi
helper_python="$helper_scratch/bin/python3"
[ -x "$helper_python" ] || helper_python=$(command -v python3)
helper_out="$TMP/hermetic-sentinel-probe.out"
if "$helper_python" - "$helper" "$helper_archive" "$helper_scratch" <<'PY' >"$helper_out" 2>&1
import os
import socket
import subprocess
import sys
import threading

helper, archive, scratch = sys.argv[1:]
python = os.path.join(scratch, "bin", "python3")
if not os.path.isfile(python):
    python = sys.executable
token = "synthetic-token-never-real"
fixture = """import os, socket, sys
mode, expected_port, expected_token = sys.argv[1:]
names = ("FLEET_GUARD_LIVE", "AGENT_MAIL_TOKEN", "HERMETIC_SENTINEL_PORT")
if mode == "scrubbed":
    assert all(name not in os.environ for name in names), names
    print("HERMETIC_SENTINEL_SCRUBBED")
else:
    assert os.environ["FLEET_GUARD_LIVE"] == "1"
    assert os.environ["AGENT_MAIL_TOKEN"] == expected_token
    port = int(os.environ["HERMETIC_SENTINEL_PORT"])
    assert port == int(expected_port)
    with socket.create_connection(("127.0.0.1", port), timeout=2) as connection:
        connection.sendall(b"x")
    print("HERMETIC_SENTINEL_DIAL")
"""

for mode, allow in (("scrubbed", False), ("control", True)):
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    port = int(os.environ.get("KIT_TEST_LOOPBACK_PORT", "0"))
    server.bind(("127.0.0.1", port))
    server.listen(1)
    server.settimeout(2)
    port = server.getsockname()[1]
    seen = []

    def accept_one():
        try:
            connection, _address = server.accept()
        except socket.timeout:
            return
        with connection:
            seen.append(connection.recv(1))

    thread = threading.Thread(target=accept_one)
    thread.start()
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "TMPDIR": os.environ["TMPDIR"],
        "LANG": os.environ.get("LANG", "C"),
        "OMP_KIT_SUITE_HERMETIC_ENABLE": "1",
        "FLEET_GUARD_LIVE": "1",
        "AGENT_MAIL_TOKEN": token,
        "HERMETIC_SENTINEL_PORT": str(port),
        "KIT_TEST_LOOPBACK_PORT": str(port),
    }
    command = [
        "sh", helper, "--archive", archive, "--scratch", scratch,
        "--suite", "tests/cli/fixture_test.py",
    ]
    if allow:
        for name in ("FLEET_GUARD_LIVE", "AGENT_MAIL_TOKEN", "HERMETIC_SENTINEL_PORT"):
            command.extend(("--allow-env", name))
    command.extend(("--", python, "-c", fixture, mode, str(port), token))
    result = subprocess.run(command, cwd=os.path.join(archive, "work"), env=env,
                            text=True, capture_output=True)
    thread.join(3)
    server.close()
    expected = 1 if allow else 0
    if (result.returncode != 0 or len(seen) != expected
            or (allow and b"x" not in seen)
            or token in result.stdout or token in result.stderr):
        raise AssertionError(
            f"{mode}: rc={result.returncode} connections={seen} "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )
    marker = "HERMETIC_SENTINEL_DIAL" if allow else "HERMETIC_SENTINEL_SCRUBBED"
    if marker not in result.stdout:
        raise AssertionError(f"{mode}: missing {marker}: {result.stdout!r}")
    print(f"{marker} connections={len(seen)}", flush=True)
PY
then
	if grep -F 'HERMETIC_SENTINEL_SCRUBBED connections=0' "$helper_out" >/dev/null \
		&& grep -F 'HERMETIC_SENTINEL_DIAL connections=1' "$helper_out" >/dev/null; then
		ok "a synthetic live-service sentinel is scrubbed with zero dials and connects only when declared"
	else
		not_ok "synthetic live-service sentinel control did not prove zero/one dials"; cat "$helper_out"
	fi
else
	not_ok "synthetic live-service sentinel fixture failed"; cat "$helper_out"
fi


# A local owned stub proves that the network probe records a dial on its allowed loopback port.
helper_out="$TMP/hermetic-network-control.out"
if "$helper_python" -c 'import os, socket, threading
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
port = int(os.environ.get("KIT_TEST_LOOPBACK_PORT", "0"))
server.bind(("127.0.0.1", port))
server.listen()
server.settimeout(2)
port = server.getsockname()[1]
seen = []
def accept_one():
    connection, _ = server.accept()
    with connection:
        seen.append(connection.recv(1))
thread = threading.Thread(target=accept_one)
thread.start()
with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
    client.sendall(b"x")
thread.join(2)
server.close()
assert seen == [b"x"], seen
print("HERMETIC_NETWORK_CONTROL dial-recorded")' >"$helper_out" 2>&1; then
	ok "the local network control reaches only its allowed owned stub and records the dial"
else
	not_ok "local owned-stub network control failed"; cat "$helper_out"
fi
if [ "$(uname -s)" = Darwin ]; then
	helper_out="$TMP/hermetic-helper-denied.out"
	if (
		cd "$helper_archive/work"
		sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
			--suite tests/cli/fixture_test.py -- \
			python3 -c 'import pathlib, sys; pathlib.Path(sys.argv[1]).write_text("changed")' "$protected"
	) >"$helper_out" 2>&1; then helper_rc=0; else helper_rc=$?; fi
	if [ "$helper_rc" -ne 0 ] && grep -F "$protected" "$helper_out" >/dev/null \
		&& cmp -s "$protected.before" "$protected"; then
		ok "the macOS write fence names and blocks an outside-scratch path without changing its bytes"
	else
		not_ok "the macOS write fence failed its outside-scratch negative (rc=$helper_rc)"; cat "$helper_out"
	fi
	helper_out="$TMP/hermetic-helper-symlink.out"
	if (
		cd "$helper_archive/work"
		sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
			--suite tests/cli/fixture_test.py -- \
			python3 -c 'import os, pathlib, sys
link = pathlib.Path(os.environ["TMPDIR"], "escape")
link.symlink_to(sys.argv[1])
link.write_text("changed")' "$protected"
	) >"$helper_out" 2>&1; then helper_rc=0; else helper_rc=$?; fi
	if [ "$helper_rc" -ne 0 ] && grep -F "$helper_scratch/escape" "$helper_out" >/dev/null \
		&& cmp -s "$protected.before" "$protected"; then
		ok "the macOS write fence blocks a symlink escape from suite scratch"
	else
		not_ok "the macOS write fence failed its symlink-escape negative (rc=$helper_rc)"; cat "$helper_out"
	fi
	helper_out="$TMP/hermetic-loopback.out"
	if (
		cd "$helper_archive/work"
		sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
			--suite tests/cli/fixture_test.py -- \
			python3 -c 'import os, socket, threading
port = int(os.environ["KIT_TEST_LOOPBACK_PORT"])
server = socket.socket()
server.bind(("127.0.0.1", port))
server.listen()
server.settimeout(2)
seen = []
def accept_one():
    connection, _ = server.accept()
    with connection:
        seen.append(connection.recv(1))
thread = threading.Thread(target=accept_one)
thread.start()
with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
    client.sendall(b"x")
thread.join(2)
server.close()
assert seen == [b"x"], seen
print("HERMETIC_LOOPBACK_POSITIVE")'
	) >"$helper_out" 2>&1; then helper_rc=0; else helper_rc=$?; fi
	if [ "$helper_rc" -eq 0 ] && grep -F 'HERMETIC_LOOPBACK_POSITIVE' "$helper_out" >/dev/null; then
		ok "the macOS network fence allows its suite-owned loopback port"
	else
		not_ok "the macOS network fence rejected its suite-owned loopback port (rc=$helper_rc)"; cat "$helper_out"
	fi
	helper_out="$TMP/hermetic-fixed-port.out"
	if (
		cd "$helper_archive/work"
		sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
			--suite tests/cli/fixture_test.py -- \
			python3 -c 'import errno, socket
probe = socket.socket()
result = probe.connect_ex(("127.0.0.1", 8765))
probe.close()
assert result == errno.EPERM, result
print("HERMETIC_FIXED_PORT_DENIED 127.0.0.1:8765")'
	) >"$helper_out" 2>&1; then helper_rc=0; else helper_rc=$?; fi
	if [ "$helper_rc" -eq 0 ] && grep -F 'HERMETIC_FIXED_PORT_DENIED 127.0.0.1:8765' "$helper_out" >/dev/null; then
		ok "the macOS network fence denies the fixed live Agent Mail port"
	else
		not_ok "the macOS network fence did not deny 127.0.0.1:8765 (rc=$helper_rc)"; cat "$helper_out"
fi
	helper_out="$TMP/hermetic-fixed-port-allow.out"
	if (
		cd "$helper_archive/work"
		sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
			--suite tests/cli/fixture_test.py --loopback-port 8765 -- \
			python3 -c 'print("INVALID_LOOPBACK_LAUNCHED")'
	) >"$helper_out" 2>&1; then helper_rc=0; else helper_rc=$?; fi
	if [ "$helper_rc" -eq 125 ] \
		&& grep -F 'SUITE-HERMETIC: REFUSED invalid suite loopback port 8765' "$helper_out" >/dev/null \
		&& ! grep -F 'INVALID_LOOPBACK_LAUNCHED' "$helper_out" >/dev/null; then
		ok "the helper refuses 127.0.0.1:8765 as a requested suite port"
	else
		not_ok "the helper allowed or misreported a request for fixed port 8765 (rc=$helper_rc)"; cat "$helper_out"
	fi

	helper_out="$TMP/hermetic-external-egress.out"
	if (
		cd "$helper_archive/work"
		sh "$helper" --archive "$helper_archive" --scratch "$helper_scratch" \
			--suite tests/cli/fixture_test.py -- \
			python3 -c 'import errno, socket
probe = socket.socket()
result = probe.connect_ex(("203.0.113.1", 9))
probe.close()
assert result == errno.EPERM, result
print("HERMETIC_EXTERNAL_EGRESS_DENIED 203.0.113.1:9")'
	) >"$helper_out" 2>&1; then helper_rc=0; else helper_rc=$?; fi
	if [ "$helper_rc" -eq 0 ] && grep -F 'HERMETIC_EXTERNAL_EGRESS_DENIED 203.0.113.1:9' "$helper_out" >/dev/null; then
		ok "the macOS network fence denies external egress"
	else
		not_ok "the macOS network fence did not deny external egress (rc=$helper_rc)"; cat "$helper_out"
	fi
fi

# Suites start with SIGINT at its default, as in a foreground run. The runner launches them in a
# background list, which a non-interactive shell starts with SIGINT ignored; kitlib_tmp_test's
# SIGINT case failed only under this runner (ompkit-lrbd.3).
mkrepo sigdfl 'import signal, sys
handler = signal.getsignal(signal.SIGINT)
print("FULLSUITE-SIGINT handler:", handler)
sys.exit(0 if handler is signal.default_int_handler else 1)'
run_verdict sigdfl
if [ "$rc" -eq 0 ] && grep -F 'VERDICT PASS' "$out" >/dev/null; then
	ok "suites start with the default SIGINT disposition"
else
	not_ok "a suite started with SIGINT not at its default (rc=$rc)"; cat "$out"
fi

# A suite receives an inherited cache path only if the helper fails to scrub it. Killing the
# suite's supervisor still leaves the run incomplete; a child cannot forge reusable runner state.
mkrepo_begin forged
# shellcheck disable=SC2016 # the fixture body is literal shell, expanded by the suite
addfile tests/cli/a.test.sh 'if [ "${FORGE_DIR+x}" = x ]; then
	echo "FULLSUITE-FORGE-LEAKED"
	exit 98
fi
echo "FULLSUITE-FORGE-SCRUBBED"
kill -9 "$PPID"'
addfile tests/cli/b.test.sh 'echo "FULLSUITE-B ran"'
mkrepo_commit
mkdir -p "$repo.cache"
FORGE_DIR="$repo.cache"; export FORGE_DIR
run_verdict forged
unset FORGE_DIR
cache="$repo.cache"
inc=$incomplete_log
if [ "$rc" -ne 0 ] && grep -F 'per-file timing evidence is incomplete' "$out" >/dev/null \
	&& [ ! -e "$cache/$tree.json" ] && [ -f "$inc" ] \
	&& grep -F 'FULLSUITE-FORGE-SCRUBBED' "$inc" >/dev/null \
	&& ! grep -F 'FULLSUITE-FORGE-LEAKED' "$inc" >/dev/null; then
	ok "the cache path is scrubbed and killing a suite supervisor cannot produce complete evidence"
else
	not_ok "a suite leaked its cache path or created complete evidence after supervisor death (rc=$rc)"; cat "$out"
	[ ! -f "$inc" ] || cat "$inc"
fi

# (a) Nested markers: a shell suite that itself prints the runner's marker lines (as a nested
# fresh-gate or bun fixture inside a test does) and exits 0. They must not count: complete PASS.
mkrepo_begin nested
addfile tests/cli/nested.test.sh 'echo "GREEN script-suite tests/cli/not-a-suite.test.sh"
echo "GREEN python-suite tests/cli/not_a_suite_test.py"
echo " 0 fail"
exit 0'
addfile tests/cli/fixture_test.py 'print("FULLSUITELOG1-NESTED ok")'
mkrepo_commit
run_verdict nested
cache="$repo.cache"
if [ "$rc" -eq 0 ] && grep -F 'VERDICT PASS' "$out" >/dev/null && grep -F 'shell=1 python=1' "$out" >/dev/null; then
	ok "nested marker lines are not counted: complete PASS"
else
	not_ok "nested markers corrupted the verdict (rc=$rc)"; cat "$out"
fi
if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "PASS"' "$cache/$tree.json" >/dev/null; then ok "nested-marker run caches PASS"; else not_ok "nested-marker run cached no PASS"; fi
if side_files_gone; then ok "runner side files removed"; else not_ok "runner side files left in cache"; ls -la "$cache"; fi

# (b) Masking: the bun phase has a real failing test; a later shell suite prints a nested bun
# summary claiming ' 0 fail'. The verdict must be FAIL, taken from the bun phase's own output.
if command -v bun >/dev/null 2>&1; then
	mkrepo_begin masked
	addfile tests/cli/real.test.ts 'import { expect, test } from "bun:test";
test("FULLSUITELOG1 real failure", () => { expect(1).toBe(2); });'
	addfile worker-control.txt 'ready'
	addfile tests/cli/worker-control.test.ts 'import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("FULLSUITELOG1 passing worker reads the candidate", () => { expect(readFileSync("worker-control.txt", "utf8").trim()).toBe("ready"); });'
	addfile tests/cli/later.test.sh 'echo " 1 pass"
echo " 0 fail"
echo "Ran 1 test across 1 file. [5.00ms]"
exit 0'
	mkrepo_commit
	run_verdict masked
	cache="$repo.cache"
	if [ "$rc" -ne 0 ] && grep -F 'VERDICT FAIL' "$out" >/dev/null && grep -F 'bun_fail=1' "$out" >/dev/null; then
		ok "a real bun failure is not masked by a later nested ' 0 fail' (rc=$rc)"
	else
		not_ok "nested bun summary masked the real failure (rc=$rc)"; cat "$out"
	fi
	if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "FAIL"' "$cache/$tree.json" >/dev/null; then ok "masked run caches FAIL"; else not_ok "masked run cached no FAIL"; fi
	if python3 - "$cache/$tree.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    verdict = json.load(source)
evidence = verdict["evidence"]
sys.exit(0 if verdict["verdict"] == "FAIL" and evidence["complete"] and
         evidence["bun_files"] == 2 and evidence["bun_ran"] == 2 and evidence["bun_fail"] == 1 else 1)
PY
	then ok "the passing worker cannot hide the failing worker in the cached verdict"
	else not_ok "parallel worker failure was not fully accounted for"; cat "$out"
	fi

	# The matched positive changes only the failing candidate, not the judge:
	# its new tree must cache a complete PASS after the previous tree's FAIL.
	addfile tests/cli/real.test.ts 'import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("FULLSUITELOG1 recovered worker reads the candidate", () => { expect(readFileSync("worker-control.txt", "utf8").trim()).toBe("ready"); });'
	git -C "$repo" add -- tests/cli/real.test.ts
	git -C "$repo" commit -q -m "[test] FULLSUITELOG1 recovered candidate"
	run_verdict recovered
	cache="$repo.cache"
	if [ "$rc" -eq 0 ] && python3 - "$cache/$tree.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    verdict = json.load(source)
evidence = verdict["evidence"]
sys.exit(0 if verdict["verdict"] == "PASS" and evidence["complete"] and
         evidence["bun_files"] == 2 and evidence["bun_ran"] == 2 and evidence["bun_fail"] == 0 else 1)
PY
	then ok "the recovered candidate caches a complete passing verdict"
	else not_ok "the recovered candidate did not pass completely"; cat "$out"
	fi

	# (c) A bun phase cut off by the suite deadline still leaves its partial output in the kept
	# incomplete log: the dying runner copies it, or finish_logs appends it when the runner was
	# killed before it could.
	mkrepo_begin bunslow
	addfile tests/cli/slow.test.ts 'import { test } from "bun:test";
test("FULLSUITELOG1 slow", async () => { console.log("FULLSUITELOG1-BUNPARTIAL"); await Bun.sleep(60000); }, 120000);'
	mkrepo_commit
	FULL_SUITE_TIMEOUT_SECS=4; export FULL_SUITE_TIMEOUT_SECS
	run_verdict bunslow
	unset FULL_SUITE_TIMEOUT_SECS
	cache="$repo.cache"
inc=$incomplete_log
	if [ "$rc" -ne 0 ] && grep -F 'timed out' "$out" >/dev/null && [ ! -e "$cache/$tree.json" ] \
		&& grep -F 'FULLSUITELOG1-BUNPARTIAL' "$inc" >/dev/null 2>&1; then
		ok "a timed-out bun phase leaves its partial output in the incomplete log"
	else
		not_ok "timed-out bun partial output missing from the incomplete log (rc=$rc)"; cat "$out"; [ -f "$inc" ] && cat "$inc"
	fi
	if side_files_gone; then ok "timed-out run removes runner side files"; else not_ok "timed-out run left runner side files"; ls -la "$cache"; fi
else
	not_ok "bun is unavailable; the masking case cannot run"
fi

# The runner rejects caller-provided BEADS_DB before suites start. Keep a nonempty
# native sentinel to detect any unintended writes from the scratch-local tracker fixture.
if command -v br >/dev/null 2>&1; then
	actor=${AGENT_NAME:-full-suite-fixture}
	sentinel="$TMP/native-sentinel"
	sentinel_db="$sentinel/.beads/beads.db"
	mkdir -p "$sentinel"
	git -C "$sentinel" init -q
	if (cd "$sentinel" && br --db "$sentinel_db" --actor "$actor" --no-auto-import --no-auto-flush init --prefix sentinel --json) >"$TMP/sentinel-init.out" 2>&1 \
		&& br --db "$sentinel_db" --actor "$actor" --no-auto-import --no-auto-flush create "retained sentinel" --json >"$TMP/sentinel-seed.out" 2>&1 \
		&& br --db "$sentinel_db" --actor "$actor" --no-auto-import --no-auto-flush list --limit 0 --json >"$TMP/sentinel-before.json" 2>"$TMP/sentinel-before.err"; then
		mkrepo_begin native_tracker
		cp "$KITROOT_DIR/scripts/kitlib_run.py" "$KITROOT_DIR/scripts/pysafe.py" "$repo/scripts/"
		addfile tests/cli/tracker_test.py 'import json, os, sys
from pathlib import Path
sys.path.insert(0, "scripts")
from kitlib_run import run

actor = os.environ.get("AGENT_NAME", "full-suite-fixture")
def br(*args, cwd=None):
    result = run(["br", "--actor", actor, "--no-auto-import", "--no-auto-flush", *args],
                 deadline_s=20, max_output_bytes=1048576, cwd=cwd)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    assert result.rc == 0 and not result.truncated and not result.timed_out
    return json.loads(result.stdout)

result = run(["git", "init", "-q"], deadline_s=20)
assert result.rc == 0, result.stderr.decode()
db = Path.cwd() / ".beads" / "beads.db"
br("--db", str(db), "init", "--prefix", "suite", "--json")
created = br("create", "default suite database", "--json")
assert created["id"].startswith("suite-"), created
rows = br("--db", str(db), "list", "--limit", "0", "--json")
rows = rows["issues"] if isinstance(rows, dict) else rows
assert [row["id"] for row in rows] == [created["id"]]

# A test may still deliberately choose a different owned tracker after launch.
chosen_root = Path.cwd() / "chosen"
chosen_root.mkdir()
result = run(["git", "init", "-q", str(chosen_root)], deadline_s=20)
assert result.rc == 0, result.stderr.decode()
chosen = chosen_root / ".beads" / "beads.db"
br("--db", str(chosen), "init", "--prefix", "chosen", "--json", cwd=chosen_root)
os.environ["BEADS_DB"] = str(chosen)
explicit = br("create", "explicit suite database", "--json")
assert explicit["id"].startswith("chosen-"), explicit
rows = br("--db", str(chosen), "list", "--limit", "0", "--json")
rows = rows["issues"] if isinstance(rows, dict) else rows
assert [row["id"] for row in rows] == [explicit["id"]]'
		mkrepo_commit
		run_verdict native_tracker
		if [ "$rc" -eq 0 ]; then ok "native suite uses only its scratch-selected tracker rows"
		else not_ok "native suite failed its scratch-local tracker checks (rc=$rc)"; cat "$out"
		fi
		[ ! -f "$repo.cache/$tree.log" ] || cat "$repo.cache/$tree.log"
		if br --db "$sentinel_db" --actor "$actor" --no-auto-import --no-auto-flush list --limit 0 --json >"$TMP/sentinel-after.json" 2>"$TMP/sentinel-after.err" \
			&& python3 - "$TMP/sentinel-before.json" "$TMP/sentinel-after.json" <<'PY'
import json, sys
from pathlib import Path
before, after = (json.loads(Path(path).read_text(encoding="utf-8")) for path in sys.argv[1:])
before_rows = before["issues"] if isinstance(before, dict) else before
assert len(before_rows) == 1
assert after == before, (before, after)
print("NATIVEFIXTUREDB1 retained native sentinel:", json.dumps(after, sort_keys=True))
PY
		then ok "scratch-local tracker operations leave the nonempty native sentinel unchanged"
		else not_ok "the declared suite mutated or could not inventory its native sentinel"
		fi
	else
		not_ok "native tracker fixture initialization failed"
		cat "$TMP/sentinel-init.out" "$TMP/sentinel-seed.out" "$TMP/sentinel-before.err" 2>/dev/null
	fi
else
	echo "NATIVEFIXTUREDB1: optional native br adapter unavailable; native tracker case NOT_RUN"
fi

# FULLSUITEPAR1 (ompkit-9t6f2): shell suites run FULL_SUITE_SHELL_JOBS at a time. Five probe suites
# record their TMPDIR, how many suites were running at once, and (p1/p2 when FSPAR_PAIR=1) whether
# their partner ran at the same time; p3 fails with rc 3, and finishing order is not the sorted order.
# shellcheck disable=SC2016 # the fixture body is literal shell, expanded by the suite
fspar_body='name=$(basename "$0" .test.sh)
echo "FSPAR-OUT $name begin"
suite_tmp=$(printenv TMPDIR) || suite_tmp=
owner=0
[ ! -n "$suite_tmp" ] || [ ! -f "$suite_tmp/.owner" ] || owner=1
start=$(python3 -c "import time; print(time.time_ns())")
echo "FSPAR-OBS START name=$name t=$start tmp=$suite_tmp owner=$owner"
sleep 0.5
case "$name" in p1) sleep 1 ;; p3) sleep 0.4 ;; p4) sleep 0.2 ;; esac
finish=$(python3 -c "import time; print(time.time_ns())")
echo "FSPAR-OBS END name=$name t=$finish"
echo "FSPAR-OUT $name end"
[ "$name" != p3 ] || exit 3'
mkrepo_begin par
for n in p1 p2 p3 p4 p5; do addfile "tests/cli/$n.test.sh" "$fspar_body"; done
mkrepo_commit
# fspar_run LABEL JOBS: one verdict on the par tree; its cache and recorded observations move aside.
fspar_run() {
	rm -rf "$TMP/fspar" "$repo.cache"
	mkdir -p "$TMP/fspar"
	FULL_SUITE_SHELL_JOBS=$2
	export FULL_SUITE_SHELL_JOBS
	run_verdict "$1"
	unset FULL_SUITE_SHELL_JOBS
	rm -rf "$repo.cache.$1" "$TMP/fspar.$1"
	mv "$repo.cache" "$repo.cache.$1"
	mv "$TMP/fspar" "$TMP/fspar.$1"
}
fspar_lines() { grep -E '^(GREEN|RED) script-suite ' "$repo.cache.$1/$tree.log"; }
fspar_order() { grep -E '^(FSPAR-OUT |GREEN script-suite |RED script-suite )' "$repo.cache.$1/$tree.log"; }
fspar_counts() { python3 -c 'import json, sys; e = json.load(open(sys.argv[1]))["evidence"]; print(e["shell_suites"], e["shell_fail"])' "$repo.cache.$1/$tree.json"; }
fspar_metrics() {
	python3 - "$repo.cache.$1/$tree.log" <<'PY'
import sys
from pathlib import Path

starts, finishes, scratch, owners = {}, {}, set(), []
for line in Path(sys.argv[1]).read_text().splitlines():
    if not line.startswith("FSPAR-OBS "):
        continue
    parts = line.split()
    fields = dict(part.split("=", 1) for part in parts[2:])
    name = fields.get("name")
    if parts[1] == "START":
        starts[name] = int(fields["t"])
        scratch.add(fields["tmp"])
        owners.append(fields["owner"])
    elif parts[1] == "END":
        finishes[name] = int(fields["t"])
if set(starts) != {"p1", "p2", "p3", "p4", "p5"} or set(finishes) != set(starts):
    print("0 0 0 0")
    raise SystemExit(0)
events = [(start, 1) for start in starts.values()]
events.extend((finish, -1) for finish in finishes.values())
active = peak = 0
for _when, delta in sorted(events):
    active += delta
    peak = max(peak, active)
overlap = int(max(starts["p1"], starts["p2"]) < min(finishes["p1"], finishes["p2"]))
print(peak, len(scratch), sum(owner == "1" for owner in owners), overlap)
PY
}
fspar_run serial 1
serial_out=$out; serial_rc=$rc
fspar_run parallel 3
if [ "$serial_rc" -ne 0 ] && [ "$rc" -ne 0 ] && grep -F 'VERDICT FAIL' "$out" >/dev/null && grep -F 'shell_red=1' "$out" >/dev/null; then
	ok "FULLSUITEPAR1 planted failing suite makes the parallel run FAIL (serial rc=$serial_rc, parallel rc=$rc)"
else
	not_ok "FULLSUITEPAR1 planted failing suite did not fail both runs (serial rc=$serial_rc, parallel rc=$rc)"; cat "$serial_out" "$out"
fi
if grep -F '  RED script-suite tests/cli/p3.test.sh rc=3' "$out" >/dev/null; then ok "FULLSUITEPAR1 the parallel FAIL names the failing suite"; else not_ok "FULLSUITEPAR1 the failing suite is not named"; cat "$out"; fi
if [ -n "$(fspar_lines serial)" ] && [ "$(fspar_lines serial | sort)" = "$(fspar_lines parallel | sort)" ]; then
	ok "FULLSUITEPAR1 serial and parallel GREEN/RED line sets are equal"
else
	not_ok "FULLSUITEPAR1 GREEN/RED line sets differ"; fspar_lines serial; fspar_lines parallel
fi
if [ "$(fspar_counts serial)" = "5 1" ] && [ "$(fspar_counts parallel)" = "5 1" ]; then ok "FULLSUITEPAR1 verdict JSON shell_suites/shell_fail match (5 1)"; else not_ok "FULLSUITEPAR1 verdict JSON counts serial='$(fspar_counts serial)' parallel='$(fspar_counts parallel)'"; fi
want_order=$(for n in p1 p2 p3 p4 p5; do
	printf 'FSPAR-OUT %s begin\nFSPAR-OUT %s end\n' "$n" "$n"
	if [ "$n" = p3 ]; then echo "RED script-suite tests/cli/p3.test.sh rc=3"; else echo "GREEN script-suite tests/cli/$n.test.sh"; fi
done)
if [ "$(fspar_order serial)" = "$want_order" ] && [ "$(fspar_order parallel)" = "$want_order" ]; then
	ok "FULLSUITEPAR1 both logs hold each suite's output then its line, in sorted suite order"
else
	not_ok "FULLSUITEPAR1 log order depends on the run"; fspar_order serial; fspar_order parallel
fi
IFS=' ' read -r parallel_peak parallel_tmp_count parallel_owned_count parallel_overlap <<EOF
$(fspar_metrics parallel)
EOF
IFS=' ' read -r serial_peak serial_tmp_count serial_owned_count _ <<EOF
$(fspar_metrics serial)
EOF
if [ "$parallel_overlap" = 1 ] && [ "$parallel_peak" -ge 2 ] && [ "$parallel_peak" -le 3 ]; then
	ok "FULLSUITEPAR1 shell suites overlap within the 3-worker bound (peak $parallel_peak)"
else
	not_ok "FULLSUITEPAR1 shell suites did not overlap within the bound (peak $parallel_peak)"; cat "$repo.cache.parallel/$tree.log"
fi
if [ "$serial_peak" = 1 ]; then ok "FULLSUITEPAR1 FULL_SUITE_SHELL_JOBS=1 runs one suite at a time"; else not_ok "FULLSUITEPAR1 jobs=1 peak $serial_peak"; fi
if [ "$parallel_tmp_count" = 5 ] && [ "$parallel_owned_count" = 5 ] \
	&& [ "$serial_tmp_count" = 5 ] && [ "$serial_owned_count" = 5 ]; then
	ok "FULLSUITEPAR1 every serial and parallel suite ran under a distinct owned TMPDIR"
else
	not_ok "FULLSUITEPAR1 suites shared or lacked an owned TMPDIR (parallel=$parallel_tmp_count/$parallel_owned_count serial=$serial_tmp_count/$serial_owned_count)"
fi
if grep -F 'shell stage: 5 suites, 3 at a time' "$repo.cache.parallel/$tree.log" >/dev/null; then ok "FULLSUITEPAR1 the log records the shell stage width and time"; else not_ok "FULLSUITEPAR1 no shell stage line in the log"; fi

# Planted hang: h2 loops on short sleeps, so killing only a leaf would let it run on. With three
# workers the deadline must kill the hung suite's whole tree, report it by name and stay incomplete.
mkrepo_begin parhang
addfile tests/cli/h1.test.sh 'echo "FSPAR-HANG-QUICK"'
# shellcheck disable=SC2016 # the fixture body is literal shell, expanded by the suite
addfile tests/cli/h2.test.sh 'echo "FSPAR-HANG-PARTIAL pid=$$"
n=0
while [ "$n" -lt 40 ]; do sleep 1; n=$((n + 1)); done
echo "FSPAR-HANG-SURVIVED"'
addfile tests/cli/h3.test.sh 'echo "FSPAR-HANG-QUICK-3"'
mkrepo_commit
FULL_SUITE_SHELL_JOBS=3 FULL_SUITE_TIMEOUT_SECS=6
export FULL_SUITE_SHELL_JOBS FULL_SUITE_TIMEOUT_SECS
hang_t0=$(date +%s)
run_verdict parhang
hang_wall=$(($(date +%s) - hang_t0))
unset FULL_SUITE_SHELL_JOBS FULL_SUITE_TIMEOUT_SECS
cache="$repo.cache"
inc=$incomplete_log
if [ "$rc" -ne 0 ] && grep -F 'timed out after 6s; unfinished script suites: tests/cli/h2.test.sh;' "$out" >/dev/null && [ ! -e "$cache/$tree.json" ] && [ ! -e "$cache/$tree.log" ]; then
	ok "FULLSUITEPAR1 a hung parallel suite times the run out, named, nothing cached (rc=$rc)"
else
	not_ok "FULLSUITEPAR1 hung suite not reported as an unfinished timeout (rc=$rc)"; cat "$out"
fi
if [ "$hang_wall" -le 25 ]; then ok "FULLSUITEPAR1 the deadline ended the run (${hang_wall}s for a 6s bound)"; else not_ok "FULLSUITEPAR1 the run went on ${hang_wall}s past a 6s bound"; fi
if [ -f "$inc" ] && grep -F 'FSPAR-HANG-PARTIAL' "$inc" >/dev/null && grep -F 'script-suite tests/cli/h2.test.sh did not finish' "$inc" >/dev/null \
	&& grep -F 'FSPAR-HANG-QUICK' "$inc" >/dev/null && ! grep -F 'FSPAR-HANG-SURVIVED' "$inc" >/dev/null; then
	ok "FULLSUITEPAR1 the incomplete log keeps every suite's output and the hung suite's partial output"
else
	not_ok "FULLSUITEPAR1 incomplete log lacks parallel outputs or the hung suite survived"; [ -f "$inc" ] && cat "$inc"
fi
hang_marker=$(grep -F 'FSPAR-HANG-PARTIAL pid=' "$inc" 2>/dev/null) || hang_marker=
hang_pid=${hang_marker##*pid=}
k=0
while [ -n "$hang_pid" ] && kill -0 "$hang_pid" 2>/dev/null && [ "$k" -lt 50 ]; do sleep 0.1; k=$((k + 1)); done
if [ -n "$hang_pid" ] && ! kill -0 "$hang_pid" 2>/dev/null; then ok "FULLSUITEPAR1 the hung suite process is gone"; else not_ok "FULLSUITEPAR1 hung suite pid ${hang_pid:-?} still runs"; fi
if side_files_gone; then ok "FULLSUITEPAR1 timed-out parallel run removes runner side files"; else not_ok "FULLSUITEPAR1 timed-out parallel run left side files"; ls -la "$cache"; fi

echo "full-suite-verdict-incomplete: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
