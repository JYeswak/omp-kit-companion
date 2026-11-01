#!/bin/sh
# DEPLOYSTEP1: exercise the installed commit-msg gate with real fixture commits.
set -u
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
INSTALLER="$ROOT/scripts/install-commit-msg-bead.sh"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$ROOT/tests/cli/git-env-fixtures.sh"
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
kitlib_tmp TMP deploy-step-test || exit 1
: > "$TMP/gitconfig"
GIT_CONFIG_GLOBAL="$TMP/gitconfig"
GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && [ "$3" = "$4" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		printf 'FAIL %s: got rc=%s value<<<%s>>>; want rc=%s value<<<%s>>>\n' "$5" "$1" "$3" "$2" "$4" >&2
	fi
}

R="$TMP/deploy-step"
mkdir -p "$R/changelog.d" "$R/docs" "$R/scripts"
git -C "$R" init -q
git -C "$R" config user.email test@invalid.example
git -C "$R" config user.name Test
: > "$R/changelog.d/.keep"
printf '# Release procedure\n' > "$R/docs/release-procedure.md"
git -C "$R" add docs/release-procedure.md
git -C "$R" add changelog.d/.keep
git -C "$R" commit -q -m '[test] fixture root'
git -C "$R" tag v0.0.0
install_out=$(sh "$INSTALLER" --no-pushed-beads "$R" 2>&1)
install_rc=$?
if [ "$install_rc" -ne 0 ]; then
	printf 'FAIL fixture install rc=%s output<<<%s>>>\n' "$install_rc" "$install_out" >&2
	exit 1
fi

printf '#!/bin/sh\n# fixture installer edit\n' > "$R/scripts/install-commit-msg-bead.sh"
printf '### Fixed\n\n- Require deployment steps for install, hook, service, and update changes.\n' > "$R/changelog.d/x-1.md"
git -C "$R" add changelog.d/x-1.md
git -C "$R" add scripts/install-commit-msg-bead.sh
before=$(git -C "$R" rev-parse HEAD)
out=$(git -C "$R" commit -q -m '[test] update installer' -m 'Bead: x-1' 2>&1)
rc=$?
case "$out" in *DEPLOY_STEP_MISSING*) refusal=DEPLOY_STEP_MISSING ;; *) refusal=missing ;; esac
check "$rc" 1 "$refusal" DEPLOY_STEP_MISSING 'missing deployment step is refused'
check 0 0 "$(git -C "$R" rev-parse HEAD)" "$before" 'refused commit leaves HEAD unchanged'

out=$(git -C "$R" commit -q -m '[test] update installer' -m 'Bead: x-1' -m 'Deploy-Step: sh scripts/install-commit-msg-bead.sh --check' 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && [ "$(git -C "$R" rev-parse HEAD)" != "$before" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL valid deployment step lands: rc=%s before=%s after=%s\n' "$rc" "$before" "$(git -C "$R" rev-parse HEAD)" >&2
fi
files=$(git -C "$R" diff-tree --no-commit-id --name-only -r HEAD | tr '\n' ' ')
check 0 0 "$files" 'changelog.d/x-1.md scripts/install-commit-msg-bead.sh ' 'valid commit includes installer and changelog'
printf '\n### Recovery\n' >> "$R/docs/release-procedure.md"
printf '### Fixed\n\n- Document a deployment recovery path.\n' > "$R/changelog.d/x-2.md"
printf '# documented installer edit\n' >> "$R/scripts/install-commit-msg-bead.sh"
git -C "$R" add docs/release-procedure.md changelog.d/x-2.md scripts/install-commit-msg-bead.sh
before_reference=$(git -C "$R" rev-parse HEAD)
out=$(git -C "$R" commit -q -m '[test] document installer recovery' -m 'Bead: x-2' 2>&1)
rc=$?
after_reference=$(git -C "$R" rev-parse HEAD)
if [ "$rc" -eq 0 ] && [ "$after_reference" != "$before_reference" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL release-runbook reference permits deploy change: rc=%s before=%s after=%s output<<<%s>>>\n' "$rc" "$before_reference" "$after_reference" "$out" >&2
fi

printf 'deploy-step: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
