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
