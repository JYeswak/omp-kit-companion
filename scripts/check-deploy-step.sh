#!/usr/bin/env bash
# check-deploy-step.sh MSGFILE — commit-msg member for deploy-sensitive paths.
set -u
set -o pipefail
msg=${1:?usage: check-deploy-step.sh MSGFILE}

# This member is inert in repos that do not use changelog fragments.
git cat-file -e HEAD:changelog.d 2>/dev/null || exit 0

refuse() {
	printf 'DEPLOY_STEP_MISSING: %s; add Deploy-Step: <command> or Deploy-Step: none (<reason>)\n' "$1" >&2
	exit 1
}

changed=$(git diff --cached --no-renames --name-only --diff-filter=ACMRTD) || refuse 'could not inspect staged paths'
needs_step=0
has_reference=0
while IFS= read -r path; do
	case "$path" in
		*installer/*|*scripts/install-*|*scripts/*hook*|*scripts/check-*|*scripts/chain-*|*scripts/pre-push-*|*scripts/*service*|*scripts/*update*|*scripts/limit-process-tree.sh|*scripts/kitlib-findings.sh|*scripts/release-notes.ts|*src/service*|*src/kit-update*|*.github/workflows/release*.yml)
			needs_step=1
			;;
	esac
	case "$path" in
		docs/release-procedure.md|docs/service-contract.md|docs/release-signing.md|README.md)
			has_reference=1
			;;
	esac
done <<< "$changed"
[ "$needs_step" -eq 1 ] || exit 0
[ "$has_reference" -eq 1 ] && exit 0

trailers=$(git interpret-trailers --parse < "$msg") || refuse 'could not parse commit trailers'
deploy_step_count=0
deploy_step=''
while IFS= read -r line; do
	case "$line" in
		'Deploy-Step: '*)
			deploy_step_count=$((deploy_step_count + 1))
			deploy_step=${line#Deploy-Step: }
			;;
		'Deploy-Step:'*)
			deploy_step_count=$((deploy_step_count + 1))
			deploy_step=''
			;;
	esac
done <<EOF
$trailers
EOF
[ "$deploy_step_count" -eq 1 ] || refuse 'exactly one Deploy-Step trailer is required for deploy-sensitive paths'
case "$deploy_step" in
	'') refuse 'Deploy-Step trailer must name a command or a reason' ;;
	none\ \(*\))
		reason=${deploy_step#none (}
		reason=${reason%)}
		nonblank=${reason// /}
		[ -n "$nonblank" ] || refuse 'Deploy-Step: none requires a non-empty reason'
		;;
	*)
		nonblank=${deploy_step// /}
		[ -n "$nonblank" ] || refuse 'Deploy-Step trailer must name a command or a reason'
		;;
esac
