#!/bin/sh
# CULPRIT1 (ompkit-6xxhu): when the release full suite on a published head is FAIL, release-verdict.sh
# names the commit that broke it (bisecting the failing test files over the first-parent commits since
# the last main-role PASS), records it as the verdict's validated `culprit` object, adds one REWORK
# comment to the culprit's bead, and proposes (never runs) a forward revert when the next judged head
# is red with the same culprit. A head whose failing file passes on rerun is a flake: nobody is blamed.
# --algorithm-only runs the boundary controls without exports, suites, git, or tracker writes.
{
	PYTHONDONTWRITEBYTECODE=1 python3 - "${2:-$(dirname -- "$0")/../../scripts}" <<'PY'
import importlib.util
from pathlib import Path
import sys

scripts = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location("culprit", scripts / "verdict-culprit.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.git = lambda _repo, _verb, ref: ref.split("^")[0]
module.commit_identity = lambda _repo, _sha: ("agent@example.invalid", "ompkit-test")
path = "tests/cli/example.test.sh"
files = [(path, "sh")]

class Store:
    def records(self, tree):
        return [(None, None, {"verdict": "PASS"})] if tree == "good" else []

class Probe:
    def __init__(self, mode):
        self.mode = mode
        self.calls = []
        self.counts = {}

    def failing(self, sha, _files, *, stop_at_first):
        self.calls.append(sha)
        self.counts[sha] = self.counts.get(sha, 0) + 1
        failed = sha != "good"
        if sha == "bad" and self.mode == "alternating":
            failed = self.counts[sha] % 2 == 1
        if sha == "good" and self.mode == "predecessor-flips":
            failed = self.counts[sha] > 1
        return [path] if failed else []

for mode in ("deterministic", "alternating", "predecessor-flips"):
    probe = Probe(mode)
    result = module.attribute(Path("."), ["head", "bad", "good"], Store(), files, probe)
    if mode == "deterministic":
        assert result["sha"] == "bad" and result["method"] == "bisect", ("boundary-deterministic must name bad", result)
        assert probe.calls == ["head", "bad", "bad", "good", "bad", "good"], probe.calls
    else:
        assert result["sha"] is None and result["method"] == "unattributed", result
        assert result["reason"].startswith("unstable boundary:"), result
        assert len(probe.calls) <= 6, probe.calls
    print("PASS boundary-" + mode)
PY
	algorithm_rc=$?
	[ "$algorithm_rc" = 0 ] || exit "$algorithm_rc"
}
if [ "${1:-}" = --algorithm-only ]; then
	exit 0
fi
# Real full-suite runs on a throwaway repo produce every verdict; br is a fake that logs its calls.
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
mkdir -p "$KITREPO/var/agent-tmp" || exit 1
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT="$KITREPO/var/agent-tmp" kitlib_tmp TMP verdict-culprit-test || exit 1
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

store="$TMP/verdicts"
tracker="$TMP/tracker"
br_log="$TMP/br.log"
mkdir -p "$store" "$tracker" "$TMP/bin"
: >"$br_log"
cat >"$TMP/bin/br" <<EOF
#!/bin/sh
printf 'cwd=%s args=%s\n' "\$(pwd -P)" "\$*" >>"$br_log"
EOF
chmod +x "$TMP/bin/br"
export BR_BIN="$TMP/bin/br" OMP_KIT_CULPRIT_TRACKER="$tracker" FULL_SUITE_VERDICT_CACHE_DIR="$store" \
	FULL_SUITE_TIMEOUT_SECS=300 FULL_SUITE_SHELL_JOBS=1 TMPDIR="$TMP"

# seed DIR: a repository carrying the verdict machinery, as the published commits do.
seed() {
	mkdir -p "$1/scripts" "$1/tests/cli" "$1/.github"
	git -C "$1" init -q --template= -b main
	git -C "$1" config user.email t@example.invalid
	git -C "$1" config user.name t
	judging_files=$(PYTHONPATH="$KITREPO/scripts" python3 -m suite-metrics judging-files) || return 1
	for path in $judging_files scripts/kitlib_io.py scripts/kitlib_jsonl.py \
		scripts/kitlib_lock.py scripts/release-verdict.sh scripts/verdict-culprit.py; do
		mkdir -p "$1/$(dirname "$path")" || return 1
		cp "$KITREPO/$path" "$1/$path" || exit 1
	done
	cat >"$1/scripts/fresh-gate.sh" <<'EOF'
#!/bin/sh
case "${1:-}" in --test-workers) printf "1\n" ;; *) exit 0 ;; esac
EOF
	printf '%s\n' "$(bun --version)" >"$1/.bun-version"
}
# change REPO EMAIL BEAD MESSAGE FILE CONTENT: one commit by EMAIL; prints its sha.
change() {
	mkdir -p "$(dirname -- "$1/$5")"
	printf '%s\n' "$6" >"$1/$5"
	git -C "$1" add -A
	git -C "$1" -c user.name="Agent ${2%@*}" -c user.email="$2" commit -q --no-verify -m "$4" -m "Bead: $3"
	git -C "$1" rev-parse HEAD
}
verdict() { (cd "$1" && sh scripts/release-verdict.sh --commit "$2" --no-fetch) </dev/null 2>&1; }
record() { # REPO SHA -> the newest main-role record for that commit's tree
	for r in "$store/$(git -C "$1" rev-parse "$2^{tree}")".main.*.json; do
		case "$r" in *.superseded-*) ;; *) printf '%s\n' "$r" ;; esac
	done | tail -n 1
}
culprit_field() { python3 -c 'import json,sys; c=json.load(open(sys.argv[1])).get("culprit"); print(json.dumps(c[sys.argv[2]]) if c else "absent")' "$1" "$2"; }

# History: answer.test.sh is green while lib/answer.txt says 42. a1 broke it long ago and c0 fixed it
# (c0 has the last main-role PASS); c2 breaks it again; c1, c3 and c4 touch notes only.
repo="$TMP/repo"
seed "$repo"
cat >"$repo/tests/cli/answer.test.sh" <<'EOF'
#!/bin/sh
[ "$(cat lib/answer.txt)" = 42 ] || { echo "answer is $(cat lib/answer.txt)"; exit 1; }
EOF
r0=$(change "$repo" root@example.invalid ompkit-root "[test] root" lib/answer.txt 42)
a1=$(change "$repo" early@example.invalid ompkit-early "[test] early break" lib/answer.txt 41)
change "$repo" early@example.invalid ompkit-early "[test] a2" notes/a2.txt a2 >/dev/null
change "$repo" early@example.invalid ompkit-early "[test] a3" notes/a3.txt a3 >/dev/null
c0=$(change "$repo" fixer@example.invalid ompkit-fix "[test] fix" lib/answer.txt 42)
c1=$(change "$repo" good@example.invalid ompkit-good "[test] c1" notes/c1.txt c1)
# c2's Bead: line sits above a Supersedes: block, as 238de69864's did: git reads trailers only from the last
# paragraph, so the culprit's bead must still be found (it was named 'none' live on 2026-11-01).
change "$repo" breaker@example.invalid ompkit-brk "[test] the break" lib/answer.txt 43 >/dev/null
git -C "$repo" -c user.name="Agent breaker" -c user.email=breaker@example.invalid commit -q --amend --no-verify \
	-m "[test] the break" -m "Bead: ompkit-brk" -m "Supersedes: $r0"
c2=$(git -C "$repo" rev-parse HEAD)
c3=$(change "$repo" later@example.invalid ompkit-later "[test] c3" notes/c3.txt c3)
c4=$(change "$repo" later@example.invalid ompkit-later "[test] c4" notes/c4.txt c4)
if [ "$(git -C "$repo" rev-list --count HEAD)" = 9 ] && [ -n "$r0" ] && [ -n "$c1" ]; then st=0; else st=1; fi
ok "$st" "fixture: nine first-parent commits"

# 1. The last PASS: c0 is green and attributes nothing.
out=$(verdict "$repo" "$c0"); rc=$?
[ "$rc" = 0 ] && printf '%s\n' "$out" | grep -q 'FULL-SUITE: VERDICT PASS' && ! printf '%s\n' "$out" | grep -q 'CULPRIT'
ok $? "pass-baseline: rc=$rc out=$out"

# 2. c3 is red: the planted break c2 is named with its author and bead; the FAIL status is kept.
out=$(verdict "$repo" "$c3"); rc=$?
[ "$rc" != 0 ] && printf '%s\n' "$out" | grep -q 'FULL-SUITE: VERDICT FAIL'
ok $? "red-head-keeps-fail: rc=$rc"
printf '%s\n' "$out" | grep -qx "release-verdict: CULPRIT $c2 breaker@example.invalid ompkit-brk"
ok $? "culprit-named: want $c2 out=$out"
! printf '%s\n' "$out" | grep -q 'PROPOSE'
ok $? "no-proposal-on-first-red: out=$out"
rec3=$(record "$repo" "$c3")
if [ "$(culprit_field "$rec3" sha)" = "\"$c2\"" ] && [ "$(culprit_field "$rec3" author)" = '"breaker@example.invalid"' ] \
	&& [ "$(culprit_field "$rec3" bead)" = '"ompkit-brk"' ] && [ "$(culprit_field "$rec3" method)" = '"bisect"' ] \
	&& [ "$(culprit_field "$rec3" failing_files)" = '["tests/cli/answer.test.sh"]' ]; then st=0; else st=1; fi
ok "$st" "culprit-in-verdict-json: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("culprit"))' "$rec3")"
# The store still validates the attributed record.
listing=$(cd "$KITREPO" && python3 -B scripts/full-suite-verdict-store.py list --repo "$repo" --judge-root "$repo")
python3 -c 'import json,sys; rows=json.loads(sys.argv[2])["records"]; name=sys.argv[1]; sys.exit(0 if [r["integrity"] for r in rows if r["record"]==name]==["VALID"] else 1)' "${rec3##*/}" "$listing"
ok $? "store-validates-culprit: $listing"
[ "$(wc -l <"$br_log" | tr -d ' ')" = 1 ] && grep -q "^cwd=$(cd "$tracker" && pwd -P) args=comments add ompkit-brk REWORK" "$br_log" \
	&& grep -q 'tests/cli/answer.test.sh' "$br_log"
ok $? "one-rework-comment: $(cat "$br_log")"

# 3. Judging c3 again reuses its FAIL and its recorded culprit; the bead is not commented twice.
out=$(verdict "$repo" "$c3"); rc=$?
[ "$rc" != 0 ] && printf '%s\n' "$out" | grep -qx "release-verdict: CULPRIT $c2 breaker@example.invalid ompkit-brk" \
	&& [ "$(wc -l <"$br_log" | tr -d ' ')" = 1 ]
ok $? "rejudge-idempotent: rc=$rc out=$out br=$(cat "$br_log")"

# 4. c4 is still red with the same culprit: the forward revert is proposed, never run, and the bead
# gets no second comment.
out=$(verdict "$repo" "$c4"); rc=$?
[ "$rc" != 0 ] && printf '%s\n' "$out" | grep -qx "release-verdict: CULPRIT $c2 breaker@example.invalid ompkit-brk" \
	&& printf '%s\n' "$out" | grep -qxF "release-verdict: PROPOSE: git revert --no-edit $c2  # forward revert; not run"
ok $? "proposal-on-second-red: rc=$rc out=$out"
if [ "$(git -C "$repo" rev-parse HEAD)" = "$c4" ] && [ -z "$(git -C "$repo" status --porcelain)" ] \
	&& [ "$(cat "$repo/lib/answer.txt")" = 43 ] && [ "$(wc -l <"$br_log" | tr -d ' ')" = 1 ]; then st=0; else st=1; fi
ok "$st" "proposal-not-executed: head=$(git -C "$repo" rev-parse HEAD) br=$(cat "$br_log")"

# 5. Mutants against the same red verdict (--dry-run: no record, no comment). The unmutated copy is
# the control; a bisect that ignores the last PASS or keeps the wrong half must not name c2.
tool() { # DIR SED-EXPR: a copy of the scripts the tool needs, optionally mutated
	mkdir -p "$1/scripts"
	for f in verdict-culprit.py full-suite-verdict-store.py suite-metrics.py kitlib_run.py kitlib_tmp.py kitlib_io.py pysafe.py; do
		cp "$KITREPO/scripts/$f" "$1/scripts/$f"
	done
	[ -z "$2" ] || { sed "$2" "$KITREPO/scripts/verdict-culprit.py" >"$1/scripts/verdict-culprit.py"; ! cmp -s "$KITREPO/scripts/verdict-culprit.py" "$1/scripts/verdict-culprit.py"; }
}
dry() { (cd "$1" && python3 -B scripts/verdict-culprit.py --repo "$repo" --commit "$c3" --dry-run) </dev/null 2>/dev/null; }
tool "$TMP/control" ""
out=$(dry "$TMP/control"); rc=$?
if [ "$rc" = 0 ] && [ "$out" = "CULPRIT $c2 breaker@example.invalid ompkit-brk" ]; then st=0; else st=1; fi
ok "$st" "control-dry-run: rc=$rc out=$out"
tool "$TMP/ignore-pass" 's/window = chain\[:good\] if good is not None else chain\[:MAX_COMMITS\]/window = chain[:MAX_COMMITS]/'
ok $? "mutant-ignore-pass-applied"
# Ignoring the last PASS bisects all eight commits and lands on the old, already fixed break a1.
out=$(dry "$TMP/ignore-pass")
if [ "$out" = "CULPRIT $a1 early@example.invalid ompkit-early" ]; then st=0; else st=1; fi
ok "$st" "mutant-ignore-pass-caught: want the wrong $a1, got $out"
tool "$TMP/wrong-side" 's/if bad else/if not bad else/'
ok $? "mutant-wrong-side-applied"
# A wrong-side search can now be refused as unstable instead of falsely naming the head.
# That still breaks deterministic attribution: run the SAME acceptance against both copies.
out=$(sh "$KITREPO/tests/cli/verdict-culprit.test.sh" --algorithm-only "$TMP/control/scripts" 2>&1); rc=$?
if [ "$rc" = 0 ] && printf '%s\n' "$out" | grep -q '^PASS boundary-deterministic$'; then st=0; else st=1; fi
ok "$st" "boundary-deterministic-unmutated: rc=$rc out=$out"
out=$(sh "$KITREPO/tests/cli/verdict-culprit.test.sh" --algorithm-only "$TMP/wrong-side/scripts" 2>&1); rc=$?
if [ "$rc" != 0 ] && printf '%s\n' "$out" | grep -q 'AssertionError:.*boundary-deterministic must name bad'; then st=0; else st=1; fi
ok "$st" "mutant-wrong-side-caught: deterministic acceptance must fail, rc=$rc out=$out"
if [ "$(wc -l <"$br_log" | tr -d ' ')" = 1 ] && [ "$(culprit_field "$rec3" sha)" = "\"$c2\"" ]; then st=0; else st=1; fi
ok "$st" "dry-runs-write-nothing: br=$(cat "$br_log")"

# 6. Flake control: the file fails in the judged full-suite run and passes when the culprit step reruns it
# in its own export (a culprit-<sha> dir), so no commit is blamed and no bead is commented. Keyed on the
# rerun dir, not on "full-suite-verdict": when this test itself runs inside the release full suite, every
# path under it contains that name, and the flake would fail on rerun too.
flake="$TMP/flake"
seed "$flake"
cat >"$flake/tests/cli/flaky.test.sh" <<'EOF'
#!/bin/sh
case "$(pwd -P)" in */culprit-[0-9a-f]*) exit 0 ;; esac
echo "flaked"
exit 1
EOF
f0=$(change "$flake" flaky@example.invalid ompkit-flaky "[test] flaky" notes/f0.txt f0)
out=$(verdict "$flake" "$f0"); rc=$?
[ "$rc" != 0 ] && printf '%s\n' "$out" | grep -qx 'release-verdict: CULPRIT none (flake: passes on rerun at head)' \
	&& [ "$(culprit_field "$(record "$flake" "$f0")" method)" = '"flake-rerun"' ] && [ "$(wc -l <"$br_log" | tr -d ' ')" = 1 ]
ok $? "flake-no-culprit: rc=$rc out=$out br=$(cat "$br_log")"

printf 'verdict-culprit: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
