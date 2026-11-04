#!/bin/sh
# Installer contract cases; production literals retained for affected-tests.ts.
# scripts/br_init_check.py scripts/check-commit-gate.sh scripts/check-commit-imports.sh scripts/check-commit-kitlib-reversal.sh
# scripts/check-commit-notes.sh scripts/check-deploy-step.sh scripts/check-gap-mention.sh scripts/check-portable-paths.sh
# scripts/check-pushed-beads.sh scripts/check-pushed-on-main.sh scripts/check-staged-br-init.sh scripts/check-staged-fragments.sh
# scripts/check-staged-imports.sh scripts/check-staged-kitlib.sh scripts/check-staged-pysafe.sh scripts/check-staged-readme.sh
# scripts/check-staged-regexploit.sh scripts/check-staged-sources.sh scripts/check-staged-tempsafe.sh scripts/check-staged-wallclock.sh
# scripts/check-stale-worktree.sh scripts/commit-msg-bead.sh scripts/gate-event.sh scripts/install-commit-msg-bead.sh
# scripts/kitlib-findings.sh scripts/kitlib-tmp.sh scripts/kitlib_io.py scripts/kitlib_jsonl.py
# scripts/kitlib_lock.py scripts/kitlib_ratchet.py scripts/kitlib_ratchet_core.py scripts/kitlib_run.py
# scripts/kitlib_tmp.py scripts/limit-process-tree.sh scripts/portable_paths_check.py scripts/pre-push-verification-level.sh
# scripts/pysafe.py scripts/pysafe_check.py scripts/pysafe_inline.py scripts/pysafe_inline_literals.py
# scripts/readme-check.ts scripts/ref-txn-bead.sh scripts/release-notes.ts scripts/sources.py
# scripts/tempsafe_check.py scripts/wallclock_check.py
# scripts/ref-txn-witness.py tests/cli/ref-txn-witness-fixtures.py
# shellcheck source=tests/cli/install-commit-msg-bead.lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/install-commit-msg-bead.lib.sh"
ok "$baseline_install_rc" "0" "absent-install-rc"

# HISTADMIT1 (ompkit-2w7h.3): the actually installed reference-transaction
# chain, in an owned fixture, admits only the exact independently reviewed
# history transform. It refuses an unrelated id-less update before any ref
# moves, and a missing witness reader refuses that operation while ordinary
# updates keep working. --check covers the reader and its pysafe.py copy.
group_witness() {
CLI_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
fx() { (CDPATH='' cd -- "$CLI_DIR" && python3 -B ref-txn-witness-fixtures.py "$@"); }
mkdir -p "$TMP/bin"
cat > "$TMP/bin/br" <<'EOF'
#!/bin/sh
id=""
for arg in "$@"; do id="$arg"; done
case " $KNOWN_IDS " in *" $id "*) exit 0 ;; *) exit 3 ;; esac
EOF
chmod +x "$TMP/bin/br"
BR_BIN="$TMP/bin/br" BEADS_DB="$TMP/beads.db" KNOWN_IDS="ompkit-2w7h"
export BR_BIN BEADS_DB KNOWN_IDS
: > "$BEADS_DB"
BUILD=$(fx build "$TMP") || { fail=$((fail + 1)); printf 'FAIL witness-fixture-build\n'; return 1; }
H=$(printf '%s\n' "$BUILD" | sed -n 's/^repo //p')
ROOT=$(printf '%s\n' "$BUILD" | sed -n 's/^root //p')
L1=$(printf '%s\n' "$BUILD" | sed -n 's/^l1 //p')
L2=$(printf '%s\n' "$BUILD" | sed -n 's/^l2 //p')
sh "$INSTALLER" "$H" > "$TMP/o-witness" 2>&1
ok "$?" "0" "witness-install-rc"
RTX="$H/.git/hooks/hooks.d/reference-transaction"
SRC=$(dirname -- "$INSTALLER")
if cmp -s "$RTX/ref-txn-witness.py" "$SRC/ref-txn-witness.py" && cmp -s "$RTX/pysafe.py" "$SRC/pysafe.py" &&
	[ ! -x "$RTX/ref-txn-witness.py" ] && [ ! -x "$RTX/pysafe.py" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "witness-reader-installed-inert"
printf '# drift\n' >> "$RTX/ref-txn-witness.py"
sh "$INSTALLER" --check "$H" > "$TMP/o-witness-check" 2>&1
rc=$?
if [ "$rc" -ne 0 ] && grep -q 'ref-txn-witness.py' "$TMP/o-witness-check"; then rc=0; else rc=1; fi
ok "$rc" "0" "witness-reader-stale-named-by-check"
sh "$INSTALLER" "$H" > /dev/null 2>&1
cmp -s "$RTX/ref-txn-witness.py" "$SRC/ref-txn-witness.py"
ok "$?" "0" "witness-reader-refreshed"
fx rewrite "$H" "$H/.git/good.map.json" --l1 "$L1" --l2 "$L2" "$L2" "$ROOT"
read -r SHA NEW <<EOF
$(fx plan "$H" "$H/.git/good.map.json" "$H/.git/reviewed.plan.json" --old "$L2" --public "$ROOT" --authority J-TEST-installed)
EOF
PLAN="$H/.git/reviewed.plan.json"
fx approval "$H" "$H/.git/reviewed.approval.json" --plan "$PLAN" --id 61 --from independent-reviewer > /dev/null
(CDPATH='' cd -- "$H" && python3 -B -c 'import runpy, sys; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")' "$RTX/ref-txn-witness.py" review --plan "$PLAN" --reviewer independent-reviewer --approval-message-id 61 --approval-file "$H/.git/reviewed.approval.json") > /dev/null
ok "$?" "0" "witness-installed-review-rc"
refs_now() { git -C "$H" for-each-ref --format='%(refname) %(objectname)'; }
PRE="refs/preserve/history-scrub/$L2"
D=$(printf 'unrelated work with no identity\n' | git -C "$H" commit-tree "$NEW^{tree}" -p "$NEW")
# An unrelated id-less update during the reviewed operation: refused before mutation.
before=$(refs_now)
out=$(fx drive "$H" "$PLAN" --commands "[\"create $PRE/main $L2\", \"create $PRE/public/heads/main $ROOT\", \"update refs/heads/main $D $L2\"]" 2> "$TMP/o-witness-d")
ok "$out" "PREPARE_REFUSED" "witness-unrelated-idless-refused"
ok "$(refs_now)" "$before" "witness-unrelated-idless-refs-unchanged"
# The same id-less update with no operation context: the unchanged ordinary refusal.
if git -C "$H" update-ref refs/heads/main "$D" "$L2" 2> "$TMP/o-witness-o"; then rc=1; else rc=0; fi
ok "$rc" "0" "witness-ordinary-idless-refused"
grep -q "commit $D names no existing bead id" "$TMP/o-witness-o"
ok "$?" "0" "witness-ordinary-idless-reason"
ok "$(refs_now)" "$before" "witness-ordinary-idless-refs-unchanged"
# A missing reader refuses the reviewed operation only; an ordinary id'd update still flows.
mv "$RTX/ref-txn-witness.py" "$TMP/witness.moved"
out=$(fx drive "$H" "$PLAN" 2> "$TMP/o-witness-m")
ok "$out" "PREPARE_REFUSED" "witness-reader-missing-refused"
grep -q 'witness reader is missing' "$TMP/o-witness-m"
ok "$?" "0" "witness-reader-missing-reason"
ok "$(refs_now)" "$before" "witness-reader-missing-refs-unchanged"
X=$(printf 'ordinary fix ompkit-2w7h\n' | git -C "$H" commit-tree "$L2^{tree}" -p "$L2")
git -C "$H" update-ref refs/heads/main "$X" "$L2"
ok "$?" "0" "witness-reader-missing-ordinary-flows"
git -C "$H" update-ref refs/heads/main "$L2" "$X"
mv "$TMP/witness.moved" "$RTX/ref-txn-witness.py"
# The paired admitted control: the reviewed transform through the installed chain.
out=$(fx drive "$H" "$PLAN" 2> "$TMP/o-witness-p")
ok "$out" "COMMITTED" "witness-reviewed-transform-committed"
ok "$(git -C "$H" rev-parse refs/heads/main)" "$NEW" "witness-reviewed-transform-main"
grep -q "ADMITTED reviewed history transform plan=$SHA ref=refs/heads/main old=$L2 new=$NEW mapped=3" "$TMP/o-witness-p"
ok "$?" "0" "witness-reviewed-transform-provenance"
}

# RUNNERCHECK1 (ompkit-fp72.120.16.236): --check reads the chain runners with the
# installer's own upgrade predicate and the pushed-beads wrapper against its generator.
group_runnercheck() {
R=$(installed_repo runnercheck) || exit 1
sh "$INSTALLER" --check "$R" > "$TMP/o-rc-fresh" 2>&1
ok "$?" "0" "runnercheck-control-fresh-rc"
# Planted: fresh members, but the pre-push runner is a v5 generation.
sed 's/GATEEVENTS1 runner v[0-9][0-9]*/GATEEVENTS1 runner v5/' "$R/.git/hooks/pre-push" > "$TMP/v5" && cat "$TMP/v5" > "$R/.git/hooks/pre-push"
sh "$INSTALLER" --check "$R" > "$TMP/o-rc-v5" 2>&1
ok "$?" "3" "runnercheck-v5-runner-rc"
grep -q "STALE chain runner: $R/.git/hooks/pre-push" "$TMP/o-rc-v5"
ok "$?" "0" "runnercheck-v5-runner-named"
grep -c 'STALE chain runner' "$TMP/o-rc-v5" | grep -qx 1
ok "$?" "0" "runnercheck-only-planted-runner-named"
# Mutant: the same installer with --check's runner test removed reads the v5 runner as fresh.
mkdir -p "$TMP/mut/src" && cp -R "$(dirname -- "$INSTALLER")" "$TMP/mut/scripts" && cp "$(dirname -- "$INSTALLER")/../src/"*.v1.json "$TMP/mut/src/"
# shellcheck disable=SC2016 # literal $ in the sed pattern, matched in the installer source
sed 's/if runner_stale "\$HOOKS\/\$runner_type"; then/if false; then/' "$INSTALLER" > "$TMP/mut/scripts/install-commit-msg-bead.sh"
sh "$TMP/mut/scripts/install-commit-msg-bead.sh" --check "$R" > "$TMP/o-rc-mut" 2>&1
ok "$?" "0" "runnercheck-mutant-misses-v5"
grep -q 'STALE chain runner' "$TMP/o-rc-mut"
ok "$?" "1" "runnercheck-mutant-silent"
sh "$INSTALLER" "$R" > /dev/null 2>&1
sh "$INSTALLER" --check "$R" > /dev/null 2>&1
ok "$?" "0" "runnercheck-reinstall-fresh"
# Planted: a stale generated pushed-beads wrapper.
printf '# stale wrapper\n' >> "$R/.git/hooks/hooks.d/pre-push/40-omp-kit-pushed-beads"
sh "$INSTALLER" --check "$R" > "$TMP/o-rc-wrap" 2>&1
ok "$?" "3" "runnercheck-stale-wrapper-rc"
grep -q "STALE pushed-beads member: $R/.git/hooks/hooks.d/pre-push/40-omp-kit-pushed-beads" "$TMP/o-rc-wrap"
ok "$?" "0" "runnercheck-stale-wrapper-named"
sed 's/! pushed_beads_wrapper | cmp -s - /false \&\& cmp -s - /' "$INSTALLER" > "$TMP/mut/scripts/install-commit-msg-bead.sh"
sh "$TMP/mut/scripts/install-commit-msg-bead.sh" --check "$R" > /dev/null 2>&1
ok "$?" "0" "runnercheck-mutant-misses-wrapper"
}

start_group group_witness
run_installer_groups group_plain group_sibling group_pathbound group_refusing group_restore group_idless group_stdin group_upgrade group_inert group_runnercheck
