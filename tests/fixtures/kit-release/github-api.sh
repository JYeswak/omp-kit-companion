# Sourced by the installer shell tests (set $ROOT to the repository first). The installer reads the release tag's commit
# and the archive's attestation bundle from the public GitHub API, anonymously; this starts the loopback double for that
# API (tests/cli/github-api-fixture.ts) and exports OMP_KIT_GITHUB_API at it. The double exits when this shell does.
#   . "$ROOT/tests/fixtures/kit-release/github-api.sh"; github_api_start "$WORK"   # any release tag; or: github_api_start "$WORK" 1.2.3
# shellcheck source=scripts/kitlib-proc.sh
. "$ROOT/scripts/kitlib-proc.sh"
github_api_start() {
	_gh_dir=$1
	_gh_version=${2:-}
	_gh_port_file="$_gh_dir/github-api.port"
	command -v bun >/dev/null 2>&1 || { echo "github_api_start: bun is required for the GitHub API double" >&2; return 1; }
	bun "$ROOT/tests/cli/github-api-fixture.ts" --serve --port-file "$_gh_port_file" ${_gh_version:+--version "$_gh_version"} &
	GITHUB_API_PID=$!
	_gh_tries=0
	while ! grep -q '^[0-9][0-9]*$' "$_gh_port_file" 2>/dev/null; do
		_gh_tries=$((_gh_tries + 1))
		if [ "$_gh_tries" -gt 100 ]; then echo "github_api_start: the GitHub API double never listened" >&2; return 1; fi
		sleep 0.1
	done
	OMP_KIT_GITHUB_API="http://127.0.0.1:$(cat "$_gh_port_file")"
	export OMP_KIT_GITHUB_API
}
github_api_stop() {
	[ -z "${GITHUB_API_PID:-}" ] || kitlib_signal TERM "$GITHUB_API_PID" 2>/dev/null || true
}
