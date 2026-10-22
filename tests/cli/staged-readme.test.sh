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
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP staged-readme-test || exit 1

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && printf '%s' "$4" | grep -q -- "$5"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

# S1 stub gate: delegates to the real readme-update gate when installed,
# otherwise enforces the same S1-bytes bound (CORPUS_P75_BYTES, unchanged by
# this bead) so the size leg runs hermetically in CI too.
write_gate_stub() {
	cat > "$1/gate-stub.py" <<'PY'
import os, subprocess, sys
args = sys.argv[1:]
target = args[-1]
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

new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir/rules" "$dir/skills/s1" "$dir/skills/s2" "$dir/src"
	write_base_readme "$dir"
	write_gate_stub "$dir"
	printf '{"name":"fixture","version":"0.0.1","omp":{"extensions":["e1","e2"]}}\n' > "$dir/package.json"
	printf 'export const COMMANDS = [{ name: "alpha" }, { name: "doctor", flags: [{ name: "--scope", value: "red|blue" }] }];\n' > "$dir/src/commands.ts"
	printf '# rule a\n' > "$dir/rules/a.md"
	printf '# rule b\n' > "$dir/rules/b.md"
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
	printf '%s' "$dir"
}

commit() {
	repo=$1
	shift
	(CDPATH='' cd -- "$repo" && README_GATE="$repo/gate-stub.py" git commit -q "$@" 2>&1)
}

# (a) new skill without the README count change: refused, naming the count.
R=$(new_repo skill-count)
mkdir "$R/skills/s3"
printf '# skill three\n' > "$R/skills/s3/SKILL.md"
git -C "$R" add skills/s3/SKILL.md
out=$(commit "$R" -m "[test] third skill, stale readme")
check "$?" "1" "skill-without-count-refused" "$out" 'claims "Two skills" but the tree ships 3 skills'
check "$(git -C "$R" rev-list --count HEAD)" "1" "skill-refused-head-unmoved" "$out" "staged-readme: REFUSED"

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

printf 'staged-readme: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
