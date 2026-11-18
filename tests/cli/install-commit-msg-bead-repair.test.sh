#!/bin/sh
# Installer contract cases; production literals retained for affected-tests.ts.
# scripts/br_init_check.py scripts/check-commit-gate.sh scripts/check-commit-imports.sh scripts/check-commit-kitlib-reversal.sh
# scripts/check-commit-notes.sh scripts/check-deploy-step.sh scripts/check-portable-paths.sh
# scripts/check-pushed-beads.sh scripts/check-pushed-on-main.sh scripts/check-staged-br-init.sh scripts/check-staged-fragments.sh
# scripts/check-staged-imports.sh scripts/check-staged-kitlib.sh scripts/check-staged-pysafe.sh scripts/check-staged-readme.sh
# scripts/check-staged-regexploit.sh scripts/check-staged-tempsafe.sh scripts/check-staged-wallclock.sh
# scripts/check-stale-worktree.sh scripts/commit-msg-bead.sh scripts/gate-event.sh scripts/install-commit-msg-bead.sh
# scripts/kitlib-findings.sh scripts/kitlib-tmp.sh scripts/kitlib_io.py scripts/kitlib_jsonl.py
# scripts/kitlib_lock.py scripts/kitlib_ratchet.py scripts/kitlib_ratchet_core.py scripts/kitlib_run.py
# scripts/kitlib_tmp.py scripts/limit-process-tree.sh scripts/portable_paths_check.py scripts/pre-push-verification-level.sh
# scripts/pysafe.py scripts/pysafe_check.py scripts/pysafe_inline.py scripts/pysafe_inline_literals.py
# scripts/readme-check.ts scripts/ref-txn-bead.sh scripts/release-notes.ts scripts/sources.py
# scripts/tempsafe_check.py scripts/wallclock_check.py
# shellcheck source=tests/cli/install-commit-msg-bead.lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/install-commit-msg-bead.lib.sh"

history_fixture() {
	(CDPATH='' cd -- "$(dirname -- "$0")" && python3 -B ref-txn-witness-fixtures.py "$@")
}

group_history_refusal() {
	witness="$(dirname -- "$INSTALLER")/ref-txn-witness.py"
	fixture=$(history_fixture build "$TMP") || exit 1
	repo=$(printf '%s\n' "$fixture" | awk '$1 == "repo" {print $2}')
	legacy_first=$(printf '%s\n' "$fixture" | awk '$1 == "l1" {print $2}')
	legacy_tip=$(printf '%s\n' "$fixture" | awk '$1 == "l2" {print $2}')
	plan="$TMP/stale.plan.json"
	approval="$TMP/stale.approval.json"
	history_fixture rewrite "$repo" "$TMP/map.json" \
		--l1 "$legacy_first" --l2 "$legacy_tip" "$legacy_tip" || exit 1
	plan_fields=$(history_fixture plan "$repo" "$TMP/map.json" "$plan" \
		--old "$legacy_tip" --public "$legacy_tip" --authority J-TEST-scrub) || exit 1
	IFS=' ' read -r plan_sha reviewed_tip <<EOF
$plan_fields
EOF
	history_fixture approval "$repo" "$approval" --plan "$plan" \
		--id 51 --from independent-reviewer >/dev/null || exit 1
	(cd "$repo" && AGENT_NAME=independent-reviewer python3 -B -c 'import runpy, sys; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")' \
		"$witness" review \
		--plan "$plan" --reviewer independent-reviewer --approval-message-id 51 \
		--approval-file "$approval") || exit 1

	# The live repo has advanced past the reviewed root; installer leg 3 sees HEAD
	# on both sides. Seed the real descendant before the installer writes any hooks.
	git -C "$repo" config user.name Test || exit 1
	git -C "$repo" config user.email test@invalid.example || exit 1
	head=$(git -C "$repo" commit-tree "$reviewed_tip^{tree}" -p "$reviewed_tip" \
		-m 'test: later main ompkit-2w7h [test]') || exit 1
	git -C "$repo" update-ref refs/heads/main "$head" "$legacy_tip" || exit 1
	git -C "$repo" read-tree "$head" || exit 1
	bespoke="$repo/.git/hooks/pre-push"
	mkdir -p "$(dirname -- "$bespoke")" || exit 1
	printf '#!/bin/sh\nexit 0\n' > "$TMP/bespoke"
	cp "$TMP/bespoke" "$bespoke" && chmod +x "$bespoke" || exit 1
	rc=0
	out=$(sh "$INSTALLER" "$repo" 2>&1) || rc=$?
	ok "$rc" "1" "history-refusal-rolls-back"
	if printf '%s\n' "$out" | grep -Fq "ref-txn-witness: REFUSED PUSH_TIP_NOT_REVIEWED_NEW_ROOT $head (reviewed $reviewed_tip for refs/heads/main)"; then
		rc=0
	else
		printf '%s\n' "$out"
		rc=1
	fi
	ok "$rc" "0" "history-refusal-retains-actual-witness-line"
	cmp -s "$TMP/bespoke" "$bespoke"; ok "$?" "0" "history-refusal-preserves-bespoke-hook"
	ok "$(git -C "$repo" rev-parse HEAD)" "$head" "history-refusal-preserves-main"
	cmp -s "$plan" "$repo/.git/omp-kit/history-review/$plan_sha.plan.json"
	ok "$?" "0" "history-refusal-preserves-reviewed-plan"
}

run_installer_groups group_imports group_notes group_staged group_pysafe group_kitlib_missing group_kitlib_stale group_kitlib_ratchet group_br_init group_kitlib_reversal group_history_refusal
