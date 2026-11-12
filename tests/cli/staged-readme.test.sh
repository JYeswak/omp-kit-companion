#!/bin/sh
# staged-readme.test.sh — READMESIZE1 commit-time README gate contract
# (ompkit-readme-changelog-currency-vrrn.1). The member is installed by the
# installer into fixture repos and judged through real `git commit` runs on
# the candidate INDEX tree (git write-tree, then archive; never the worktree):
# (a) staging skills/<x>/SKILL.md without the README count change is refused,
#     while the same commit with the count fixed passes; (b) staging a README
#     padded past the p75 fails S1-bytes, while the unpadded README passes;
# (c) an uncommitted oversized README in the worktree does not affect a commit
#     staging only an unrelated path, and the push-time archive check of that
#     tip stays GREEN.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP staged-readme-test || exit 1
HOOK_TMP_ROOT="$TMP/readme-hook-tmp"
mkdir -p "$HOOK_TMP_ROOT"
KITLIB_TMP_ROOT=$HOOK_TMP_ROOT
export KITLIB_TMP_ROOT

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && printf '%s' "$4" | grep -q -- "$5"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

readme_temp_gone() {
	[ -f "$1/readme-temp-path" ] || return 1
	readme_temp=$(cat "$1/readme-temp-path")
	case "$readme_temp" in "$HOOK_TMP_ROOT"/staged-readme.*) ;; *) return 1 ;; esac
	[ ! -e "$readme_temp" ]
}

check_readme_cleanup() {
	if readme_temp_gone "$1"; then pass=$((pass + 1))
	else fail=$((fail + 1)); printf 'FAIL %s: actual staged README temp survived or was not captured\n' "$2"
	fi
}

# S1 stub gate: delegates to the real readme-update gate when installed,
# otherwise enforces the same S1-bytes bound (CORPUS_P75_BYTES, unchanged by
# this bead) so the size leg runs hermetically in CI too.
write_gate_stub() {
	cat > "$1/gate-stub.py" <<'PY'
import os, subprocess, sys
args = sys.argv[1:]
target = args[-1]
if os.environ.get("README_CAPTURE"):
    with open(os.environ["README_CAPTURE"], "w", encoding="utf-8") as handle:
        handle.write(os.path.dirname(target))
if os.environ.get("README_SIGNAL_PID"):
    import signal
    if not os.path.isfile(os.path.join(os.path.dirname(target), ".owner")):
        raise AssertionError("gate did not receive its actual owned INDEX directory")
    os.kill(int(os.environ["README_SIGNAL_PID"]), signal.SIGTERM)
real = os.environ.get("README_GATE_REAL",
                      os.path.expanduser("~/.claude/skills/readme-update/scripts/readme-gate.py"))
if os.path.exists(real):
    r = subprocess.run(["python3", real] + args)
    sys.exit(r.returncode)
size = os.path.getsize(target)
if size > 54872:
    print("FAIL S1-bytes             %s: %d bytes exceeds corpus p75 54872" % (target, size))
    sys.exit(1)
print("S1-size %d bytes under p75 (fallback gate)" % size)
sys.exit(0)
PY
}

write_base_readme() {
	cat > "$1/README.md" <<'MD'
# Fixture kit

<!-- kit-release:start -->
Current release: v0.0.1
<!-- kit-release:end -->

Two skills, two rules, two extensions, two commands and two scopes.

## Command reference

| command | usage |
| `omp-kit alpha` | `alpha` |
| `omp-kit doctor` | `doctor [--scope NAME]` |

`omp-kit doctor --scope red` checks red.
`omp-kit doctor --scope blue` checks blue.

## Limitations

Small on purpose.

## About Contributions

Nobody.

## License

MIT.
MD
}

install_baseline() {
	dir="$TMP/installed-baseline"
	mkdir -p "$dir/rules" "$dir/skills/s1" "$dir/skills/s2" "$dir/src" "$dir/docs" "$dir/tests/live"
	write_base_readme "$dir"
	write_gate_stub "$dir"
	printf '{"name":"fixture","version":"0.0.1","omp":{"extensions":["e1","e2"]}}\n' > "$dir/package.json"
	printf 'export const COMMANDS = [{ name: "alpha" }, { name: "doctor", flags: [{ name: "--scope", value: "red|blue" }] }];\n' > "$dir/src/commands.ts"
	printf '# rule a\n' > "$dir/rules/a.md"
	printf '# rule b\n' > "$dir/rules/b.md"
	printf '# Agents\n\nlive suite (G4, 2 scenarios including a planted negative).\n' > "$dir/AGENTS.md"
	# shellcheck disable=SC2016 # literal $KIT: fixture doc text, not an expansion
	printf '# Usage\n\n`"$KIT" apply rules --plan --json` previews the 2-rule install.\n' > "$dir/docs/usage.md"
	printf '[{"id":"a"},{"id":"b"}]\n' > "$dir/tests/live/scenarios.json"
	printf 'name\tsha256\tclass\tpack\na\t0\ttripwire\tpack\nb\t1\treminder\tpack\n' > "$dir/MANIFEST.tsv"
	printf '# skill one\n' > "$dir/skills/s1/SKILL.md"
	printf '# skill two\n' > "$dir/skills/s2/SKILL.md"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* "$dir/.git/hooks/pre-commit"
	git -C "$dir" add -A
	out=$(README_GATE="$dir/gate-stub.py" git -C "$dir" commit -q -m "[test] root" 2>&1) || { printf 'FAIL base commit %s: %s\n' "$1" "$out" >&2; exit 1; }
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/pre-commit/46-omp-kit-staged-readme" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	[ -f "$dir/.git/hooks/hooks.d/pre-commit/readme-check.ts" ] || { printf 'FAIL install %s: checker absent\n' "$1" >&2; exit 1; }
	# Keep the real staged README member, its non-numbered dependencies, and
	# its runner; unrelated installed gates are not part of this contract.
	for member in "$dir"/.git/hooks/hooks.d/*/[0-9]*; do
		case "$member" in */pre-commit/46-omp-kit-staged-readme) ;; *) rm -f "$member" ;; esac
	done
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/pre-push" "$dir/.git/hooks/reference-transaction"
	git -C "$dir" config maintenance.auto false
}

install_baseline installed-baseline
new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	cp -R "$TMP/installed-baseline/." "$dir/"
	printf '%s' "$dir"
}

commit() {
	repo=$1
	shift
	(CDPATH='' cd -- "$repo" && README_GATE="$repo/gate-stub.py" README_CAPTURE="$repo/readme-temp-path" git commit -q "$@" 2>&1)
}

# (a) new skill without the README count change: refused, naming the count.
R=$(new_repo skill-count)
mkdir "$R/skills/s3"
printf '# skill three\n' > "$R/skills/s3/SKILL.md"
git -C "$R" add skills/s3/SKILL.md
out=$(commit "$R" -m "[test] third skill, stale readme")
check "$?" "1" "skill-without-count-refused" "$out" 'claims "Two skills" but the tree ships 3 skills'
check "$(git -C "$R" rev-list --count HEAD)" "1" "skill-refused-head-unmoved" "$out" "staged-readme: REFUSED"
check_readme_cleanup "$R" "refused-index-cleanup"

# (a) control: the same commit with the count fixed passes.
python3 - "$R/README.md" <<'PY' || exit 1
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
p.write_text(text.replace("Two skills, two rules", "Three skills, two rules"))
PY
git -C "$R" add README.md
out=$(commit "$R" -m "[test] third skill with count")
check "$?" "0" "skill-with-count-pass" "$out x" "x"
check_readme_cleanup "$R" "passing-index-cleanup"

# (b) control: README just under the p75 passes.
R=$(new_repo size-bound)
python3 - "$R/README.md" <<'PY' || exit 1
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
need = 54872 - 12 - len(text.encode())
line = "lorem ipsum filler row\n"
rows = need // len(line)
p.write_text(text + line * rows)
PY
git -C "$R" add README.md
out=$(commit "$R" -m "[test] readme just under p75")
check "$?" "0" "under-p75-pass" "$out x" "x"

# (b) negative: the same README padded past the p75 fails S1-bytes.
python3 - "$R/README.md" <<'PY' || exit 1
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
need = 54872 + 1 - len(text.encode())
p.write_text(text + "x" * need + "\n")
PY
git -C "$R" add README.md
out=$(commit "$R" -m "[test] readme over p75")
check "$?" "1" "over-p75-refused" "$out" "S1-bytes"
check "$(git -C "$R" rev-list --count HEAD)" "2" "over-p75-head-unmoved" "$out" "staged-readme: REFUSED"

# (c) an uncommitted oversized README never affects an unrelated commit:
# the worktree README is oversized but unstaged, only notes.txt is staged.
R=$(new_repo worktree-oversize)
python3 - "$R/README.md" <<'PY' || exit 1
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text() + "x" * 60000 + "\n")
PY
printf 'unrelated\n' > "$R/notes.txt"
git -C "$R" add notes.txt
out=$(commit "$R" -m "[test] unrelated path only")
check "$?" "0" "worktree-oversize-unrelated-pass" "$out x" "x"

# (c) push side: the tip archive (what the pre-push gate judges) is GREEN,
# because no staged commit touched README.
TIP="$TMP/tip-check"
mkdir -p "$TIP"
git -C "$R" archive HEAD | tar -xf - -C "$TIP"
out=$(CDPATH='' cd -- "$R" && README_GATE="$R/gate-stub.py" bun run --no-env-file --config=/dev/null .git/hooks/hooks.d/pre-commit/readme-check.ts --root "$TIP" 2>&1)
check "$?" "0" "untouched-tip-archive-green" "$out" "README-CHECK: GREEN"

# Signal the recorded owned hook PID only after its real INDEX gate is running.
R=$(new_repo signal-cleanup)
printf '\n' >> "$R/README.md"
git -C "$R" add README.md
out=$(python3 - "$R" "$(dirname "$INSTALLER")" <<'PY'
import os, signal, sys
from pathlib import Path
repo = Path(sys.argv[1])
sys.path.insert(0, sys.argv[2])
import kitlib_run
# Python starts with SIGPIPE ignored; qualify an ordinary shell before testing its traps.
preamble = "import os,signal,sys; [signal.signal(s,signal.SIG_DFL) for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP,signal.SIGPIPE)]; os.execvp(sys.argv[1],sys.argv[1:])"
result = kitlib_run.run(
    [sys.executable, "-c", preamble, "/bin/sh", "-c",
     'export README_SIGNAL_PID=$$; exec "$@"', "sh",
     str(repo / ".git/hooks/hooks.d/pre-commit/46-omp-kit-staged-readme")],
    cwd=str(repo), deadline_s=20, grace_s=2, stdin=b"",
    env={**os.environ, "README_GATE": str(repo / "gate-stub.py"),
         "README_CAPTURE": str(repo / "readme-temp-path")})
if result.timed_out or result.rc != -signal.SIGTERM:
    raise AssertionError("staged README cancellation was not SIGTERM: %r" % (result,))
temp = Path((repo / "readme-temp-path").read_text())
if temp.exists():
    raise AssertionError("SIGTERM left actual owned INDEX directory: %s" % temp)
print("actual-index-signal-cleanup")
PY
)
check "$?" "0" "actual-index-signal-cleanup" "$out" "actual-index-signal-cleanup"

# Disable only the existing native registration for one real valid INDEX invocation.
# The same exact-path cleanup assertion must notice the resulting owned directory.
R=$(new_repo missing-cleanup)
printf '\n' >> "$R/README.md"
git -C "$R" add README.md
out=$(CDPATH='' cd -- "$R" && KITLIB_TMP_AUTO_CLEANUP=0 README_GATE="$R/gate-stub.py" README_CAPTURE="$R/readme-temp-path" git commit -q -m "[test] missing native cleanup" 2>&1)
check "$?" "0" "missing-cleanup-valid-readme-control" "$out x" "x"
if readme_temp_gone "$R"; then
	fail=$((fail + 1)); printf 'FAIL missing-cleanup-negative: leftover assertion did not fire\n'
else
	readme_temp=$(cat "$R/readme-temp-path")
	if [ -d "$readme_temp" ] && [ -f "$readme_temp/.owner" ]; then pass=$((pass + 1))
	else fail=$((fail + 1)); printf 'FAIL missing-cleanup-negative: expected exact owned leftover\n'
	fi
fi

# Foreign repos with skills but no declared README obligation still commit.
R="$TMP/no-readme"
mkdir -p "$R/skills/example"
git -C "$R" init -q
git -C "$R" config user.email test@invalid.example
git -C "$R" config user.name Test
git -C "$R" commit -q --allow-empty -m "[test] root"
cp -R "$TMP/installed-baseline/.git/hooks/." "$R/.git/hooks/"
printf '# Example\n' > "$R/skills/example/SKILL.md"
git -C "$R" add skills/example/SKILL.md
out=$(commit "$R" -m "[test] skill without README obligation")
check "$?" "0" "foreign-no-readme-commit" "$out x" "x"

# HEAD's README obligation survives its staged deletion.
R=$(new_repo deleted-readme)
git -C "$R" rm -q README.md
out=$(commit "$R" -m "[test] required README deleted")
check "$?" "1" "required-readme-deletion-refused" "$out" "staged-readme: REFUSED"

# README APPLY1 (ompkit-v66l.22.3): CFS tracks a README, so it has a README
# obligation, but it ships no COMMANDS registry, release train, kit inventory
# or its own checker. The installed checker imported <tree>/src/commands.ts
# unconditionally and crashed (`Cannot find module`), refusing every CFS
# commit that staged README.md or package.json.
write_cfs_readme() {
	cat > "$1/README.md" <<'MD'
# ClutterFreeSpaces Business Intelligence Platform

## 🎯 **Project Overview**

Montana's professional organizing service, with 7 commands for the daily dashboard.

## 🛠️ **Command Reference**

| Command | Purpose | Example |
|---------|---------|---------|
| `/checkin` | Daily business dashboard | `./checkin.sh` |

## 📜 **License**

Private.
MD
}
cfs_repo() {
	R="$TMP/$1"
	mkdir -p "$R"
	git -C "$R" init -q
	git -C "$R" config user.email test@invalid.example
	git -C "$R" config user.name Test
	git -C "$R" commit -q --allow-empty -m "[test] root"
	cp -R "$TMP/installed-baseline/.git/hooks/." "$R/.git/hooks/"
	cp "$TMP/installed-baseline/gate-stub.py" "$R/gate-stub.py"
	write_cfs_readme "$R"
	printf '{"name":"clutterfree-spaces-api","version":"1.0.0"}\n' > "$R/package.json"
	printf '%s' "$R"
}

# Planted: the CFS-shaped commit passes, and rule 1 is named NOT_APPLICABLE.
R=$(cfs_repo cfs-shaped)
git -C "$R" add README.md package.json
out=$(commit "$R" -m "[test] CFS README and package.json")
check "$?" "0" "cfs-shaped-commit" "$out" "staged-readme: NOT_APPLICABLE command-reference: no COMMANDS registry"
check "$(git -C "$R" rev-list --count HEAD)" "2" "cfs-shaped-head-moved" "$out" "NOT_APPLICABLE kit-sections"

# Planted negative: a rule that applies to every README still refuses there.
R=$(cfs_repo cfs-worklog)
printf "## What's new\n\n- Added the dashboard.\n" >> "$R/README.md"
git -C "$R" add README.md package.json
out=$(commit "$R" -m "[test] CFS README with a worklog heading")
check "$?" "1" "cfs-worklog-refused" "$out" "worklog/changelog heading"

# Planted negative: an omp-kit-shaped README missing a registry command is still refused.
R=$(new_repo kit-missing-command)
grep -v 'omp-kit alpha' "$R/README.md" > "$R/README.next" && mv "$R/README.next" "$R/README.md"
git -C "$R" add README.md
out=$(commit "$R" -m "[test] README drops a command")
check "$?" "1" "kit-missing-command-refused" "$out" "command reference is missing \`omp-kit alpha\`"

# Planted negative: a tree that ships its own checker declares the whole kit policy,
# so the kit sections stay required there.
R=$(new_repo kit-policy-sections)
mkdir -p "$R/scripts"
cp "$(dirname "$INSTALLER")/readme-check.ts" "$R/scripts/readme-check.ts"
grep -v -e '^## Limitations$' -e '^Small on purpose\.$' "$R/README.md" > "$R/README.next" && mv "$R/README.next" "$R/README.md"
git -C "$R" add README.md scripts/readme-check.ts
out=$(commit "$R" -m "[test] kit README drops Limitations")
check "$?" "1" "kit-policy-sections-refused" "$out" "no \`## Limitations\` section"

printf 'staged-readme: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
