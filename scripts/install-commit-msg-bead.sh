#!/bin/sh
# Install the 55-aggregator commit-msg hook (bead-id, verification-level,
# commit-notes and deploy-step findings report under the one aggregator code),
# the reference-transaction ref guard, the shared-main pre-push member and the
# pushed-beads pre-push member into a repo's hook chains, plus the
# staged-imports, staged-fragments, staged-regexploit, staged-pysafe,
# staged-tempsafe, staged-kitlib and staged-br-init pre-commit members.
# Usage: install-commit-msg-bead.sh [--check] [--no-pushed-beads] [REPO] (default: this kit checkout).
# The shared-main member (scripts/check-pushed-on-main.sh) is always installed:
# it judges only where a push moves the remote main, never old messages.
# The staged-imports member (scripts/check-staged-imports.sh, with
# check-commit-imports.sh beside it) is always installed: it refuses a commit
# whose staged files import a path that is neither staged nor committed.
# The commit-notes and deploy-step checks (scripts/check-commit-notes.sh with
# release-notes.ts beside it, scripts/check-deploy-step.sh) run folded inside
# the 55-aggregator member: a shipped-path commit the push notes gate would
# refuse (no single Bead: trailer with a changelog.d fragment, and no
# [no-changelog] reason), or a deploy-sensitive commit without a runbook or
# reference change and without an explicit Deploy-Step trailer, is refused
# under the aggregator code with the check named in the finding.
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
# The staged-embed member (scripts/check-staged-embed.sh, using the pysafe.py
# and kitlib-tmp.sh the staged-pysafe and kitlib-tmp groups place beside it)
# is always installed: when staged paths touch a generated embed's producer,
# outputs or inputs (installer/embed-bootstrap.py EMBEDS), it refuses a stale
# output, naming the regenerate command.
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
# Installed members are deployment artifacts, not repo source (HOOKREFRESH1,
# ompkit-v66l.22.3). When the hooks dir lies inside the work tree
# (core.hooksPath=.githooks), each install rewrites one marked block in the
# repo's info/exclude naming every path it wrote, so `git add -A` never stages
# kit bytes and the repo's staged gates never judge them; --check verifies the
# block. git ignores exclude rules for tracked paths, so a tracked repo-owned
# member or adaptation stays staged and judged byte for byte. KITHOOKDIRT1: when
# that in-tree hooks dir is itself git-tracked, kit-managed members and helpers
# are installed to the $GIT_DIR-local mirror <git-dir>/omp-kit-hooks instead,
# which git never lists, and one ignored dispatcher per kind runs them through
# the tracked runner. Tracked files are never written; tracked kit copies left
# for the owner are reported (the owner commits their deletion once and reruns).
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
# KITHOOKDIRT1: a hooks dir git tracks (core.hooksPath=.githooks with committed
# files) must never receive kit bytes: info/exclude rules cannot hide tracked
# paths, so every overwrite re-dirties the product tree. In that layout the
# kit-managed members and their helpers live in the $GIT_DIR-local mirror
# <git-dir>/omp-kit-hooks/hooks.d/<kind>/, which git never lists, and one
# ignored dispatcher per kind (hooks.d/<kind>/99-omp-kit-managed) runs them
# through the tracked runner's existing member glob. An untracked hooks dir
# (.git/hooks) keeps today's layout under $HOOKS.
TRACKED_HOOKS=0
KITHOOKS=""
KIT_MAP_DIR="$HOOKS/hooks.d/pre-commit"
MIGRATION_TRACKED=""
# is_tracked <path>: the path names a file git already tracks in $TARGET.
is_tracked() {
	git -C "$TARGET" ls-files --error-unmatch -- "$1" >/dev/null 2>&1
}
if [ -n "$(git -C "$TARGET" ls-files -- "$HOOKS")" ]; then
	TRACKED_HOOKS=1
	KITHOOKS=$(git -C "$TARGET" rev-parse --absolute-git-dir) || { echo "install-commit-msg-bead: cannot resolve the git dir of $TARGET" >&2; exit 2; }
	KITHOOKS="$KITHOOKS/omp-kit-hooks"
	KIT_MAP_DIR="$KITHOOKS/hooks.d/pre-commit"
	fi
# AUTH_HOOKS: the hooks root the authority checks inspect. A plain variable keeps
# the python heredoc ownership unambiguous for the staged-pysafe gate.
AUTH_HOOKS="${KITHOOKS:-$HOOKS}"

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
	[ -e "$KIT_MAP_DIR/template-import-map.json" ] ||
	[ -L "$KIT_MAP_DIR/template-import-map.json" ] ||
	[ -e "$KIT_MAP_DIR/template-import-map.sha256" ] ||
	[ -L "$KIT_MAP_DIR/template-import-map.sha256" ]; then
if ! python3 - "$AUTH_HOOKS" "$TEMPLATE_IMPORT_MAP" <<'PY'; then
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
	exit 2
fi
fi

check_template_import_map() {
	map_dir="$KIT_MAP_DIR"
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
commit_msg commit-msg bead-verdict.sh scripts/bead-verdict.sh -x
pre_push pre-push check-pushed-beads.sh scripts/check-pushed-beads.sh -x
pre_push pre-push commit-msg-bead.sh scripts/commit-msg-bead.sh -x
pre_push pre-push bead-verdict.sh scripts/bead-verdict.sh -x
on_main pre-push 30-omp-kit-on-main scripts/check-pushed-on-main.sh +x
pushed_vlevel pre-push 41-omp-kit-pushed-vlevel scripts/pre-push-verification-level.sh +x
affected_gate pre-push 42-omp-kit-affected-gate scripts/pre-push-affected-gate.sh +x
affected_gate pre-push declared-affected-gate.py scripts/declared-affected-gate.py -x
affected_gate pre-push fresh-gate-ledger.py scripts/fresh-gate-ledger.py -x
affected_gate pre-push suite-metrics.py scripts/suite-metrics.py -x
affected_gate pre-push suite-hermetic-env.sh scripts/suite-hermetic-env.sh -x
affected_gate pre-push fixed-env.sh scripts/fixed-env.sh -x
affected_gate pre-push kitlib_run.py scripts/kitlib_run.py -x
affected_gate pre-push kitlib_tmp.py scripts/kitlib_tmp.py -x
affected_gate pre-push pysafe.py scripts/pysafe.py -x
bead_record post-commit 50-omp-kit-bead-record scripts/bead-record.sh +x
bead_record post-commit commit-msg-bead.sh scripts/commit-msg-bead.sh -x
bead_record post-commit bead-verdict.sh scripts/bead-verdict.sh -x
ref_txn reference-transaction 40-omp-kit-ref-txn-bead scripts/ref-txn-bead.sh +x
ref_txn reference-transaction commit-msg-bead.sh scripts/commit-msg-bead.sh -x
ref_txn reference-transaction bead-verdict.sh scripts/bead-verdict.sh -x
ref_txn reference-transaction ref-txn-witness.py scripts/ref-txn-witness.py -x
ref_txn reference-transaction pysafe.py scripts/pysafe.py -x
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
staged_runtime pre-commit kitlib_run.py scripts/kitlib_run.py -x
staged_runtime pre-commit kitlib_io.py scripts/kitlib_io.py -x
staged_runtime pre-commit kitlib_tmp.py scripts/kitlib_tmp.py -x
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
staged_embed pre-commit 56-omp-kit-staged-embed scripts/check-staged-embed.sh +x
commit_notes commit-msg release-notes.ts scripts/release-notes.ts -x
commit_notes commit-msg limit-process-tree.sh scripts/limit-process-tree.sh -x
stale_worktree commit-msg 49-omp-kit-stale-worktree scripts/check-stale-worktree.sh +x
kitlib_reversal commit-msg 50-omp-kit-staged-kitlib-reversal scripts/check-commit-kitlib-reversal.sh +x
commit_gate commit-msg 55-omp-kit-commit-gate scripts/check-commit-gate.sh +x
commit_gate commit-msg scripts/check-red-main.py scripts/check-red-main.py -x
commit_gate commit-msg scripts/full-suite-verdict-store.py scripts/full-suite-verdict-store.py -x
commit_gate commit-msg scripts/suite-metrics.py scripts/suite-metrics.py -x
commit_gate commit-msg scripts/kitlib_run.py scripts/kitlib_run.py -x
commit_gate commit-msg scripts/kitlib_tmp.py scripts/kitlib_tmp.py -x
commit_gate commit-msg scripts/pysafe.py scripts/pysafe.py -x
commit_gate commit-msg scripts/commit-msg-bead.sh scripts/commit-msg-bead.sh -x
commit_gate commit-msg scripts/commit-msg-verification-level.sh scripts/commit-msg-verification-level.sh -x
commit_gate commit-msg scripts/check-commit-notes.sh scripts/check-commit-notes.sh -x
commit_gate commit-msg scripts/check-deploy-step.sh scripts/check-deploy-step.sh -x
commit_gate commit-msg scripts/bead-verdict.sh scripts/bead-verdict.sh -x
commit_gate commit-msg scripts/release-notes.ts scripts/release-notes.ts -x
commit_gate commit-msg scripts/limit-process-tree.sh scripts/limit-process-tree.sh -x
native_preservation pre-commit native-br-preserve.py scripts/native-br-preserve.py -x
INSTALLATION_MANIFEST
}

EXCLUDE_BEGIN='# BEGIN omp-kit installer-owned hook members (install-commit-msg-bead.sh rewrites this block; --check verifies it)'
EXCLUDE_END='# END omp-kit installer-owned hook members'

# exclude_hooks_rel: the hooks dir relative to the work tree, or nothing when git
# never lists its files (outside the tree, or inside the git dir as .git/hooks is).
exclude_hooks_rel() {
	hooks_real=$(CDPATH='' cd -- "$HOOKS" 2>/dev/null && pwd -P) || return 0
	top=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null) || return 0
	top=$(CDPATH='' cd -- "$top" && pwd -P) || return 0
	common=$(git -C "$TARGET" rev-parse --git-common-dir) || return 1
	case "$common" in /*) ;; *) common="$TARGET/$common" ;; esac
	common=$(CDPATH='' cd -- "$common" && pwd -P) || return 1
	gitdir=$(git -C "$TARGET" rev-parse --absolute-git-dir) || return 1
	gitdir=$(CDPATH='' cd -- "$gitdir" && pwd -P) || return 1
	case "$hooks_real/" in "$common"/* | "$gitdir"/*) return 0 ;; esac
	case "$hooks_real" in
		"$top"/*) printf '%s\n' "${hooks_real#"$top"/}" ;;
	esac
}

# exclude_block REL: the marked block, one anchored line per path this installer
# writes under REL: in a tracked hooks dir only the ignored dispatchers (and an
# entry runner the installer created itself); otherwise the manifest rows of
# this mode, the generated wrappers, and every hook entry that is a kit chain
# runner (a bespoke runner is never listed). Tracked entries are never listed:
# listing cannot hide them and the installer never writes them.
exclude_block() {
	rel_pattern=$(printf '%s' "$1" | sed 's/[][*?\\]/\\&/g')
	printf '%s\n' "$EXCLUDE_BEGIN"
	{
		if [ "$TRACKED_HOOKS" = 1 ]; then
			for dispatcher_kind in commit-msg post-commit pre-commit pre-push reference-transaction; do
				printf 'hooks.d/%s/99-omp-kit-managed\n' "$dispatcher_kind"
			done
		else
			while IFS=' ' read -r file_group file_chain file_dest file_source file_mode; do
				case "$file_group" in
					pre_push) [ "$PUSHED_BEADS" = 1 ] || continue ;;
					native_preservation) [ "$NATIVE_PRESERVATION" = 1 ] || continue ;;
				esac
				printf 'hooks.d/%s/%s\n' "$file_chain" "$file_dest"
			done <<EOF
$(installation_manifest)
EOF
			[ "$PUSHED_BEADS" = 0 ] || printf '%s\n' hooks.d/pre-push/40-omp-kit-pushed-beads
			[ "$NATIVE_PRESERVATION" = 0 ] || printf '%s\n' hooks.d/pre-commit/40-omp-kit-native-preserve
		fi
		for runner_type in commit-msg post-commit pre-commit pre-push reference-transaction; do
			if grep -q 'chain runner: run every executable' "$HOOKS/$runner_type" 2>/dev/null &&
				! is_tracked "$HOOKS/$runner_type"; then
				printf '%s\n' "$runner_type"
			fi
		done
	} | LC_ALL=C sort -u | while IFS= read -r owned; do printf '/%s/%s\n' "$rel_pattern" "$owned"; done
	printf '%s\n' "$EXCLUDE_END"
}

# exclude_render REL FILE: FILE with the marked block replaced in place (or
# appended); every other line is kept. Fails on a duplicated or unterminated block.
exclude_render() {
	block=$(exclude_block "$1") || return 1
	[ -f "$2" ] || { printf '%s\n' "$block"; return 0; }
	BLOCK=$block BEGIN_LINE=$EXCLUDE_BEGIN END_LINE=$EXCLUDE_END awk '
		$0 == ENVIRON["BEGIN_LINE"] { if (inside || seen) bad = 1; inside = 1; seen = 1; print ENVIRON["BLOCK"]; next }
		$0 == ENVIRON["END_LINE"] { if (!inside) bad = 1; inside = 0; next }
		!inside { print }
		END { if (inside) bad = 1; if (!seen) print ENVIRON["BLOCK"]; exit bad }' "$2"
}

exclude_path() {
	exclude_file=$(git -C "$TARGET" rev-parse --git-path info/exclude) || return 1
	case "$exclude_file" in /*) ;; *) exclude_file="$TARGET/$exclude_file" ;; esac
	printf '%s\n' "$exclude_file"
}

# write_exclude_block: publish the block after every probe passed. Same bytes on a
# repeat install; recorded for rollback like every other installer mutation.
write_exclude_block() {
	rel=$(exclude_hooks_rel) || return 1
	[ -n "$rel" ] || return 0
	case "$rel" in *'
'*) return 1 ;; esac
	exclude_file=$(exclude_path) || return 1
	mkdir -p "$(dirname -- "$exclude_file")" || return 1
	staged="$exclude_file.install.$$"
	if ! exclude_render "$rel" "$exclude_file" > "$staged"; then
		rm -f "$staged"
		return 1
	fi
	if [ -f "$exclude_file" ] && cmp -s "$staged" "$exclude_file"; then
		rm -f "$staged"
		return 0
	fi
	if [ -e "$exclude_file" ]; then backup "$exclude_file"; else UNDO_RM="$UNDO_RM $exclude_file"; fi
	if ! mv -f "$staged" "$exclude_file"; then
		rm -f "$staged"
		return 1
	fi
	printf 'listed installer-owned hook members in %s\n' "$exclude_file"
}

chain_dir() {
	if [ "$TRACKED_HOOKS" = 1 ]; then
		printf '%s/hooks.d/%s' "$KITHOOKS" "$1"
	else
		printf '%s/hooks.d/%s' "$HOOKS" "$1"
	fi
}

# Only byte-identical kit copies are retired; an owner-adapted member must be
# reviewed by its owner rather than silently removed. Numeric prefixes varied
# between install sites, so match the managed basename, not its ordering slot.
retired_hook_members() {
	for retired in "$HOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-gap-mention \
		"$HOOKS/hooks.d/pre-commit/"[0-9][0-9]-omp-kit-staged-sources \
		"$HOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-commit-msg-bead \
		"$HOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-commit-msg-vlevel \
		"$HOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-commit-notes \
		"$HOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-deploy-step; do
		[ -e "$retired" ] || [ -L "$retired" ] || continue
		printf '%s\n' "$retired"
	done
	# In a tracked hooks dir the mirror holds the same retired names from
	# earlier mirror installs; the $HOOKS globs above cover the worktree side.
	if [ "$TRACKED_HOOKS" = 1 ]; then
		for retired in "$KITHOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-gap-mention \
			"$KITHOOKS/hooks.d/pre-commit/"[0-9][0-9]-omp-kit-staged-sources \
			"$KITHOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-commit-msg-bead \
			"$KITHOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-commit-msg-vlevel \
			"$KITHOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-commit-notes \
			"$KITHOOKS/hooks.d/commit-msg/"[0-9][0-9]-omp-kit-deploy-step; do
			[ -e "$retired" ] || [ -L "$retired" ] || continue
			printf '%s\n' "$retired"
		done
	fi
	# The pre-canonical stamp pair lives in the bespoke slot, so it is listed
	# only when its bytes match the retired pin: a live bespoke entry moved to
	# the same 10- slot by ensure_chain is never touched or flagged.
	for legacy in "$HOOKS/hooks.d/commit-msg/10-commit-msg" \
		"$HOOKS/hooks.d/commit-msg/commit-msg-verification-level.sh"; do
		[ -e "$legacy" ] || [ -L "$legacy" ] || continue
		expected=$(legacy_stamp_sha "$legacy") || continue
		[ "$(shasum -a 256 "$legacy" 2>/dev/null | cut -d' ' -f1)" = "$expected" ] || continue
		printf '%s\n' "$legacy"
	done
}

# legacy_stamp_sha <path>: the retired pin for the pre-canonical stamp pair
# (HOOKDEDUP1 ompkit-1ra0d.60): the bespoke-slot wrapper
# hooks.d/commit-msg/10-commit-msg, which execs the sibling impl
# hooks.d/commit-msg/commit-msg-verification-level.sh. Both predate the
# canonical member 41 (VLEVELGAP1), which keeps enforcing the same rule with
# the same refusal text and code. Fails for any other basename.
legacy_stamp_sha() {
	case "$1" in
		*/10-commit-msg) printf '%s' '420af8f6d4af0c520cafa22e94c9c573fafe39adfe02358827698a1f7cc70ce1' ;;
		*/commit-msg-verification-level.sh) printf '%s' 'c325a40aee77ea1118a106eadea5b233f94b8c318d1aef4ca9f467a7d47300b8' ;;
		*) return 1 ;;
	esac
}
# folded_is_shipped <key> <sha>: COMMITMERGE1 retired the standalone commit-msg
# members into the 55 aggregator. Every historical blob content sha256 is pinned
# here, so only a truly hand-edited member refuses refresh. Keys: bead, vlevel,
# notes, deploy. Captured via: git log --format=%H -- <source> then
# git show <commit>:<source> | shasum -a 256 (content bytes, as installed).
folded_is_shipped() {
	case "$1:$2" in
		bead:3d777904c500bcda10390ce2adee26750e85a2090c6402937772898bafc4b3b6|bead:0d9a4d47be60ebd343f23c3692dbac55acf763a421b2363460a559f010962c4a|bead:eae7bdfd2e8b7f71cda355ea3621b5893b90d7d4df94a205a8a2350cb941fc0f|bead:9da8c3ed801b4489038b7297ff21373360a7a2998fa8cb2bb2e1dece09e2e418|bead:fc1fb6881fb55fbbb0277c36f696799ca65a9672ac451d477341e12a27b63732|bead:9d0f94b679428f35879d5db23e40e1e48adf1b97ddfb9e87508ea73856f8098f|bead:a62dab4508b9837c5bbf08ba7a8839514660076a2aafbc8d8582da9730c22941|bead:5c81c54bfe078c063acd79cdee9d29e120aee13efca06850729cfbd45859450d) return 0 ;;
		vlevel:07b3208b91f8b01f2966abeb1faf2493b5e4c938ae262d781da278c57a161b98) return 0 ;;
		notes:32b934256c560325bb66d6d23821bcb8d0d14efbec251be2f3af017bb60afffe|notes:782034c2b88329b6fd75f5b388bf137c24d8d64719e0368167ef2da8dcf98b33|notes:7311d32b1131fc8a7d9fe117a45371fd892624fbdd66574f07923ce12e21150f) return 0 ;;
		deploy:3394d20967b47019dc1775ace0f51e62b1e2b86f2f28294d924a964accb747a1) return 0 ;;
		# RETIRESHIPPED1 (ompkit-1ra0d.243): RETIREHOOKS1's standalone members, every shipped blob.
		# A repo installed from an older release holds the older bytes; that copy is the kit's, not
		# the owner's, so it retires instead of refusing the whole refresh.
		gap:8aa0bc9c7404110f27a5b9fdd84efdb028d8d3a84e0cb996dd9661bf6b008762|gap:e6e80d85fdd24b675d51c7fb10ea45b9862b6d6ad03fb16a03a76c812d05f278) return 0 ;;
		sources:0d971b18f6a686b7993d3eb6a6445d100802e9a53e032f763a67e184856b2d30|sources:0c9812625671c2eeda324e981571ade394be03aac92a5fe226dd8fae945cc279) return 0 ;;
		*) return 1 ;;
	esac
}

retire_hook_members() {
	# Validate the complete set before removing any member.
	while IFS= read -r retired; do
		[ -n "$retired" ] || continue
		case "$retired" in
			*-omp-kit-gap-mention|*-omp-kit-staged-sources) expected="" ;;
			*/10-commit-msg) expected=$(legacy_stamp_sha "$retired") ;;
			*/commit-msg-verification-level.sh) expected=$(legacy_stamp_sha "$retired") ;;
			*-omp-kit-commit-msg-bead|*-omp-kit-commit-msg-vlevel|*-omp-kit-commit-notes|*-omp-kit-deploy-step) expected="" ;;
		esac
		if [ -L "$HOOKS/hooks.d" ] || [ -L "$(dirname -- "$retired")" ] ||
			[ -L "$retired" ] || [ ! -f "$retired" ]; then
			printf 'install-commit-msg-bead: REFUSED owner-modified retired member: %s; owner review required\n' "$retired" >&2
			exit 2
		fi
		case "$retired" in
			*-omp-kit-commit-msg-bead) key=bead ;;
			*-omp-kit-commit-msg-vlevel) key=vlevel ;;
			*-omp-kit-commit-notes) key=notes ;;
			*-omp-kit-deploy-step) key=deploy ;;
			*-omp-kit-gap-mention) key=gap ;;
			*-omp-kit-staged-sources) key=sources ;;
			*) key="" ;;
		esac
		if [ -n "$key" ]; then
			actual=$(shasum -a 256 "$retired" 2>/dev/null | cut -d' ' -f1)
			if ! folded_is_shipped "$key" "$actual"; then
				printf 'install-commit-msg-bead: REFUSED owner-modified retired member: %s; owner review required\n' "$retired" >&2
				exit 2
			fi
		elif [ "$(shasum -a 256 "$retired" 2>/dev/null | cut -d' ' -f1)" != "$expected" ]; then
			printf 'install-commit-msg-bead: REFUSED owner-modified retired member: %s; owner review required\n' "$retired" >&2
			exit 2
		fi
	done <<EOF
$(retired_hook_members)
EOF
	while IFS= read -r retired; do
		[ -n "$retired" ] || continue
		if [ "$TRACKED_HOOKS" = 1 ] && is_tracked "$retired"; then
			printf 'left tracked retired kit copy for the owner migration: %s\n' "$retired"
			MIGRATION_TRACKED="$MIGRATION_TRACKED $retired"
			continue
		fi
		backup "$retired"
		rm -f -- "$retired" || rollback "cannot retire $retired"
		printf 'retired kit hook member: %s\n' "$retired"
	done <<EOF
$(retired_hook_members)
EOF
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
	mode=$(python3 -c 'import os,sys; print(format(os.stat(sys.argv[1]).st_mode & 0o7777, "o"))' "$1")
	printf '%s\n' "$mode" > "$undo.mode"
	chmod a-x "$undo"
	UNDO_RESTORE="$UNDO_RESTORE $1"
}

# place <src> <dest> <mode>: install a file, recording how to undo it.
# KITHOOKDIRT1: in a tracked hooks dir, never write a tracked file. Mirror
# destinations live under $GIT_DIR (never tracked); dispatcher and entry
# destinations under a tracked $HOOKS are allowed only while untracked, so the
# marked info/exclude block keeps `git add -A` from staging them.
place() {
	if [ "$TRACKED_HOOKS" = 1 ]; then
		case "$2" in
			"$HOOKS"/*) is_tracked "$2" && { echo "install-commit-msg-bead: REFUSED tracked file, owner migration required: $2" >&2; return 1; } ;;
		esac
	fi
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

# emit_heredoc: copy stdin to stdout with shell builtins only. --check runs under a
# restricted PATH (no cat/sed/grep), so the generators and their readers never exec a tool.
emit_heredoc() {
	while IFS= read -r emit_line; do printf '%s\n' "$emit_line"; done
}

# has_line_with <file> <literal>: some line of <file> contains <literal> (builtins only).
has_line_with() {
	[ -f "$1" ] || return 1
	while IFS= read -r has_line || [ -n "$has_line" ]; do
		case "$has_line" in *"$2"*) return 0 ;; esac
	done < "$1"
	return 1
}

# runner_body: the chain runner's exact bytes. Hook types fed on stdin (pre-push,
# reference-transaction) replay one buffered copy to every member, so a
# member that reads stdin cannot starve the ones after it.
runner_body() {
	emit_heredoc <<'EOF'
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
# GATEEVENTS1 runner v7: per-member wall start and monotonic elapsed accompany verdicts;
# each verdict is one gate-events row (act = commit/publish, gate = member name); FINDING lines (kitlib-findings.sh
# grammar) from every member are collected into ONE envelope printed once at the end, and the chain exits
# non-zero once iff any member found something. A legacy member that exits non-zero without FINDING lines
# contributes one finding carrying its last stderr line, so nothing is silenced during the conversion.
ledger="$here/hooks.d/commit-msg/gate-event.sh"
case "$kind" in pre-commit | commit-msg | prepare-commit-msg) act=commit ;; pre-push) act=publish ;; *) act=$kind ;; esac
target=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf '%s' '')
# A pre-push invocation is one latency sample, even if a long-lived parent shell reuses its pid.
attempt="git-$PPID"
if [ "$kind" = pre-push ]; then attempt="$attempt-$(python3 -c 'import time; print(time.time_ns())')"; fi
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
	# Python <3.10 on macOS makes monotonic() process-relative; use the shared kernel clock.
	member_clock=$(python3 -c 'import time; print(time.time(), time.clock_gettime(time.CLOCK_MONOTONIC))')
	member_started_epoch=${member_clock% *}
	member_started_mono=${member_clock#* }
	if [ -n "$input" ]; then out=$(run_member "$@" < "$input" 2> "$errf") || member_rc=$?; else out=$(run_member "$@" 2> "$errf") || member_rc=$?; fi
	member_finished_mono=$(python3 -c 'import time; print(time.clock_gettime(time.CLOCK_MONOTONIC))')
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
		OMP_KIT_GATE_EVENT_STARTED_EPOCH=$member_started_epoch OMP_KIT_GATE_EVENT_STARTED_MONO=$member_started_mono \
		OMP_KIT_GATE_EVENT_FINISHED_MONO=$member_finished_mono \
		OMP_KIT_GATE_EVENT_RC=$member_rc OMP_KIT_GATE_EVENT_HOOK=$kind OMP_KIT_GATE_EVENT_MESSAGE_FILE=$message_file \
			sh "$ledger" "$act" "$target" "$member" "$row" "$attempt" "findings=$n rc=$member_rc" "$@" || :
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
}

# The runner generation is read from runner_body itself, so installer upgrades and
# --check judge staleness by one source; bump the marker in runner_body with every change.
runner_generation() {
	while IFS= read -r gen_line; do
		case "$gen_line" in
			'# GATEEVENTS1 runner v'[0-9]*:*) gen_line=${gen_line#'# '}; printf '%s\n' "${gen_line%%:*}"; return 0 ;;
		esac
	done
	return 1
}
RUNNER_GENERATION=$(runner_body | runner_generation) || RUNNER_GENERATION=''
[ -n "$RUNNER_GENERATION" ] || { echo 'install-commit-msg-bead: runner_body carries no GATEEVENTS1 generation marker' >&2; exit 2; }

# runner_stale <path>: a kit chain runner (bespoke runners are never judged) that
# lacks stdin replay or the current generation marker. Install and --check share it.
runner_stale() {
	has_line_with "$1" 'chain runner: run every executable' &&
		{ ! has_line_with "$1" 'replay one buffered copy' || ! has_line_with "$1" "$RUNNER_GENERATION:"; }
}

# managed_dispatcher_body: the ignored shim a tracked hook chain executes to
# reach the $GIT_DIR-local mirror. It runs every executable NN-* member in
# <git-dir>/omp-kit-hooks/hooks.d/<kind> with the hook's arguments, replaying
# stdin for the stdin-fed kinds, and exits with the first refusal code, so the
# tracked runner judges the current kit rules without tracking kit bytes.
managed_dispatcher_body() {
	emit_heredoc <<'EOF'
#!/bin/sh
# omp-kit managed-mirror dispatcher (KITHOOKDIRT1): run the $GIT_DIR-local kit
# members for this hook kind. Installed ignored-beside a tracked hook chain;
# never committed. The tracked runner executes this file.
set -u
dispatcher_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 0
kind=$(basename -- "$dispatcher_dir")
gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null || printf '%s' "${GIT_DIR:-}") || exit 0
[ -n "$gitdir" ] || exit 0
mirror="$gitdir/omp-kit-hooks/hooks.d/$kind"
[ -d "$mirror" ] || exit 0
input=""
case "$kind" in
	pre-push | reference-transaction | post-rewrite)
		input=$(mktemp "${TMPDIR:-/tmp}/kit-mirror-input.XXXXXX") || exit 1
		cat > "$input" || exit 1
		;;
esac
rc=0
run_mirror_member() {
	if [ -n "$input" ]; then
		"$@" < "$input"
	else
		"$@"
	fi
}
for member in "$mirror"/[0-9][0-9]-*; do
	[ -e "$member" ] || continue
	[ -x "$member" ] || continue
	first=''
	IFS= read -r first < "$member" || :
	member_rc=0
	case "$first" in
		'#!'*) run_mirror_member "$member" "$@" || member_rc=$? ;;
		*) run_mirror_member sh "$member" "$@" || member_rc=$? ;;
	esac
	if [ "$member_rc" -ne 0 ] && [ "$rc" -eq 0 ]; then rc=$member_rc; fi
done
[ -z "$input" ] || rm -f "$input"
exit "$rc"
EOF
}
# collect_tracked_migration: every kit-managed path under a tracked $HOOKS that
# git tracks is left in place and reported, so the owner can commit the
# deletion once and rerun. Never fatal: the mirror already runs the current
# rules beside the tracked copies.
collect_tracked_migration() {
	[ "$TRACKED_HOOKS" = 1 ] || return 0
	while IFS=' ' read -r _file_group file_chain file_dest _file_source _file_mode; do
		candidate="$HOOKS/hooks.d/$file_chain/$file_dest"
		if is_tracked "$candidate"; then
			case "$MIGRATION_TRACKED" in
				*"$candidate"*) ;;
				*) MIGRATION_TRACKED="$MIGRATION_TRACKED $candidate" ;;
			esac
		fi
	done <<EOF
$(installation_manifest)
EOF
	# Mode-independent: a tracked kit-managed wrapper the owner left behind needs
	# the same one-time migration even when this install runs without that group.
	if is_tracked "$HOOKS/hooks.d/pre-push/40-omp-kit-pushed-beads"; then
		MIGRATION_TRACKED="$MIGRATION_TRACKED $HOOKS/hooks.d/pre-push/40-omp-kit-pushed-beads"
	fi
	if is_tracked "$HOOKS/hooks.d/pre-commit/40-omp-kit-native-preserve"; then
		MIGRATION_TRACKED="$MIGRATION_TRACKED $HOOKS/hooks.d/pre-commit/40-omp-kit-native-preserve"
	fi
	for _map in "$HOOKS/hooks.d/pre-commit/template-import-map.json" "$HOOKS/hooks.d/pre-commit/template-import-map.sha256"; do
		if is_tracked "$_map"; then
			case "$MIGRATION_TRACKED" in
				*"$_map"*) ;;
				*) MIGRATION_TRACKED="$MIGRATION_TRACKED $_map" ;;
			esac
		fi
	done
}

# write_runner <path>: install runner_body as the chain runner.
write_runner() {
	path=$1
	# KITHOOKDIRT1: never rewrite a tracked product file (ensure_chain keeps
	# tracked entries; this is the backstop).
	if [ "$TRACKED_HOOKS" = 1 ]; then
		case "$path" in
			"$HOOKS"/*) is_tracked "$path" && { echo "install-commit-msg-bead: REFUSED tracked file, owner migration required: $path" >&2; return 1; } ;;
		esac
	fi
	if [ -e "$path" ]; then backup "$path"; else UNDO_RM="$UNDO_RM $path"; fi
	# Stage beside the hook; rename publishes it without truncating running readers.
	staged="$path.install.$$"
	runner_body > "$staged" || { rm -f "$staged"; return 1; }
	if ! chmod +x "$staged" || ! mv -f "$staged" "$path"; then
		rm -f "$staged"
		return 1
	fi
}

# ensure_chain <type>: make $HOOKS/<type> a chain runner, preserving any
# bespoke entry by moving it to 10-<type>. Prints what it did.
# KITHOOKDIRT1: a tracked entry is never moved or rewritten; the managed
# dispatchers below reach the mirror through its existing member glob.
ensure_chain() {
	type=$1
	entry="$HOOKS/$type"
	dir=$(chain_dir "$type")
	entrydir="$HOOKS/hooks.d/$type"
	mkdir -p "$dir"
	if [ ! -e "$entry" ]; then
		mkdir -p "$entrydir"
		write_runner "$entry"
		printf 'created chain runner: %s\n' "$entry"
		return 0
	fi
	if [ "$TRACKED_HOOKS" = 1 ] && is_tracked "$entry"; then
		printf 'tracked chain runner left in place: %s\n' "$entry"
		return 0
	fi
	if [ -x "$entry" ] && grep -q 'hooks\.d' "$entry" 2>/dev/null; then
		# runner_stale names the generation from runner_body; --check reports the same predicate.
		if runner_stale "$entry"; then
			write_runner "$entry"
			printf 'upgraded chain runner (stdin replay + gate-events ledger): %s\n' "$entry"
		else
			printf 'chain runner already present: %s\n' "$entry"
		fi
		return 0
	fi
	# Record every mutation for rollback (globals: appended across both hook
	# types, consumed only when a probe fails below).
	if [ -e "$entrydir/10-$type" ]; then
		printf 'install-commit-msg-bead: %s already staged in chain: %s/10-%s\n' "$type" "$entrydir" "$type" >&2
		return 0
	fi
	mv "$entry" "$entrydir/10-$type"
	UNDO_MOVES="$UNDO_MOVES $entry:$entrydir/10-$type"
	# Sibling impls resolve by dirname of the moved entry (fail-closed
	# wrappers); move "<type>-*" siblings alongside so they keep resolving.
	# Tracked siblings stay for the owner (migration note); only untracked
	# files move.
	for sibling in "$HOOKS/$type"-*; do
		[ -e "$sibling" ] || continue
		if [ "$TRACKED_HOOKS" = 1 ] && is_tracked "$sibling"; then
			printf 'left tracked hook sibling for the owner migration: %s\n' "$sibling"
			MIGRATION_TRACKED="$MIGRATION_TRACKED $sibling"
			continue
		fi
		UNDO_MOVES="$UNDO_MOVES $sibling:$entrydir/$(basename -- "$sibling")"
		mv -- "$sibling" "$entrydir/"
	done
	write_runner "$entry"
	printf 'moved bespoke %s to %s/10-%s and created chain runner\n' "$type" "$entrydir" "$type"
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

# install_commit_msg: COMMITMERGE1 folded the 40-bead member into 55-aggregator;
# this group now installs only the shared bead-verdict helper the aggregator,
# the pre-push members, the ref guard and the post-commit recorder reuse.
install_commit_msg() {
	install_manifest_group commit_msg
	printf 'installed bead-verdict helper beside the commit-msg chain\n'
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
	pushed_beads_wrapper > "$wrapper" || { rm -f "$wrapper"; exit 2; }
	place "$wrapper" "$member" +x
	rm -f "$wrapper"
	printf 'installed pushed-beads member: %s\n' "$member"
}

# pushed_beads_wrapper: the generated pre-push member; install writes it and --check compares it.
pushed_beads_wrapper() {
	emit_heredoc <<'EOF'
#!/bin/sh
# pre-push member: refuse pushed ranges with id-less commits.
set -u
exec sh "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/check-pushed-beads.sh" --pre-push
EOF
}

# --check names installed members that differ from this checkout (a stale
# installed hook runs old rules after the source moves on). Exit 0 when every
# member matches, 3 naming each missing or stale member.
if [ "$MODE" = "check" ]; then
	stale=0
	while IFS= read -r retired; do
		[ -n "$retired" ] || continue
		if [ "$TRACKED_HOOKS" = 1 ] && is_tracked "$retired"; then
			printf 'install-commit-msg-bead: TRACKED retired kit copy: %s; owner migration required (git rm, commit, rerun %s)\n' "$retired" "$0" >&2
		else
			printf 'install-commit-msg-bead: RETIRED installed member: %s; rerun %s\n' "$retired" "$0" >&2
		fi
		stale=1
	done <<EOF
$(retired_hook_members)
EOF
	while IFS=' ' read -r file_group file_chain file_dest file_source file_mode; do
		case "$file_group" in
			pre_push) [ "$PUSHED_BEADS" = 1 ] || continue ;;
			native_preservation) [ "$NATIVE_PRESERVATION" = 1 ] || continue ;;
		esac
		dest="$(chain_dir "$file_chain")/$file_dest"
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
	parser="$(chain_dir pre-commit)/check-commit-imports.sh"
	if [ ! -f "$parser" ] || ! sh "$parser" --parser-info --repo "$TARGET"; then
		printf 'install-commit-msg-bead: MISSING or STALE installed import parser in %s\n' "$TARGET" >&2
		stale=1
	fi
	if [ "$NATIVE_PRESERVATION" = 1 ]; then
		dir="$KIT_MAP_DIR"
		if ! native_member | cmp -s "$dir/40-omp-kit-native-preserve" -; then
			printf 'install-commit-msg-bead: MISSING or STALE native-preservation member in %s\n' "$TARGET" >&2
			stale=1
		fi
	fi
	if ! check_template_import_map; then
		printf 'install-commit-msg-bead: MISSING or STALE reviewed template-import-map in %s\n' "$TARGET" >&2
		stale=1
	fi
	rel=$(exclude_hooks_rel) || rel=UNREADABLE
	if [ -n "$rel" ]; then
		exclude_file=$(exclude_path) || exclude_file=''
		if [ "$rel" = UNREADABLE ] || [ ! -f "$exclude_file" ] ||
			! { exclude_render "$rel" "$exclude_file" || printf 'MALFORMED\n'; } | cmp -s - "$exclude_file"; then
			printf 'install-commit-msg-bead: MISSING or STALE installer-owned block in %s; rerun %s\n' "${exclude_file:-info/exclude}" "$0" >&2
			stale=1
		fi
	fi
	# Chain runners judged by the installer's own upgrade predicate; bespoke runners are skipped.
	# In a tracked hooks dir a tracked runner is never rewritten: a stale kit
	# runner is reported for the owner migration instead.
	for runner_type in post-commit pre-commit commit-msg pre-push reference-transaction; do
		if runner_stale "$HOOKS/$runner_type"; then
			if [ "$TRACKED_HOOKS" = 1 ] && is_tracked "$HOOKS/$runner_type"; then
				printf 'install-commit-msg-bead: TRACKED chain runner: %s lacks %s; owner migration required (commit the runner update once)\n' "$HOOKS/$runner_type" "$RUNNER_GENERATION" >&2
			else
				printf 'install-commit-msg-bead: STALE chain runner: %s lacks %s; rerun %s\n' "$HOOKS/$runner_type" "$RUNNER_GENERATION" "$0" >&2
			fi
			stale=1
		fi
	done
	if [ "$PUSHED_BEADS" = 1 ] && ! pushed_beads_wrapper | cmp -s - "$(chain_dir pre-push)/40-omp-kit-pushed-beads"; then
		printf 'install-commit-msg-bead: MISSING or STALE pushed-beads member: %s; rerun %s\n' "$(chain_dir pre-push)/40-omp-kit-pushed-beads" "$0" >&2
		stale=1
	fi
	if [ "$TRACKED_HOOKS" = 1 ]; then
		for dispatcher_kind in commit-msg post-commit pre-commit pre-push reference-transaction; do
			if ! managed_dispatcher_body | cmp -s - "$HOOKS/hooks.d/$dispatcher_kind/99-omp-kit-managed" 2>/dev/null; then
				printf 'install-commit-msg-bead: MISSING or STALE managed dispatcher: %s; rerun %s\n' "$HOOKS/hooks.d/$dispatcher_kind/99-omp-kit-managed" "$0" >&2
				stale=1
			fi
		done
		collect_tracked_migration
		if [ -n "$MIGRATION_TRACKED" ]; then
			# shellcheck disable=SC2086
			for _migrated in $MIGRATION_TRACKED; do
				printf 'install-commit-msg-bead: TRACKED installed member: %s; owner migration required (git rm, commit, rerun %s)\n' "$_migrated" "$0" >&2
			done
			stale=1
		fi
	fi
	if [ "$stale" = 0 ]; then printf 'install-commit-msg-bead: hooks fresh in %s\n' "$TARGET"; exit 0; fi
	exit 3
fi

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
# of the companion scripts/pre-push-verification-level.sh; it refuses every
# push while its paired commit-msg member (below) is missing or stale, and
# --check names any stale installation.
install_pushed_vlevel() {
	member="$(chain_dir pre-push)/41-omp-kit-pushed-vlevel"
	install_manifest_group pushed_vlevel
	printf 'installed pushed-verification-level member: %s\n' "$member"
}

# install_commit_msg_vlevel: COMMITMERGE1 retired the standalone 41 member into
# the 55 aggregator (the helper lives in the commit_gate group now). Kept as a
# no-op so refresh removes the stale member via retired_hook_members instead of
# reinstalling it.
install_commit_msg_vlevel() {
	printf 'retired commit-msg verification-level member into 55-omp-kit-commit-gate\n'
}

# install_ref_txn: the plumbing backstop. commit-tree + update-ref and
# --no-verify never run commit-msg; git runs reference-transaction for every
# ref update. The judge sits beside the member, non-executable (see above).
# So do the reviewed-history witness reader and its pysafe.py (HISTADMIT1).
install_ref_txn() {
	dir=$(chain_dir reference-transaction)
	member="$dir/40-omp-kit-ref-txn-bead"
	install_manifest_group ref_txn
	printf 'installed ref-update bead guard: %s\n' "$member"
}

# install_bead_record: the post-commit verdict recorder (HOOKDEDUP1
# ompkit-1ra0d.60). The commit-time bead verdict is copied to a record keyed
# by the exact commit sha under <git-common-dir>/omp-kit/bead-verdicts/, so
# the pre-push and reference-transaction members reuse it instead of
# re-running `br` per commit. The member never refuses (see bead-record.sh).
install_bead_record() {
	dir=$(chain_dir post-commit)
	member="$dir/50-omp-kit-bead-record"
	install_manifest_group bead_record
	printf 'installed post-commit bead recorder: %s\n' "$member"
}

# validate_tracked_layout: refuse before any mutation when the tracked layout
# cannot host the mirror (a tracked bespoke entry that cannot be moved, or a
# tracked file blocking the dispatcher path). The owner migrates those by hand,
# commits, and reruns; nothing is moved or rewritten for them here.
validate_tracked_layout() {
	[ "$TRACKED_HOOKS" = 1 ] || return 0
	for kind in commit-msg post-commit pre-commit pre-push reference-transaction; do
		entry="$HOOKS/$kind"
		dispatcher="$HOOKS/hooks.d/$kind/99-omp-kit-managed"
		if is_tracked "$dispatcher"; then
			echo "install-commit-msg-bead: REFUSED tracked file blocks the managed dispatcher (rename it, commit the rename, rerun): $dispatcher" >&2
			return 1
		fi
		if [ -e "$entry" ] || [ -L "$entry" ]; then
			if is_tracked "$entry" && ! grep -q 'hooks\.d' "$entry" 2>/dev/null; then
				echo "install-commit-msg-bead: REFUSED tracked bespoke hook (move it to $HOOKS/hooks.d/$kind/10-$kind, commit the move, rerun): $entry" >&2
				return 1
			fi
		fi
	done
}

# ensure_mirror_dirs: the mirror lives under $GIT_DIR; create its kind dirs.
ensure_mirror_dirs() {
	[ "$TRACKED_HOOKS" = 1 ] || return 0
	for kind in commit-msg post-commit pre-commit pre-push reference-transaction; do
		mkdir -p "$KITHOOKS/hooks.d/$kind" || return 1
	done
}

# install_managed_dispatchers: in a tracked hooks dir, one ignored dispatcher
# per kind so the tracked runner reaches the $GIT_DIR-local mirror. place()
# refuses a tracked-occupied dispatcher path; validate_tracked_layout already
# refused that case before any mutation, so reaching the guard is a bug.
install_managed_dispatchers() {
	[ "$TRACKED_HOOKS" = 1 ] || return 0
	for dispatcher_kind in commit-msg post-commit pre-commit pre-push reference-transaction; do
		dest="$HOOKS/hooks.d/$dispatcher_kind/99-omp-kit-managed"
		mkdir -p "$(dirname -- "$dest")" || return 1
		wrapper=$(mktemp "${TMPDIR:-/tmp}/kit-dispatcher.XXXXXX") || return 1 # tempsafe: installer-owned staged file beside the target hooks dir, removed on success or rollback
		managed_dispatcher_body > "$wrapper" || { rm -f "$wrapper"; return 1; }
		place "$wrapper" "$dest" +x || { rm -f "$wrapper"; return 1; }
		rm -f "$wrapper"
		printf 'installed managed-mirror dispatcher: %s\n' "$dest"
	done
}

# sweep_untracked_shadow_copies: a hooks dir that became tracked can still hold
# untracked copies of current member names from a previous same-path install.
# They would run twice (here and via the dispatcher); remove the untracked
# ones. Tracked files are never touched (the owner migration covers them).
sweep_untracked_shadow_copies() {
	[ "$TRACKED_HOOKS" = 1 ] || return 0
	while IFS=' ' read -r _file_group file_chain file_dest _file_source _file_mode; do
		shadow="$HOOKS/hooks.d/$file_chain/$file_dest"
		if [ -e "$shadow" ] && ! is_tracked "$shadow"; then
			backup "$shadow"
			rm -f -- "$shadow" || rollback "cannot sweep shadow copy $shadow"
			printf 'swept untracked shadow copy: %s\n' "$shadow"
		fi
	done <<EOF
$(installation_manifest)
EOF
	if [ "$PUSHED_BEADS" = 1 ]; then
		shadow="$HOOKS/hooks.d/pre-push/40-omp-kit-pushed-beads"
		if [ -e "$shadow" ] && ! is_tracked "$shadow"; then
			backup "$shadow"
			rm -f -- "$shadow" || rollback "cannot sweep shadow copy $shadow"
			printf 'swept untracked shadow copy: %s\n' "$shadow"
		fi
	fi
	if [ "$NATIVE_PRESERVATION" = 1 ]; then
		shadow="$HOOKS/hooks.d/pre-commit/40-omp-kit-native-preserve"
		if [ -e "$shadow" ] && ! is_tracked "$shadow"; then
			backup "$shadow"
			rm -f -- "$shadow" || rollback "cannot sweep shadow copy $shadow"
			printf 'swept untracked shadow copy: %s\n' "$shadow"
		fi
	fi
}


# print_tracked_migration: the one documented migration. The owner commits the
# deletion of the listed tracked copies once and reruns this installer; until
# then the mirror runs the current rules beside them.
print_tracked_migration() {
	[ -n "$MIGRATION_TRACKED" ] || return 0
	# shellcheck disable=SC2086
	count=0; for _path in $MIGRATION_TRACKED; do count=$((count + 1)); done
	printf 'install-commit-msg-bead: TRACKED kit copies remain under %s (%s file(s)); the current rules run from %s via ignored dispatchers.\n' "$HOOKS" "$count" "$KITHOOKS" >&2
	printf 'install-commit-msg-bead: migration (owner commits the deletion once, then reruns this installer):\n' >&2
	printf '  git -C %s rm -- ' "$TARGET" >&2
	# shellcheck disable=SC2086
	for _path in $MIGRATION_TRACKED; do printf '%s ' "$_path" >&2; done
	printf '\n' >&2
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
# wall-clock bound; it runs the checker beside it under pysafe.py, with kitlib_run.py from staged_runtime.
install_staged_wallclock() {
	dir=$(chain_dir pre-commit)
	member="$dir/55-omp-kit-staged-wallclock"
	install_manifest_group staged_wallclock
	printf 'installed staged-wallclock member: %s\n' "$member"
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
# install_staged_embed: EMBEDDEP1 (ompkit-fp72.120.16.197) refuses a commit whose staged generated
# embed (installer/install.py) is stale against its staged inputs; it runs the staged producer's --check.
install_staged_embed() {
	dir=$(chain_dir pre-commit)
	member="$dir/56-omp-kit-staged-embed"
	install_manifest_group staged_embed
	printf 'installed staged-embed member: %s\n' "$member"
}

# install_commit_notes: COMMITMERGE1 folded the 46-notes member into the 55
# aggregator; this group now installs only the resolver helpers the aggregator
# invokes beside the chain.
install_commit_notes() {
	install_manifest_group commit_notes
	printf 'installed commit-notes helpers beside the commit-msg chain\n'
}
# install_deploy_step: COMMITMERGE1 retired the standalone 48 member into the 55
# aggregator (the helper lives in the commit_gate group now). Kept as a no-op.
install_deploy_step() {
	printf 'retired deploy-step member into 55-omp-kit-commit-gate\n'
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

# install_commit_gate: COMMITPARITY1 (ompkit-9d9fx) + COMMITMERGE1 (ompkit-1ra0d.130).
# The commit-msg member runs the installed pre-push fresh-gate member on the commit
# being made, so a commit the push would refuse never lands on main. It checks the
# recorded release verdict even without a pre-push member, and runs last. It also
# aggregates the folded commit-msg findings (bead id, verification level, notes,
# deploy step) under one code with the folded helpers beside it.
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

validate_tracked_layout || exit 2
ensure_mirror_dirs || exit 2
retire_hook_members
ensure_chain commit-msg
install_commit_msg
install_commit_notes
install_stale_worktree
install_deploy_step
install_kitlib_reversal
install_commit_gate
ensure_chain pre-push
install_on_main
install_commit_msg_vlevel
install_pushed_vlevel
install_manifest_group affected_gate
[ "$PUSHED_BEADS" = 0 ] || install_pre_push
ensure_chain reference-transaction
install_ref_txn
ensure_chain post-commit
install_bead_record
ensure_chain pre-commit
install_managed_dispatchers || rollback "cannot install the managed-mirror dispatchers in $TARGET"
sweep_untracked_shadow_copies
collect_tracked_migration
install_kitlib_tmp
install_gate_event
install_staged_imports
install_staged_fragments
install_staged_regexploit
install_staged_pysafe
install_staged_tempsafe
install_staged_kitlib
install_manifest_group staged_runtime
install_staged_br_init
install_staged_portable_paths
install_staged_wallclock
install_staged_readme
install_staged_embed
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
	if [ "$PUSHED_BEADS" = 1 ] && ! printf 'refs/heads/main %s refs/heads/main %s\n' "$HEAD_SHA" "$HEAD_SHA" | (CDPATH='' cd -- "$TARGET" && sh "$(chain_dir pre-push)/40-omp-kit-pushed-beads") >/dev/null 2>&1; then
		rollback "pre-push member rejects the current range in $TARGET"
	fi
	GUARD="$(chain_dir reference-transaction)/40-omp-kit-ref-txn-bead"
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
	ONMAIN="$(chain_dir pre-push)/30-omp-kit-on-main"
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
	if ! (CDPATH='' cd -- "$TARGET" && sh "$(chain_dir pre-commit)/40-omp-kit-native-preserve"); then
		rollback "native-preservation member refused the actual candidate in $TARGET"
	fi
fi
# ensure_chain may have moved a git-template commit-msg hook into the 10- slot (Leg 1 above proved it
# still behaves); when its bytes are the retired stamp pin (HOOKDEDUP1), retire it now so a fresh
# install passes its own --check. Member 41 enforces the same rule with the same text.
retire_hook_members
write_exclude_block || rollback "cannot list the installer-owned hook members in $TARGET's info/exclude"
print_tracked_migration
# shellcheck disable=SC2086
for path in $UNDO_RESTORE; do rm -f -- "$(dirname -- "$path")/.undo.$$.$(basename -- "$path")" "$(dirname -- "$path")/.undo.$$.$(basename -- "$path").mode"; done
printf 'verified active in %s\n' "$TARGET"
