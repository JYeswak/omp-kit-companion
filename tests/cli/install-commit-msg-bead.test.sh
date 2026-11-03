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
# shellcheck source=tests/cli/install-commit-msg-bead.lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/install-commit-msg-bead.lib.sh"
ok "$baseline_install_rc" "0" "absent-install-rc"
run_installer_groups group_plain group_sibling group_pathbound group_refusing group_restore group_idless group_stdin group_upgrade group_inert
