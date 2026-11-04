#!/bin/sh
# Install the bead-id commit-msg hook, the reference-transaction ref guard,
# the shared-main pre-push member and the pushed-beads pre-push member into a
# repo's hook chains, plus the staged-imports, staged-fragments,
# staged-regexploit, staged-pysafe, staged-tempsafe, staged-kitlib and
# staged-br-init pre-commit members.
# Usage: install-commit-msg-bead.sh [--check] [--no-pushed-beads] [REPO] (default: this kit checkout).
# The shared-main member (scripts/check-pushed-on-main.sh) is always installed:
# it judges only where a push moves the remote main, never old messages.
# The staged-imports member (scripts/check-staged-imports.sh, with
# check-commit-imports.sh beside it) is always installed: it refuses a commit
# whose staged files import a path that is neither staged nor committed.
# The commit-notes member (scripts/check-commit-notes.sh) is always installed:
# it refuses a shipped-path commit the push notes gate would refuse (no single
# Bead: trailer with a changelog.d fragment, and no [no-changelog] reason).
# The deploy-step member (scripts/check-deploy-step.sh) is always installed:
# it requires a runbook/reference change or a Deploy-Step trailer when staged
# paths alter installer, hook-chain, service, or update behavior.
# The staged-fragments member (scripts/check-staged-fragments.sh) is always
# installed: it refuses a commit whose staged changelog.d fragments the repo's
# own scripts/release-notes.sh cannot fold (passes where the repo has none).
# The staged-regexploit member (scripts/check-staged-regexploit.sh) is always
# installed: it refuses a commit whose staged JS/TS/Python files fail the
# repo's own scripts/regexploit-gate.py (passes where the repo has none).
# The staged-pysafe member (scripts/check-staged-pysafe.sh, with pysafe.py and
# pysafe_check.py beside it) is always installed: it refuses a commit whose
# staged .py files add a hang-prone call (no timeout, inherited stdin,
# unbounded wait, read or loop) that HEAD does not already have.
# The staged-tempsafe member (scripts/check-staged-tempsafe.sh, with
# tempsafe_check.py, the kitlib_ratchet_core.py engine it is built on and the
# pysafe.py the engine imports beside it) is
# always installed: it refuses a commit whose staged files add temp creation
# outside kitlib (mkdtemp, tmpdir(), tempfile, mktemp, $TMPDIR, /tmp) that
# HEAD does not already have.
# The staged-kitlib member (scripts/check-staged-kitlib.sh, with
# kitlib_ratchet.py beside the same engine and pysafe.py) is always installed:
# it refuses a commit whose staged files add a hand-rolled copy of a kitlib
# primitive (raw-spawn: subprocess/os/asyncio spawns, Bun.spawn,
# child_process, a call-site `timeout N`) that HEAD does not already have.
# The staged-br-init member (scripts/check-staged-br-init.sh, with
# br_init_check.py beside the same kitlib ratchet engine and pysafe.py) is
# always installed: it refuses a commit whose staged sources add an unpinned
# br init that could lock an ancestor tracker.
# --no-pushed-beads installs the forward-only set (commit-msg + ref guard +
# shared-main member): new id-less commits are refused, existing history is not
# judged. A full install refuses (exit 5) when the unpublished range already
# holds id-less commits, because the pushed-beads member would then block
# every push of that repo.
# For each hook type the installer handles three states: absent (creates a
# chain runner), bespoke (moves the existing entry to hooks.d/<type>/10-<name>
# and creates a runner that calls it first, then ours), chain (adds our
# member). Moving a bespoke entry preserves it byte-for-byte; move it back to
# undo. A foreign REPO gets self-contained copies, never references into this
# checkout. Exits nonzero naming anything left inactive; every install ends
# with a live probe of the installed chain.
# Opt-in native preservation adds a separate pre-commit member, not a
# commit-message rule. Pass --native-preservation --native-br ABS
# --native-br-sha256 SHA --native-guard-sha256 SHA from the reviewed candidate.
# It only preserves an exact native snapshot; it grants no creator/grader role.
# Existing bespoke pre-commit checks remain first. Their owner must retire a
# replaced legacy snapshot checker; this installer never silently bypasses it.
# Optional reviewed template projections: --template-import-map FILE
# --template-import-map-sha256 SHA installs digest-bound data, never candidate
# policy. With no options, existing reviewed data is retained.
set -eu
UNDO_MOVES=""
UNDO_RM=""
UNDO_RESTORE=""
KITROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
MODE=install
POS=""
usage() {
	echo "Usage: install-commit-msg-bead.sh [--check] [--no-pushed-beads] [REPO] (default: this kit checkout)." >&2
}
PUSHED_BEADS=1
NATIVE_PRESERVATION=0
NATIVE_BR=""
NATIVE_BR_SHA=""
NATIVE_GUARD_SHA=""
TEMPLATE_IMPORT_MAP=""
TEMPLATE_IMPORT_MAP_SHA=""
while [ $# -gt 0 ]; do
	case "$1" in
		--check) MODE=check; shift ;;
		--no-pushed-beads) PUSHED_BEADS=0; shift ;;
		--native-preservation) NATIVE_PRESERVATION=1; shift ;;
		--template-import-map|--template-import-map-sha256)
			[ $# -ge 2 ] || { printf 'install-commit-msg-bead: %s needs a value\n' "$1" >&2; exit 2; }
			case "$1" in
				--template-import-map) TEMPLATE_IMPORT_MAP=$2 ;;
				--template-import-map-sha256) TEMPLATE_IMPORT_MAP_SHA=$2 ;;
			esac
			[ -n "$2" ] || { printf 'install-commit-msg-bead: REFUSED empty template-import-map input\n' >&2; exit 2; }
			shift 2 ;;
		--native-br|--native-br-sha256|--native-guard-sha256)
			[ $# -ge 2 ] || { printf 'install-commit-msg-bead: %s needs a value\n' "$1" >&2; exit 2; }
			case "$1" in
				--native-br) NATIVE_BR=$2 ;;
				--native-br-sha256) NATIVE_BR_SHA=$2 ;;
				--native-guard-sha256) NATIVE_GUARD_SHA=$2 ;;
			esac
			shift 2 ;;
		--*) printf 'install-commit-msg-bead: unknown argument: %s\n' "$1" >&2; usage; exit 2 ;;
		*) if [ -n "$POS" ]; then printf 'install-commit-msg-bead: unexpected argument: %s\n' "$1" >&2; usage; exit 2; fi; POS=$1; shift ;;
	esac
done
# NODOUBLEPASS1/GATEEVENTS1: every probe below runs the installed chain; none is an agent act.
export OMP_KIT_GATE_EVENTS_SKIP=1
TARGET=${POS:-$KITROOT}
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd -P) || { echo "install-commit-msg-bead: cannot enter ${POS:-$KITROOT}" >&2; exit 2; }
HOOKS=$(git -C "$TARGET" rev-parse --git-path hooks) || { echo "install-commit-msg-bead: $TARGET is not a git repo" >&2; exit 2; }
case "$HOOKS" in
	/*) ;;
	*) HOOKS="$TARGET/$HOOKS" ;;
esac

# The import gate requires a trusted host Node/TypeScript parser at runtime.
# Admit that dependency before installing anything; never install project
# modules or activate a hook that cannot parse. --check instead inspects the
# installed checker below, even when this source checkout is incomplete.
if [ "$MODE" = install ]; then
	if ! sh "$KITROOT/scripts/check-commit-imports.sh" --parser-info --repo "$TARGET"; then
		echo 'install-commit-msg-bead: REFUSED import parser unavailable; host Node and TypeScript are required' >&2
		exit 2
	fi
fi

# Both expected digests are explicit review inputs. No automatic PATH adoption
# or environment override is copied into the installed authority boundary.
if [ "$NATIVE_PRESERVATION" = 1 ]; then
	python3 - "$KITROOT/scripts/native-br-preserve.py" "$NATIVE_GUARD_SHA" "$NATIVE_BR" "$NATIVE_BR_SHA" <<'PY'
import hashlib, os, pathlib, sys
helper, helper_sha, native, native_sha = sys.argv[1:]
for path, expected in ((helper, helper_sha), (native, native_sha)):
    if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        sys.exit("install-commit-msg-bead: REFUSED invalid native-preservation digest")
    p = pathlib.Path(path)
    if not p.is_absolute() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
        sys.exit("install-commit-msg-bead: REFUSED native-preservation source/executable changed")
if not os.access(native, os.X_OK):
    sys.exit("install-commit-msg-bead: REFUSED native executable unavailable")
PY
fi

# One validator owns the declaration format and externally supplied digest.
# Validate before any target mutation; validate the copied bytes again below.
if [ -n "$TEMPLATE_IMPORT_MAP" ] || [ -n "$TEMPLATE_IMPORT_MAP_SHA" ]; then
	if [ -z "$TEMPLATE_IMPORT_MAP" ] || [ -z "$TEMPLATE_IMPORT_MAP_SHA" ]; then
		echo 'install-commit-msg-bead: REFUSED template-import-map requires file and reviewed SHA256' >&2
		exit 2
	fi
	sh "$KITROOT/scripts/check-commit-imports.sh" --validate-template-import-map "$TEMPLATE_IMPORT_MAP" --sha256 "$TEMPLATE_IMPORT_MAP_SHA" || exit 2
fi

# These two authority files must never alias outside state. Inspect with
# lstat before any installer effect, including dangling destination links.
# Scope ownership checks to the managed hook-directory ancestry.
if [ -n "$TEMPLATE_IMPORT_MAP" ] ||
	[ -e "$HOOKS/hooks.d/pre-commit/template-import-map.json" ] ||
	[ -L "$HOOKS/hooks.d/pre-commit/template-import-map.json" ] ||
	[ -e "$HOOKS/hooks.d/pre-commit/template-import-map.sha256" ] ||
	[ -L "$HOOKS/hooks.d/pre-commit/template-import-map.sha256" ]; then
python3 - "$HOOKS" "$TEMPLATE_IMPORT_MAP" <<'PY' || exit 2
import os, pathlib, stat, sys
hooks = pathlib.Path(sys.argv[1])
managed = hooks / "hooks.d" / "pre-commit"
files = [managed / name for name in ("template-import-map.json", "template-import-map.sha256")]
if not sys.argv[2] and not any(os.path.lexists(p) for p in files):
    sys.exit(0)
def refuse():
    sys.exit("install-commit-msg-bead: REFUSED unsafe template-import-map destination")
for directory in reversed([managed, *managed.parents]):
    try:
        info = directory.lstat()
    except FileNotFoundError:
        continue
    except OSError:
        refuse()
    if not stat.S_ISDIR(info.st_mode):
        refuse()
    if directory in (hooks, hooks / "hooks.d", managed) and info.st_uid != os.geteuid():
        refuse()
for path in files:
    try:
        info = path.lstat()
    except FileNotFoundError:
        continue
    except OSError:
        refuse()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
        refuse()
PY
fi

check_template_import_map() {
	map_dir="$HOOKS/hooks.d/pre-commit"
	if [ -n "$TEMPLATE_IMPORT_MAP" ] || [ -e "$map_dir/template-import-map.json" ] || [ -e "$map_dir/template-import-map.sha256" ]; then
		[ -f "$map_dir/template-import-map.json" ] && [ -f "$map_dir/template-import-map.sha256" ] || return 1
		installed_sha=$(cat "$map_dir/template-import-map.sha256") || return 1
		# Require canonical pin bytes, not merely command-substitution equivalence.
		printf '%s\n' "$installed_sha" | cmp -s "$map_dir/template-import-map.sha256" - || return 1
		[ -z "$TEMPLATE_IMPORT_MAP_SHA" ] || [ "$installed_sha" = "$TEMPLATE_IMPORT_MAP_SHA" ] || return 1
		sh "$KITROOT/scripts/check-commit-imports.sh" --validate-template-import-map "$map_dir/template-import-map.json" --sha256 "$installed_sha" || return 1
	fi
}

native_member() {
	native_arg=$(python3 -c 'import shlex, sys; print(shlex.quote(sys.argv[1]))' "$NATIVE_BR") || return 1
	cat <<EOF
#!/bin/sh
# Native-preservation-only member; execute exactly the digest-verified bytes.
set -eu
here=\$(CDPATH='' cd -- "\$(dirname -- "\$0")" && pwd -P)
root=\$(git rev-parse --show-toplevel)
exec python3 - "\$here/native-br-preserve.py" '$NATIVE_GUARD_SHA' "\$root" $native_arg '$NATIVE_BR_SHA' <<'PY'
import hashlib, json, pathlib, sys
path, expected, repo, native, native_sha = sys.argv[1:]
try:
    data = pathlib.Path(path).read_bytes()
except OSError:
    print(json.dumps({"status": "REFUSED", "reason": "INSTALLED_GUARD_UNAVAILABLE"}), file=sys.stderr)
    sys.exit(4)
if hashlib.sha256(data).hexdigest() != expected:
    print(json.dumps({"status": "REFUSED", "reason": "INSTALLED_GUARD_CHANGED"}), file=sys.stderr)
    sys.exit(4)
sys.dont_write_bytecode = True
sys.argv = [path, "--repo", repo, "--native-br", native, "--native-br-sha256", native_sha]
exec(compile(data, path, "exec"), {"__name__": "__main__", "__file__": path})
PY
EOF
}

# Canonical copied-file closure: group chain destination source chmod-mode.
# Installation and --check consume these same rows; generated wrappers and reviewed
# caller-supplied template data remain explicit at their existing publication sites.
installation_manifest() {
	cat <<'INSTALLATION_MANIFEST'
commit_msg commit-msg 40-omp-kit-commit-msg-bead scripts/commit-msg-bead.sh +x
pre_push pre-push check-pushed-beads.sh scripts/check-pushed-beads.sh -x
pre_push pre-push commit-msg-bead.sh scripts/commit-msg-bead.sh -x
on_main pre-push 30-omp-kit-on-main scripts/check-pushed-on-main.sh +x
pushed_vlevel pre-push 41-omp-kit-pushed-vlevel scripts/pre-push-verification-level.sh +x
ref_txn reference-transaction 40-omp-kit-ref-txn-bead scripts/ref-txn-bead.sh +x
ref_txn reference-transaction commit-msg-bead.sh scripts/commit-msg-bead.sh -x
staged_imports pre-commit check-commit-imports.sh scripts/check-commit-imports.sh -x
staged_imports pre-commit 45-omp-kit-staged-imports scripts/check-staged-imports.sh +x
staged_fragments pre-commit 47-omp-kit-staged-fragments scripts/check-staged-fragments.sh +x
staged_regexploit pre-commit 48-omp-kit-staged-regexploit scripts/check-staged-regexploit.sh +x
staged_pysafe pre-commit pysafe.py scripts/pysafe.py -x
staged_pysafe pre-commit pysafe_check.py scripts/pysafe_check.py -x
staged_pysafe pre-commit pysafe_inline.py scripts/pysafe_inline.py -x
staged_pysafe pre-commit pysafe_inline_literals.py scripts/pysafe_inline_literals.py -x
staged_pysafe pre-commit kitlib_ratchet_core.py scripts/kitlib_ratchet_core.py -x
staged_pysafe pre-commit 49-omp-kit-staged-pysafe scripts/check-staged-pysafe.sh +x
staged_tempsafe pre-commit tempsafe_check.py scripts/tempsafe_check.py -x
staged_tempsafe pre-commit 50-omp-kit-staged-tempsafe scripts/check-staged-tempsafe.sh +x
staged_kitlib pre-commit kitlib_ratchet.py scripts/kitlib_ratchet.py -x
staged_kitlib pre-commit 51-omp-kit-staged-kitlib scripts/check-staged-kitlib.sh +x
staged_br_init pre-commit br_init_check.py scripts/br_init_check.py -x
staged_br_init pre-commit 53-omp-kit-staged-br-init scripts/check-staged-br-init.sh +x
staged_portable_paths pre-commit portable_paths_check.py scripts/portable_paths_check.py -x
staged_portable_paths pre-commit 54-omp-kit-staged-portable-paths scripts/check-portable-paths.sh +x
staged_wallclock pre-commit wallclock_check.py scripts/wallclock_check.py -x
staged_wallclock pre-commit 55-omp-kit-staged-wallclock scripts/check-staged-wallclock.sh +x
staged_sources pre-commit sources.py scripts/sources.py -x
staged_sources pre-commit kitlib_run.py scripts/kitlib_run.py -x
staged_sources pre-commit kitlib_io.py scripts/kitlib_io.py -x
staged_sources pre-commit kitlib_tmp.py scripts/kitlib_tmp.py -x
staged_sources pre-commit 52-omp-kit-staged-sources scripts/check-staged-sources.sh +x
kitlib_tmp pre-commit kitlib-tmp.sh scripts/kitlib-tmp.sh -x
kitlib_tmp pre-commit kitlib-findings.sh scripts/kitlib-findings.sh -x
kitlib_tmp commit-msg kitlib-tmp.sh scripts/kitlib-tmp.sh -x
kitlib_tmp commit-msg kitlib-findings.sh scripts/kitlib-findings.sh -x
kitlib_tmp pre-push kitlib-tmp.sh scripts/kitlib-tmp.sh -x
kitlib_tmp pre-push kitlib-findings.sh scripts/kitlib-findings.sh -x
kitlib_tmp reference-transaction kitlib-tmp.sh scripts/kitlib-tmp.sh -x
kitlib_tmp reference-transaction kitlib-findings.sh scripts/kitlib-findings.sh -x
gate_event commit-msg gate-event.sh scripts/gate-event.sh +x
gate_event commit-msg gate_event_replay.py scripts/gate_event_replay.py -x
gate_event commit-msg cc-credential-shapes.v1.json src/cc-credential-shapes.v1.json -x
gate_event commit-msg secret-output-policy.v1.json src/secret-output-policy.v1.json -x
gate_event commit-msg kitlib_run.py scripts/kitlib_run.py -x
gate_event commit-msg pysafe.py scripts/pysafe.py -x
gate_event commit-msg kitlib_jsonl.py scripts/kitlib_jsonl.py -x
gate_event commit-msg kitlib_lock.py scripts/kitlib_lock.py -x
staged_readme pre-commit readme-check.ts scripts/readme-check.ts -x
staged_readme pre-commit 46-omp-kit-staged-readme scripts/check-staged-readme.sh +x
commit_notes commit-msg release-notes.ts scripts/release-notes.ts -x
commit_notes commit-msg limit-process-tree.sh scripts/limit-process-tree.sh -x
commit_notes commit-msg 46-omp-kit-commit-notes scripts/check-commit-notes.sh +x
deploy_step commit-msg 48-omp-kit-deploy-step scripts/check-deploy-step.sh +x
gap_mention commit-msg 47-omp-kit-gap-mention scripts/check-gap-mention.sh +x
stale_worktree commit-msg 49-omp-kit-stale-worktree scripts/check-stale-worktree.sh +x
kitlib_reversal commit-msg 50-omp-kit-staged-kitlib-reversal scripts/check-commit-kitlib-reversal.sh +x
commit_gate commit-msg 55-omp-kit-commit-gate scripts/check-commit-gate.sh +x
commit_gate commit-msg scripts/check-red-main.py scripts/check-red-main.py -x
commit_gate commit-msg scripts/full-suite-verdict-store.py scripts/full-suite-verdict-store.py -x
commit_gate commit-msg scripts/suite-metrics.py scripts/suite-metrics.py -x
commit_gate commit-msg scripts/kitlib_run.py scripts/kitlib_run.py -x
commit_gate commit-msg scripts/kitlib_tmp.py scripts/kitlib_tmp.py -x
commit_gate commit-msg scripts/pysafe.py scripts/pysafe.py -x
native_preservation pre-commit native-br-preserve.py scripts/native-br-preserve.py -x
INSTALLATION_MANIFEST
}

# --check names installed members that differ from this checkout (a stale
# installed hook runs old rules after the source moves on). Exit 0 when every
# member matches, 3 naming each missing or stale member.
if [ "$MODE" = "check" ]; then
	stale=0
	while IFS=' ' read -r file_group file_chain file_dest file_source file_mode; do
		case "$file_group" in
			pre_push) [ "$PUSHED_BEADS" = 1 ] || continue ;;
			native_preservation) [ "$NATIVE_PRESERVATION" = 1 ] || continue ;;
		esac
		dest="$HOOKS/hooks.d/$file_chain/$file_dest"
		src="$KITROOT/$file_source"
		if [ ! -f "$dest" ]; then
			printf 'install-commit-msg-bead: MISSING installed member: %s\n' "$dest" >&2
			stale=1
		elif ! cmp -s "$dest" "$src"; then
			printf 'install-commit-msg-bead: STALE installed member: %s differs from %s; rerun %s\n' "$dest" "$src" "$0" >&2
			stale=1
		fi
	done <<EOF
$(installation_manifest)
EOF
	parser="$HOOKS/hooks.d/pre-commit/check-commit-imports.sh"
	if [ ! -f "$parser" ] || ! sh "$parser" --parser-info --repo "$TARGET"; then
		printf 'install-commit-msg-bead: MISSING or STALE installed import parser in %s\n' "$TARGET" >&2
		stale=1
	fi
	if [ "$NATIVE_PRESERVATION" = 1 ]; then
		dir="$HOOKS/hooks.d/pre-commit"
		if ! native_member | cmp -s "$dir/40-omp-kit-native-preserve" -; then
			printf 'install-commit-msg-bead: MISSING or STALE native-preservation member in %s\n' "$TARGET" >&2
			stale=1
		fi
	fi
	if ! check_template_import_map; then
		printf 'install-commit-msg-bead: MISSING or STALE reviewed template-import-map in %s\n' "$TARGET" >&2
		stale=1
	fi
	if [ "$stale" = 0 ]; then printf 'install-commit-msg-bead: hooks fresh in %s\n' "$TARGET"; exit 0; fi
	exit 3
fi

chain_dir() {
	printf '%s/hooks.d/%s' "$HOOKS" "$1"
}

# Use the same interpreter contract while probing a pre-existing bespoke hook.
execute_hook() (
	hook=$1
	shift
	first=''
	IFS= read -r first < "$hook" || :
	case "$first" in '#!'*) "$hook" "$@" ;; *) sh "$hook" "$@" ;; esac
)

# backup <path>: keep a pre-existing file so rollback restores it, never
# deletes it. The dot prefix keeps the copy out of this runner's NN-* glob, and
# the copy is never executable: Agent Mail's pre-commit/pre-push chain runners
# run every executable file in the directory, so an executable copy left by an
# interrupted install ran as an extra hook on every commit and push
# (companion, 2026-11-03). The original mode is restored exactly on rollback.
backup() {
	undo="$(dirname -- "$1")/.undo.$$.$(basename -- "$1")"
	cp -p "$1" "$undo"
	mode=$(stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1")
	printf '%s\n' "$mode" > "$undo.mode"
	chmod a-x "$undo"
	UNDO_RESTORE="$UNDO_RESTORE $1"
}

# place <src> <dest> <mode>: install a file, recording how to undo it.
place() {
	if [ -e "$2" ]; then backup "$2"; else UNDO_RM="$UNDO_RM $2"; fi
	# Same-directory publication staging preserves running readers' inode.
	staged="$2.install.$$"
	if ! cp "$1" "$staged" || ! chmod "$3" "$staged" || ! mv -f "$staged" "$2"; then
		rm -f "$staged"
		return 1
	fi
}

# Feed the loop with a here-document, not a pipeline/subshell: place's rollback
# records must survive in the installer process, including restored file modes.
install_manifest_group() {
	manifest_requested_group=$1
	manifest_found=0
	while IFS=' ' read -r file_group file_chain file_dest file_source file_mode; do
		[ "$file_group" = "$manifest_requested_group" ] || continue
		place "$KITROOT/$file_source" "$(chain_dir "$file_chain")/$file_dest" "$file_mode"
		manifest_found=1
	done <<EOF
$(installation_manifest)
EOF
	[ "$manifest_found" = 1 ]
}

# write_runner <path>: the chain runner. Hook types fed on stdin (pre-push,
# reference-transaction) replay one buffered copy to every member, so a
# member that reads stdin cannot starve the ones after it.
write_runner() {
	path=$1
	if [ -e "$path" ]; then backup "$path"; else UNDO_RM="$UNDO_RM $path"; fi
	# Stage beside the hook; rename publishes it without truncating running readers.
	staged="$path.install.$$"
	cat > "$staged" <<'EOF'
#!/bin/sh
# chain runner: run every executable NN-<name> member in hooks.d/<type> in
# sort order. Only numeric-prefixed entries run: helper libraries shipped
# beside members (no NN- prefix) are never executed arg-less. Stdin-fed hook
# types replay one buffered copy of the input to each member.
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
kind=$(basename -- "$0")
input=""
case "$kind" in
	pre-push | reference-transaction | post-rewrite)
		input=$(mktemp "${TMPDIR:-/tmp}/hook-input.XXXXXX") || exit 1
		cat > "$input"
		;;
esac
rc=0
# GATEEVENTS1 runner v6: actual member rc and hook arguments accompany replay observations;
# each verdict is one gate-events row (act = commit/publish, gate = member name); FINDING lines (kitlib-findings.sh
# grammar) from every member are collected into ONE envelope printed once at the end, and the chain exits
# non-zero once iff any member found something. A legacy member that exits non-zero without FINDING lines
# contributes one finding carrying its last stderr line, so nothing is silenced during the conversion.
ledger="$here/hooks.d/commit-msg/gate-event.sh"
case "$kind" in pre-commit | commit-msg | prepare-commit-msg) act=commit ;; pre-push) act=publish ;; *) act=$kind ;; esac
target=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf '%s' '')
findings=$(mktemp "${TMPDIR:-/tmp}/hook-findings.XXXXXX") || exit 1
run_member() {
	first=''
	IFS= read -r first < "$hook" || :
	case "$first" in
		'#!'*) "$hook" "$@" ;;
		*) sh "$hook" "$@" ;;
	esac
}
for hook in "$here/hooks.d/$kind"/[0-9][0-9]-*; do
	[ -e "$hook" ] || continue
	[ -x "$hook" ] || continue
	member=$(basename -- "$hook")
	member_rc=0
	errf=$(mktemp "${TMPDIR:-/tmp}/hook-stderr.XXXXXX") || exit 1
	if [ -n "$input" ]; then out=$(run_member "$@" < "$input" 2> "$errf") || member_rc=$?; else out=$(run_member "$@" 2> "$errf") || member_rc=$?; fi
	n=$(printf '%s\n' "$out" | grep -c '^FINDING	' || :)
	printf '%s\n' "$out" | grep '^FINDING	' >> "$findings" || :
	# Converted members speak only in FINDING lines; anything else on stdout is passed through unchanged.
	printf '%s\n' "$out" | grep -v '^FINDING	' | grep -v '^$' || :
	cat "$errf" >&2
	if [ "$member_rc" -ne 0 ] && [ "$n" -eq 0 ]; then
		last=$(grep -m 1 -E 'REFUSE|refused|FAIL|error' "$errf" | tr '\t' ' ')
		[ -n "$last" ] || last=$(grep -v '^$' "$errf" | head -n 1 | tr '\t' ' ')
		printf 'FINDING\t%s\tMEMBER_REFUSED\t%s\t%s\t-\n' "$member" "${last:-exit $member_rc with no message}" "read the member output above" >> "$findings"
		n=1
	fi
	rm -f "$errf"
	# Exit once, with the first refusing member's own code (installer probes and `--check` read it).
	if [ "$n" -ne 0 ] && [ "$rc" -eq 0 ]; then if [ "$member_rc" -ne 0 ]; then rc=$member_rc; else rc=1; fi; fi
	if [ -x "$ledger" ]; then
		if [ "$member_rc" -eq 0 ]; then row=pass; else row=refuse; fi
		message_file=''
		case "$kind" in commit-msg | prepare-commit-msg) message_file=${1:-} ;; esac
		OMP_KIT_GATE_EVENT_RC=$member_rc OMP_KIT_GATE_EVENT_HOOK=$kind OMP_KIT_GATE_EVENT_MESSAGE_FILE=$message_file \
			sh "$ledger" "$act" "$target" "$member" "$row" "git-$PPID" "findings=$n rc=$member_rc" "$@" || :
	fi
done
[ -z "$input" ] || rm -f "$input"
if [ "$rc" -ne 0 ]; then
	total=$(grep -c . "$findings" || :)
	printf '%s REFUSED: %s finding(s); fix every one, then retry once:\n' "$act" "$total" >&2
	while IFS='	' read -r _tag gate code detail remedy fix; do
		printf '  %s %s: %s\n    remedy: %s\n' "$gate" "$code" "$detail" "$remedy" >&2
		[ "$fix" = "-" ] || printf '    fix: %s\n' "$fix" >&2
	done < "$findings"
	[ -z "${OMP_KIT_FINDINGS_JSON:-}" ] || cat "$findings"
fi
rm -f "$findings"
exit $rc
EOF
	if ! chmod +x "$staged" || ! mv -f "$staged" "$path"; then
		rm -f "$staged"
		return 1
	fi
}

# ensure_chain <type>: make $HOOKS/<type> a chain runner, preserving any
# bespoke entry by moving it to 10-<type>. Prints what it did.
ensure_chain() {
	type=$1
	entry="$HOOKS/$type"
	dir=$(chain_dir "$type")
	mkdir -p "$dir"
	if [ ! -e "$entry" ]; then
		write_runner "$entry"
		printf 'created chain runner: %s\n' "$entry"
		return 0
	fi
	if [ -x "$entry" ] && grep -q 'hooks\.d' "$entry" 2>/dev/null; then
		# The marker names the runner generation: bump it (here and in write_runner) with every runner change,
		# or installed repos keep the old runner while --check reports them fresh.
		if grep -q 'chain runner: run every executable' "$entry" && { ! grep -q 'replay one buffered copy' "$entry" || ! grep -q 'GATEEVENTS1 runner v6' "$entry"; }; then
			write_runner "$entry"
			printf 'upgraded chain runner (stdin replay + gate-events ledger): %s\n' "$entry"
		else
			printf 'chain runner already present: %s\n' "$entry"
		fi
		return 0
	fi
	# Record every mutation for rollback (globals: appended across both hook
	# types, consumed only when a probe fails below).
	if [ -e "$dir/10-$type" ]; then
		printf 'install-commit-msg-bead: %s already staged in chain: %s/10-%s\n' "$type" "$dir" "$type" >&2
		return 0
	fi
	mv "$entry" "$dir/10-$type"
	UNDO_MOVES="$UNDO_MOVES $entry:$dir/10-$type"
	# Sibling impls resolve by dirname of the moved entry (fail-closed
	# wrappers); move "<type>-*" siblings alongside so they keep resolving.
	for sibling in "$HOOKS/$type"-*; do
		[ -e "$sibling" ] || continue
		UNDO_MOVES="$UNDO_MOVES $sibling:$dir/$(basename -- "$sibling")"
		mv -- "$sibling" "$dir/"
	done
	write_runner "$entry"
	printf 'moved bespoke %s to %s/10-%s and created chain runner\n' "$type" "$dir" "$type"
}

# rollback: undo every recorded mutation, then exit 1 with the reason.
# Only paths this installer created or moved are touched.
rollback() {
	printf 'install-commit-msg-bead: ROLLBACK: %s\n' "$1" >&2
	# shellcheck disable=SC2086
	for pair in $UNDO_RM; do rm -f "$pair"; done
	# shellcheck disable=SC2086
	for path in $UNDO_RESTORE; do
		undo="$(dirname -- "$path")/.undo.$$.$(basename -- "$path")"
		mv -f -- "$undo" "$path" 2>/dev/null || continue
		[ ! -f "$undo.mode" ] || chmod "$(cat "$undo.mode")" "$path" 2>/dev/null || true
		rm -f -- "$undo.mode"
	done
	# shellcheck disable=SC2086
	for pair in $UNDO_MOVES; do
		src=${pair%%:*}; dst=${pair#*:}
		mv -- "$dst" "$src" 2>/dev/null || true
	done
	exit 1
}

# install_commit_msg: ours runs after any bespoke entry (sort order).
install_commit_msg() {
	dest=$(chain_dir commit-msg)/40-omp-kit-commit-msg-bead
	install_manifest_group commit_msg
	printf 'installed bead-id hook: %s\n' "$dest"
}

# install_pre_push: checker libs beside a member wrapper that speaks the
# pre-push hook protocol on stdin. Helper copies stay non-executable: the
# chain runner executes every executable member file, so an executable helper
# would run arg-less and fail pushes (2026-10-06 incident).
install_pre_push() {
	dir=$(chain_dir pre-push)
	member="$dir/40-omp-kit-pushed-beads"
	install_manifest_group pre_push
	wrapper=$(mktemp "${TMPDIR:-/tmp}/pushed-beads-member.XXXXXX") || exit 2
	cat > "$wrapper" <<'EOF'
#!/bin/sh
# pre-push member: refuse pushed ranges with id-less commits.
set -u
exec sh "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/check-pushed-beads.sh" --pre-push
EOF
	place "$wrapper" "$member" +x
	rm -f "$wrapper"
	printf 'installed pushed-beads member: %s\n' "$member"
}

# install_on_main: the shared-main member reads the pre-push lines itself and
# runs before the pushed-beads member and any 40- gate, so an off-main push is
# refused before a slow gate starts.
install_on_main() {
	member="$(chain_dir pre-push)/30-omp-kit-on-main"
	install_manifest_group on_main
	printf 'installed shared-main push member: %s\n' "$member"
}

# install_pushed_vlevel: the verification-level pre-push member (VLEVEL-PUSH2,
# ompkit-xa5s.37). The fleet's documented private-index landing (commit-tree)
# never runs commit-msg, so commit-tree commits reach the push with no level
# unless a pre-push member judges the range. The member is a byte-equal copy
# of the canonical omp-kit scripts/pre-push-verification-level.sh; keep the
# companion source byte-identical and --check names any stale installation.
install_pushed_vlevel() {
	member="$(chain_dir pre-push)/41-omp-kit-pushed-vlevel"
	install_manifest_group pushed_vlevel
	printf 'installed pushed-verification-level member: %s\n' "$member"
}

# install_ref_txn: the plumbing backstop. commit-tree + update-ref and
# --no-verify never run commit-msg; git runs reference-transaction for every
# ref update. The judge sits beside the member, non-executable (see above).
install_ref_txn() {
	dir=$(chain_dir reference-transaction)
	member="$dir/40-omp-kit-ref-txn-bead"
	install_manifest_group ref_txn
	printf 'installed ref-update bead guard: %s\n' "$member"
}

# install_staged_imports: the pre-commit member judges the staged tree; its
# checker sits beside it, non-executable, so the runner never runs it arg-less.
install_staged_imports() {
	dir=$(chain_dir pre-commit)
	member="$dir/45-omp-kit-staged-imports"
	install_manifest_group staged_imports
	if [ -n "$TEMPLATE_IMPORT_MAP" ]; then
		# The reviewed input may already be the managed declaration itself.
		if ! cmp -s "$TEMPLATE_IMPORT_MAP" "$dir/template-import-map.json"; then
			place "$TEMPLATE_IMPORT_MAP" "$dir/template-import-map.json" -x
		fi
		pin="$dir/template-import-map.sha256"
		if [ -e "$pin" ]; then backup "$pin"; else UNDO_RM="$UNDO_RM $pin"; fi
		printf '%s\n' "$TEMPLATE_IMPORT_MAP_SHA" > "$pin"
		chmod 600 "$pin"
		sh "$dir/check-commit-imports.sh" --validate-template-import-map "$dir/template-import-map.json" --sha256 "$TEMPLATE_IMPORT_MAP_SHA" ||
			rollback "installed template-import-map differs from reviewed bytes"
	fi
	printf 'installed staged-imports member: %s\n' "$member"
}

# install_staged_fragments / install_staged_regexploit: pre-commit members
# that run the repo's own validators (release-notes.sh fold, regexploit-gate.py)
# over the staged tree; no helper beside them, since they resolve the repo root.
install_staged_fragments() {
	member="$(chain_dir pre-commit)/47-omp-kit-staged-fragments"
	install_manifest_group staged_fragments
	printf 'installed staged-fragments member: %s\n' "$member"
}

install_staged_regexploit() {
	member="$(chain_dir pre-commit)/48-omp-kit-staged-regexploit"
	install_manifest_group staged_regexploit
	printf 'installed staged-regexploit member: %s\n' "$member"
}

# install_staged_pysafe: the checker and its runner sit beside the member,
# non-executable, so the chain runner never runs them arg-less.
install_staged_pysafe() {
	dir=$(chain_dir pre-commit)
	member="$dir/49-omp-kit-staged-pysafe"
	install_manifest_group staged_pysafe
	printf 'installed staged-pysafe member: %s\n' "$member"
}

# install_staged_tempsafe: its checker reuses the ratchet engine and bounded
# runner that install_staged_pysafe (always run first) already placed beside
# the members. Numbered after pysafe.
install_staged_tempsafe() {
	dir=$(chain_dir pre-commit)
	member="$dir/50-omp-kit-staged-tempsafe"
	install_manifest_group staged_tempsafe
	printf 'installed staged-tempsafe member: %s\n' "$member"
}

# install_staged_kitlib: the kitlib ratchet sits beside the member,
# non-executable, next to the engine and pysafe.py copies install_staged_tempsafe
# and install_staged_pysafe (always run first) placed there. Numbered after tempsafe.
install_staged_kitlib() {
	dir=$(chain_dir pre-commit)
	member="$dir/51-omp-kit-staged-kitlib"
	install_manifest_group staged_kitlib
	printf 'installed staged-kitlib member: %s\n' "$member"
}

# install_staged_br_init: reuse the shared ratchet engine and bounded runner
# installed by staged-tempsafe/staged-pysafe. The checker and member follow
# staged sources.
install_staged_br_init() {
	dir=$(chain_dir pre-commit)
	member="$dir/53-omp-kit-staged-br-init"
	install_manifest_group staged_br_init
	printf 'installed staged-br-init member: %s\n' "$member"
}
# install_staged_portable_paths: refuse newly added machine-local paths.
install_staged_portable_paths() {
	dir=$(chain_dir pre-commit)
	member="$dir/54-omp-kit-staged-portable-paths"
	install_manifest_group staged_portable_paths
	printf 'installed staged-portable-paths member: %s\n' "$member"
}
# install_staged_wallclock: WALLCLOCK1 (ompkit-qf9fk) refuses new test lines that pass only within a small fixed
# wall-clock bound; it runs the checker beside it under pysafe.py, with kitlib_run.py from install_staged_sources.
install_staged_wallclock() {
	dir=$(chain_dir pre-commit)
	member="$dir/55-omp-kit-staged-wallclock"
	install_manifest_group staged_wallclock
	printf 'installed staged-wallclock member: %s\n' "$member"
}


install_staged_sources() {
	dir=$(chain_dir pre-commit)
	install_manifest_group staged_sources
	printf 'installed staged-sources member: %s\n' "$dir/52-omp-kit-staged-sources"
}

# install_kitlib_tmp: all four hook chains source "<own dir>/kitlib-tmp.sh"
# for owned temp dirs (KITLIB-TMP v1). Each gets a non-executable helper
# that the chain runner never executes arg-less.
install_kitlib_tmp() {
	install_manifest_group kitlib_tmp
	printf 'installed kitlib-tmp.sh and kitlib-findings.sh into all four hook chains\n'
}

# install_gate_event: the ledger writer and its declared standalone Python/JSON
# closure sit beside commit-msg; helpers remain non-executable in the chain.
install_gate_event() {
	dir=$(chain_dir commit-msg)
	install_manifest_group gate_event
	printf 'installed gate-event.sh (gate-events ledger) beside the commit-msg chain\n'
}

# install_staged_readme: the checker copy sits beside the member,
# non-executable, so the chain runner never runs it arg-less. The member
# judges the staged tree (READMESIZE1, ompkit-readme-changelog-currency-vrrn.1).
install_staged_readme() {
	dir=$(chain_dir pre-commit)
	member="$dir/46-omp-kit-staged-readme"
	install_manifest_group staged_readme
	printf 'installed staged-readme member: %s\n' "$member"
}

# install_commit_notes: the commit-msg member asks release-notes.ts (the code
# the release train runs) whether the staged commit has notes coverage; it runs
# after the bead-id member. The resolver and its deadline wrapper sit beside
# the member, non-executable, so the chain runner never runs them arg-less.
install_commit_notes() {
	dir=$(chain_dir commit-msg)
	member="$dir/46-omp-kit-commit-notes"
	install_manifest_group commit_notes
	printf 'installed commit-notes member: %s\n' "$member"
}
# install_deploy_step: require a runbook/reference update or an explicit
# install/recovery command for commits changing deploy-sensitive paths.
install_deploy_step() {
	member="$(chain_dir commit-msg)/48-omp-kit-deploy-step"
	install_manifest_group deploy_step
	printf 'installed deploy-step member: %s\n' "$member"
}


# install_gap_mention: the commit-msg member that refuses, once, a body naming a gap without a bead id
# (GAPFADE1, ompkit-3waa2); it runs after the notes member and reads kitlib-findings.sh beside it.
install_gap_mention() {
	member="$(chain_dir commit-msg)/47-omp-kit-gap-mention"
	install_manifest_group gap_mention
	printf 'installed gap-mention member: %s\n' "$member"
}

# install_stale_worktree: the commit-msg member refuses commits that would
# revert lines landed in HEAD (STALEWT1, ompkit-fp72.120.10); it runs after
# the notes member.
install_stale_worktree() {
	member="$(chain_dir commit-msg)/49-omp-kit-stale-worktree"
	install_manifest_group stale_worktree
	printf 'installed stale-worktree member: %s\n' "$member"
}

# install_kitlib_reversal: validate the named Revert and exact staged parent
# after stale-worktree (49); a trailer alone never grants the admission.
install_kitlib_reversal() {
	member="$(chain_dir commit-msg)/50-omp-kit-staged-kitlib-reversal"
	install_manifest_group kitlib_reversal
	printf 'installed kitlib-reversal member: %s\n' "$member"
}

# install_commit_gate: COMMITPARITY1 (ompkit-9d9fx). The commit-msg member runs the installed pre-push
# fresh-gate member on the commit being made, so a commit the push would refuse never lands on main.
# It checks the recorded release verdict even without a pre-push member, and runs last.
install_commit_gate() {
	member="$(chain_dir commit-msg)/55-omp-kit-commit-gate"
	mkdir -p "$(chain_dir commit-msg)/scripts"
	install_manifest_group commit_gate
	printf 'installed commit-gate member: %s\n' "$member"
}


install_native_preservation() {
	dir=$(chain_dir pre-commit)
	install_manifest_group native_preservation
	wrapper=$(mktemp "${TMPDIR:-/tmp}/native-preserve-member.XXXXXX") || exit 2
	native_member > "$wrapper" || rollback "cannot render native-preservation member"
	place "$wrapper" "$dir/40-omp-kit-native-preserve" +x
	rm -f "$wrapper"
	printf 'installed digest-bound native-preservation member: %s\n' "$dir/40-omp-kit-native-preserve"
}

PROBE=$(mktemp "${TMPDIR:-/tmp}/bead-probe.XXXXXX") || exit 2
PROBE_DB=$(mktemp "${TMPDIR:-/tmp}/bead-probe-db.XXXXXX") || exit 2
# The probe tracker writes sidecars beside PROBE_DB (-wal, -shm, .fsqlite-*); remove them too.
trap 'rm -f "$PROBE" "$PROBE_DB" "$PROBE_DB"-* "$PROBE_DB".*' EXIT INT TERM
printf '[test] fix widgets probe baseline\n' > "$PROBE"

# Pre-flight: record how any bespoke entry treats a well-formed message
# BEFORE moving anything. An already-refusing bespoke is preserved as-is;
# one that passes must still pass after the move.
PREFLIGHT_RC=""
if [ -e "$HOOKS/commit-msg" ]; then
	if [ ! -x "$HOOKS/commit-msg" ] || ! grep -q 'hooks\.d' "$HOOKS/commit-msg" 2>/dev/null; then
		if execute_hook "$HOOKS/commit-msg" "$PROBE" >/dev/null 2>&1; then PREFLIGHT_RC=0; else PREFLIGHT_RC=$?; fi
	fi
fi

# A pushed-range member installed over unpublished id-less commits would
# refuse every later push of this repo (2026-10-16: five held fourteen). Refuse
# before any mutation and name the remedies.
if [ "$PUSHED_BEADS" = 1 ] && git -C "$TARGET" rev-parse -q --verify HEAD > /dev/null; then
	if ! RANGE_OUT=$(CDPATH='' cd -- "$TARGET" && sh "$KITROOT/scripts/check-pushed-beads.sh" --repo "$TARGET" --base HEAD --tip HEAD 2>&1); then
		printf 'install-commit-msg-bead: REFUSED: %s already holds unpublished id-less commits (%s); a pushed-beads member would block every push. Name their bead ids first, or rerun with --no-pushed-beads for the forward-only set.\n' \
			"$TARGET" "$(printf '%s' "$RANGE_OUT" | head -1)" >&2
		exit 5
	fi
fi

ensure_chain commit-msg
install_commit_msg
install_commit_notes
install_gap_mention
install_stale_worktree
install_deploy_step
install_kitlib_reversal
install_commit_gate
ensure_chain pre-push
install_on_main
install_pushed_vlevel
[ "$PUSHED_BEADS" = 0 ] || install_pre_push
ensure_chain reference-transaction
install_ref_txn
ensure_chain pre-commit
install_kitlib_tmp
install_gate_event
install_staged_imports
install_staged_fragments
install_staged_regexploit
install_staged_pysafe
install_staged_tempsafe
install_staged_kitlib
install_staged_sources
install_staged_br_init
install_staged_portable_paths
install_staged_wallclock
install_staged_readme
[ "$NATIVE_PRESERVATION" = 0 ] || install_native_preservation

# Verify the whole installed chain (any failure rolls every mutation back):
# Leg 1: the moved bespoke must behave exactly as pre-flight. A pass that
# turns refusal means the move broke it (sibling impl left behind).
if [ -n "$PREFLIGHT_RC" ]; then
	if execute_hook "$HOOKS/hooks.d/commit-msg/10-commit-msg" "$PROBE" >/dev/null 2>&1; then POST_RC=0; else POST_RC=$?; fi
	if [ "$POST_RC" != "$PREFLIGHT_RC" ]; then
		rollback "bespoke behaved rc=$PREFLIGHT_RC before the move but rc=$POST_RC after (sibling impl left behind?)"
	fi
fi
# Leg 2: a well-formed message naming an unresolvable bead id must be refused
# BY OUR member (exit 4 naming commit-msg-bead). BEADS_DB points at an empty
# file so no tracker resolves, in any repo, without touching real state.
printf '[test] fix widgets ompkit-zzzz-1\n' > "$PROBE"
# The probe runs inside $TARGET, as git runs the hook: from the caller's cwd, a member that reads the current repo
# (commit-gate) judged the CALLER's checkout and ran its full fresh gate inside every fixture install (2026-11-03).
if PROBE_OUT=$(cd "$TARGET" && BEADS_DB="$PROBE_DB" sh "$HOOKS/commit-msg" "$PROBE" 2>&1); then
	rollback "chain accepted an id-less message in $TARGET"
fi
case "$PROBE_OUT" in
	*commit-msg-bead*) ;;
	*) rollback "refusal did not come from the bead-id member: $(printf '%s' "$PROBE_OUT" | head -1)" ;;
esac
# Leg 3: the pre-push members must pass the current range (valid pushes flow).
# Leg 4: the ref guard must refuse moving main to a planted id-less commit
# and must pass the same update of any other ref. The guard member is fed the
# update line directly, so no bespoke hook in the chain sees a synthetic
# update; nothing is moved and the probe commit is a dangling object.
if HEAD_SHA=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null); then
	if [ "$PUSHED_BEADS" = 1 ] && ! printf 'refs/heads/main %s refs/heads/main %s\n' "$HEAD_SHA" "$HEAD_SHA" | (CDPATH='' cd -- "$TARGET" && sh "$HOOKS/hooks.d/pre-push/40-omp-kit-pushed-beads") >/dev/null 2>&1; then
		rollback "pre-push member rejects the current range in $TARGET"
	fi
	GUARD="$HOOKS/hooks.d/reference-transaction/40-omp-kit-ref-txn-bead"
	PLANT=$(printf 'probe: id-less ref-guard plant\n' | GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@invalid GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@invalid \
		git -C "$TARGET" commit-tree "$HEAD_SHA^{tree}" -p "$HEAD_SHA") || rollback "cannot write the ref-guard probe commit in $TARGET"
	if REF_OUT=$(printf '%s %s refs/heads/main\n' "$HEAD_SHA" "$PLANT" | (CDPATH='' cd -- "$TARGET" && BEADS_DB="$PROBE_DB" sh "$GUARD" prepared) 2>&1); then
		rollback "ref guard let main move to an id-less commit in $TARGET"
	fi
	case "$REF_OUT" in
		*ref-txn-bead*) ;;
		*) rollback "ref refusal did not come from the bead guard: $(printf '%s' "$REF_OUT" | head -1)" ;;
	esac
	if ! printf '%s %s refs/heads/probe-other\n' "$HEAD_SHA" "$PLANT" | (CDPATH='' cd -- "$TARGET" && BEADS_DB="$PROBE_DB" sh "$GUARD" prepared) >/dev/null 2>&1; then
		rollback "ref guard refused an update of a ref other than main in $TARGET"
	fi
	# Leg 5: the shared-main member must pass local main and refuse the probe
	# commit (a child of HEAD that main does not hold) pushed to the remote main.
	ONMAIN="$HOOKS/hooks.d/pre-push/30-omp-kit-on-main"
	if MAIN_SHA=$(git -C "$TARGET" rev-parse -q --verify 'refs/heads/main^{commit}'); then
		if ! printf 'refs/heads/main %s refs/heads/main %s\n' "$MAIN_SHA" "$MAIN_SHA" | (CDPATH='' cd -- "$TARGET" && sh "$ONMAIN") >/dev/null 2>&1; then
			rollback "shared-main member refused local main in $TARGET"
		fi
	else
		printf 'install-commit-msg-bead: WARN: %s has no refs/heads/main; the shared-main member refuses every push to the remote main\n' "$TARGET" >&2
	fi
	if MAIN_OUT=$(printf 'refs/heads/probe %s refs/heads/main %s\n' "$PLANT" "$HEAD_SHA" | (CDPATH='' cd -- "$TARGET" && sh "$ONMAIN") 2>&1); then
		rollback "shared-main member let an off-main commit move the remote main in $TARGET"
	fi
	case "$MAIN_OUT" in
		*check-pushed-on-main*) ;;
		*) rollback "off-main refusal did not come from the shared-main member: $(printf '%s' "$MAIN_OUT" | head -1)" ;;
	esac
else
	printf 'install-commit-msg-bead: WARN: %s has no HEAD commit; pre-push and ref-guard probes skipped\n' "$TARGET" >&2
fi
# The new member is exercised read-only against the actual staged candidate.
# A SKIPPED result is not acceptance of a snapshot; normal-commit qualification
# still requires a real candidate and the owner's unchanged upstream chain.
if [ "$NATIVE_PRESERVATION" = 1 ]; then
	if ! (CDPATH='' cd -- "$TARGET" && sh "$HOOKS/hooks.d/pre-commit/40-omp-kit-native-preserve"); then
		rollback "native-preservation member refused the actual candidate in $TARGET"
	fi
fi
# shellcheck disable=SC2086
for path in $UNDO_RESTORE; do rm -f -- "$(dirname -- "$path")/.undo.$$.$(basename -- "$path")" "$(dirname -- "$path")/.undo.$$.$(basename -- "$path").mode"; done
printf 'verified active in %s\n' "$TARGET"
