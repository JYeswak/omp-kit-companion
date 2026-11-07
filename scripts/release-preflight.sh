#!/bin/sh
# Read-only cut prerequisites, shared by release-local and release readiness.
# No signing, qualification, network writes or checkout mutations.
release_preflight_version() {
	sh "$4/scripts/release-train.sh" version-match --version "$3" --sha "$2" --repo "$1"
}
release_preflight_signing() {
	mode=$(git -C "$1" show "$2:scripts/release-signing.json" | jq -er 'select(.schema_version == 1) | .darwin_signing') || return 1
	if [ "$mode" != developer-id ]; then
		[ "${5:-0}" = 1 ] || { printf "source darwin_signing is '%s'; a local release requires developer-id\n" "$mode"; return 1; }
		printf "release-local: dry-run continues although source darwin_signing is '%s'\n" "$mode" >&2
	fi
	printf '%s\n' "$mode"
}
release_preflight_attestation() {
	git -C "$1" show "$2:.github/workflows/release.yml" | grep -q '^  attest-local:$' || {
		printf 'source release.yml has no attest-local job (LOCAL-RELEASE-V1)\n'; return 1;
	}
}
release_preflight_verdict() (
	# KIND REPO TREE SOURCE_EXPORT; pin before selecting the Python interpreter.
	kind=$1; shift
	cd "$3/scripts" || exit 1
	# shellcheck source=scripts/fixed-env.sh
	. ./fixed-env.sh
	if [ "$kind" = main ]; then
		python3 -B -m full-suite-verdict-store require-pass --repo "$1" --tree "$2" --role main --judge-root "$3" --suite-root "$3"
	else
		python3 -B -m full-suite-verdict-store require-ci-only-pass --repo "$1" --tree "$2" --judge-root "$3" --suite-root "$3"
	fi
)
release_preflight_releases() {
	# VERSION RELEASES_JSON (gh api --paginate --slurp output).
	[ "$(jq --arg t "v$1" '[.[][] | select(.tag_name == $t)] | length' "$2")" = 0 ] || {
		printf 'a release or draft for v%s already exists\n' "$1"; return 1;
	}
	base=$(jq -er '[.[][] | select(.draft == false and .prerelease == false) | .tag_name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))] | sort_by(ltrimstr("v") | split(".") | map(tonumber)) | last' "$2") || {
		printf 'no published base release\n'; return 1;
	}
	python3 -c 'import sys; a, b = (tuple(map(int, v.split("."))) for v in sys.argv[1:]); sys.exit(0 if a > b else 1)' "$1" "${base#v}" || {
		printf 'v%s is not newer than latest published %s\n' "$1" "$base"; return 1;
	}
	printf '%s\n' "$base"
}
release_preflight_export() {
	[ "$(jq -r .source_revision "$1/package.json")" = "$2" ] || {
		printf 'export did not stamp source_revision\n'; return 1;
	}
	actual=$(bun --version) || return 1
	pinned=$(tr -d '[:space:]' <"$1/.bun-version") || return 1
	[ "$actual" = "$pinned" ] || {
		printf 'bun %s differs from source pin %s\n' "$actual" "$pinned"; return 1;
	}
}
release_preflight_next_version() {
	if printf '%s\n' "$2" | cut -f2 | grep -Fxq "refs/tags/v$1"; then
		python3 -c 'import sys; a,b,c = map(int, sys.argv[1].split(".")); print(f"{a}.{b}.{c + 1}")' "$1"
	else
		printf '%s\n' "$1"
	fi
}

check=${1:-}
[ "$#" -eq 0 ] || shift
case "$check" in
	version|signing|attestation|verdict|releases|export|next_version)
		"release_preflight_$check" "$@" ;;
	*) printf 'release-preflight: expected version|signing|attestation|verdict|releases|export|next_version\n' >&2; exit 2 ;;
esac
