#!/bin/sh
# check-staged-br-init.test.sh — BRINITPIN1 staged and range ratchet contract.
# An unpinned br init and a caller-inheriting fixture br call are refused in staged
# and pushed ranges; local database bindings pass, unchanged legacy findings do not block.
set -u
SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
# shellcheck source=scripts/kitlib-tmp.sh
. "$SCRIPTS/kitlib-tmp.sh"
kitlib_tmp TMP br-init-ratchet-test || exit 1

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && { [ -z "$5" ] || printf '%s' "$4" | grep -Fq -- "$5"; }; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* "$dir/.git/hooks/pre-commit"
	printf 'const seed = true;\n' > "$dir/seed.ts"
	git -C "$dir" add seed.ts
	git -C "$dir" commit -q -m "[test] seed"
	printf '%s' "$dir"
}

range_check() {
	repo=$1
	base=$2
	head=$3
	python3 -B "$SCRIPTS/pysafe.py" run --timeout 60 -- python3 -B "$SCRIPTS/br_init_check.py" --repo "$repo" --base "$base" --head "$head"
}

# Staged index: the unsafe form is named and refused; a fixture-local --db is admitted.
R=$(new_repo staged)
printf 'run(["br", "init"]);\n' > "$R/bad.ts"
git -C "$R" add bad.ts
out=$(CDPATH='' cd -- "$R" && sh "$SCRIPTS/check-staged-br-init.sh" 2>&1)
rc=$?
check "$rc" "1" "staged-unpinned-refused" "$out" "bad.ts:1:"
check "$rc" "1" "staged-unpinned-rule-named" "$out" "unpinned-br-init"
git -C "$R" reset -q -- bad.ts
printf 'run(["br", "init", "--db", join(dir, ".beads", "beads.db")]);\n' > "$R/pinned.ts"
git -C "$R" add pinned.ts
out=$(CDPATH='' cd -- "$R" && sh "$SCRIPTS/check-staged-br-init.sh" 2>&1)
rc=$?
check "$rc" "0" "staged-pinned-admitted" "$out" ""
printf 'brun(["create", "probe"], dir);\n' > "$R/inherited.ts"
git -C "$R" add inherited.ts
out=$(CDPATH='' cd -- "$R" && sh "$SCRIPTS/check-staged-br-init.sh" 2>&1)
rc=$?
check "$rc" "1" "staged-inherited-call-refused" "$out" "inherited.ts:1:"
check "$rc" "1" "staged-inherited-call-rule-named" "$out" "inherited-br-call"
git -C "$R" reset -q -- inherited.ts
printf 'brun(["create", "probe"], dir, { BEADS_DB: join(dir, ".beads", "beads.db") });\n' > "$R/bound.ts"
git -C "$R" add bound.ts
out=$(CDPATH='' cd -- "$R" && sh "$SCRIPTS/check-staged-br-init.sh" 2>&1)
rc=$?
check "$rc" "0" "staged-bound-call-admitted" "$out" ""
git -C "$R" reset -q -- bound.ts

# BRREADBIND1: judge the selected DB at the read call, not a fixture-path spelling.
selected_case() {
	label=$1
	want=$2
	needle=$3
	selected=$(new_repo "selected-$label")
	before=$(git -C "$selected" rev-parse HEAD)
	cat > "$selected/reader.ts"
	git -C "$selected" add reader.ts
	out=$(CDPATH='' cd -- "$selected" && sh "$SCRIPTS/check-staged-br-init.sh" 2>&1)
	rc=$?
	check "$rc" "$want" "selected-$label-staged" "$out" "$needle"
	git -C "$selected" commit -q -m "[test] selected namespace specimen"
	after=$(git -C "$selected" rev-parse HEAD)
	out=$(range_check "$selected" "$before" "$after" 2>&1)
	rc=$?
	check "$rc" "$want" "selected-$label-range" "$out" "$needle"
}

selected_case production 0 "" <<'TS'
async function closeLesson(repo, env, bead) {
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	const result = await run(["br", "comments", "list", bead.id, "--json", ...db], { cwd: repo, deadline_s: 60, env });
	return result;
}
TS

selected_case renamed 0 "" <<'TS'
async function selectedRead(workspace, bindings, issue) {
	const trackerFlags = bindings.BEADS_DB ? ['--db', bindings.BEADS_DB] : [];
	return await run(["br", "show", issue.id, ...trackerFlags], { cwd: workspace, env: bindings });
}
TS

selected_case omitted 1 "inherited-br-call" <<'TS'
async function omittedFlags(repo, env, bead) {
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	return await run(["br", "comments", "list", bead.id], { cwd: repo, env });
}
TS

selected_case wrong-environment 1 "inherited-br-call" <<'TS'
async function wrongEnvironment(repo, env, other, bead) {
	const db = other.BEADS_DB ? ["--db", other.BEADS_DB] : [];
	return await run(["br", "comments", "list", bead.id, ...db], { cwd: repo, env });
}
TS

selected_case conflicting-flags 1 "inherited-br-call" <<'TS'
async function conflictingFlags(repo, env, bead, other) {
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	return await run(["br", "show", bead.id, "--db", other, ...db], { cwd: repo, env });
}
TS

selected_case indirect-mutation 1 "inherited-br-call" <<'TS'
async function indirectMutation(repo, env, bead) {
	function changeFlags() { db.pop(); }
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	changeFlags();
	return await run(["br", "show", bead.id, ...db], { cwd: repo, env });
}
TS

selected_case mutated 1 "inherited-br-call" <<'TS'
async function mutatedFlags(repo, env, bead) {
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	db.pop();
	return await run(["br", "comments", "list", bead.id, ...db], { cwd: repo, env });
}
TS

selected_case shadowed 1 "inherited-br-call" <<'TS'
async function shadowedFlags(repo, env, bead) {
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	{
		const db = [];
		await run(["br", "comments", "list", bead.id, ...db], { cwd: repo, env });
	}
}
TS

selected_case inherited-write 1 "inherited-br-call" <<'TS'
async function inheritedWrite(repo, env) {
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	await run(["br", "create", "probe", ...db], { cwd: repo, env });
}
TS

selected_case inherited-init 1 "unpinned-br-init" <<'TS'
async function inheritedInit(repo, env) {
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	await run(["br", "init", ...db], { cwd: repo, env });
}
TS

# Run the unsafe-source oracle against the real scanner, then neutralize its
# binding detector. The very same refusal assertions must now go RED.
python3 -B - "$SCRIPTS" > "$TMP/neutralized.out" <<'PY'
import sys
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
import br_init_check as checker


def require_refusal(source: bytes, rule: str) -> None:
    if rule not in checker._js_calls(source, "fixture.ts").hits.by_rule:
        raise AssertionError(f"unsafe source admitted: {rule}")


cases = [
    (b'run(["br", "init"]);', checker.RULE),
    (b'run(["br", "create", "probe"]);', checker.INHERITED_RULE),
]
for source, rule in cases:
    require_refusal(source, rule)
    with patch.object(checker, "_js_pinned", return_value=True):
        try:
            require_refusal(source, rule)
        except AssertionError:
            print(f"neutralized-negative RED {rule}")
        else:
            raise AssertionError("negative oracle survived detector neutralization")
PY
rc=$?
out=$(cat "$TMP/neutralized.out")
check "$rc" "0" "neutralized-init-oracle-red" "$out" "neutralized-negative RED unpinned-br-init"
check "$rc" "0" "neutralized-write-oracle-red" "$out" "neutralized-negative RED inherited-br-call"


# Pushed range: an unchanged legacy call is allowed, a newly added call is refused,
# and a pinned call is admitted after the unsafe site becomes baseline.
P=$(new_repo range)
printf 'run(["br", "init"]);\n' > "$P/legacy.ts"
git -C "$P" add legacy.ts
git -C "$P" commit -q -m "[test] legacy baseline"
base=$(git -C "$P" rev-parse HEAD)
printf 'run(["br", "init"]);\n// unrelated change\n' > "$P/legacy.ts"
git -C "$P" add legacy.ts
git -C "$P" commit -q -m "[test] unrelated edit"
clean=$(git -C "$P" rev-parse HEAD)
out=$(range_check "$P" "$base" "$clean" 2>&1)
rc=$?
check "$rc" "0" "range-unchanged-legacy-admitted" "$out" ""
printf 'run(["br", "init"]);\n' > "$P/new.ts"
git -C "$P" add new.ts
git -C "$P" commit -q -m "[test] new unsafe init"
bad=$(git -C "$P" rev-parse HEAD)
out=$(range_check "$P" "$clean" "$bad" 2>&1)
rc=$?
check "$rc" "1" "range-new-call-refused" "$out" "new.ts:1:"
check "$rc" "1" "range-rule-named" "$out" "unpinned-br-init"
printf 'run(["br", "init", "--db", join(dir, ".beads", "beads.db")]);\n' > "$P/pinned.ts"
git -C "$P" add pinned.ts
git -C "$P" commit -q -m "[test] pinned init"
pinned=$(git -C "$P" rev-parse HEAD)
out=$(range_check "$P" "$bad" "$pinned" 2>&1)
rc=$?
check "$rc" "0" "range-pinned-admitted" "$out" ""
printf 'brun(["create", "probe"], dir);\n' > "$P/inherited.ts"
git -C "$P" add inherited.ts
git -C "$P" commit -q -m "[test] inherited fixture br call"
inherited=$(git -C "$P" rev-parse HEAD)
out=$(range_check "$P" "$pinned" "$inherited" 2>&1)
rc=$?
check "$rc" "1" "range-inherited-call-refused" "$out" "inherited.ts:1:"
check "$rc" "1" "range-inherited-call-rule-named" "$out" "inherited-br-call"
printf 'brun(["create", "probe"], dir, { BEADS_DB: join(dir, ".beads", "beads.db") });\n' > "$P/bound.ts"
git -C "$P" add bound.ts
git -C "$P" commit -q -m "[test] fixture br call with own database"
bound=$(git -C "$P" rev-parse HEAD)
out=$(range_check "$P" "$inherited" "$bound" 2>&1)
rc=$?
check "$rc" "0" "range-bound-call-admitted" "$out" ""


# The real pre-push adapter must run the base-archive range checker and refuse
# before later gates when the pushed range adds an unpinned call.
G=$(new_repo pre-push)
mkdir -p "$G/scripts" "$G/var/agent-tmp"
for helper in pysafe.py kitlib_ratchet_core.py br_init_check.py; do cp "$SCRIPTS/$helper" "$G/scripts/$helper"; done
git -C "$G" add scripts
git -C "$G" commit -q -m "[test] base br init checker"
base=$(git -C "$G" rev-parse HEAD)
printf 'run(["br", "init"]);\n' > "$G/unsafe.ts"
git -C "$G" add unsafe.ts
git -C "$G" commit -q -m "[test] unpinned br init"
bad=$(git -C "$G" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$bad" "$base" | (CDPATH='' cd -- "$G" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
rc=$?
check "$rc" "1" "prepush-unpinned-refused" "$out" "RED br-init-range producer_rc=1"
check "$rc" "1" "prepush-unpinned-named" "$out" "unsafe.ts:1:"
printf 'brun(["create", "probe"], dir);\n' > "$G/inherited.ts"
git -C "$G" add inherited.ts
git -C "$G" commit -q -m "[test] inherited fixture br call"
bad_call=$(git -C "$G" rev-parse HEAD)
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$bad_call" "$bad" | (CDPATH='' cd -- "$G" && sh "$SCRIPTS/pre-push-gate.sh") 2>&1)
rc=$?
check "$rc" "1" "prepush-inherited-call-refused" "$out" "RED br-init-range producer_rc=1"
check "$rc" "1" "prepush-inherited-call-named" "$out" "inherited.ts:1:"
check "$rc" "1" "prepush-inherited-call-rule-named" "$out" "inherited-br-call"


printf 'check-staged-br-init: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
