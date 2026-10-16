#!/bin/sh
# Install the fleet disk observer (sbh) on a CI runner and put it on PATH for
# later steps. `omp-kit heavy` admits work only on a real disk observation and
# fails fast (69) when sbh is missing (HEAVYCI1, ompkit-fp72.117), so every
# job that runs scripts/ladder.sh installs it first.
#
# Pinned by release version and per-asset sha256 (from the release's
# SHA256SUMS, re-hashed from the downloaded assets 2026-10-16); any mismatch
# refuses. Bump SBH_VERSION and all four digests together.
set -eu

SBH_VERSION=v0.7.6
case "$(uname -s)-$(uname -m)" in
	Linux-x86_64) asset=sbh_linux_amd64 want=394d476e95e5766411790474b1a50e7e3cc6601f22af938b8497a4dd81455d7b ;;
	Linux-aarch64) asset=sbh_linux_arm64 want=1d710d62a6d40791ff21dadae308d3b3d28c8b6db017fc6f0f2f6a653d7c69b1 ;;
	Darwin-arm64) asset=sbh_darwin_arm64 want=4e8d2ce479e75a4a549164ff5b6b0e05feab35c0f28ccd5760baf6864a9d3be2 ;;
	Darwin-x86_64) asset=sbh_darwin_amd64 want=7f7da0e1d5e22d78431f9c326b0ae7894962c3936cfa944242a6c189c065305a ;;
	*) echo "ci-install-sbh: no pinned sbh for $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

dest="${RUNNER_TEMP:?RUNNER_TEMP is required}/sbh-bin"
mkdir -p "$dest"
curl -fsSL --retry 3 -o "$dest/sbh" "https://github.com/Dicklesworthstone/storage_ballast_helper/releases/download/$SBH_VERSION/$asset"
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$dest/sbh" | cut -d ' ' -f 1)
else
	got=$(shasum -a 256 "$dest/sbh" | cut -d ' ' -f 1)
fi
if [ "$got" != "$want" ]; then
	echo "ci-install-sbh: sha256 mismatch for $asset $SBH_VERSION: got $got, pinned $want" >&2
	rm -f "$dest/sbh"
	exit 1
fi
chmod 0755 "$dest/sbh"
echo "$dest" >> "${GITHUB_PATH:?GITHUB_PATH is required}"
"$dest/sbh" --version

# A GitHub macOS runner image ships with ~13% of its 343 GB volume free,
# under sbh's own pressure floor (its verdict: free_pct 12.8,
# threshold_pct 14.0, run 38977569094). heavy then (correctly) defers every
# harness for 900 s. Make the runner meet the floor instead of moving it:
# remove preinstalled SDKs this repo never uses, one at a time, until sbh
# admits. Actions macOS runners only; the active Xcode and symlinks are kept.
verdict=0
"$dest/sbh" check --need 10G >/dev/null 2>&1 || verdict=$?
if [ "$verdict" = 1 ] && [ "${GITHUB_ACTIONS:-}" = true ] && [ "$(uname -s)" = Darwin ]; then
	active_xcode=$(cd -P "$(xcode-select -p)/../.." 2>/dev/null && pwd) || active_xcode=""
	for dir in "${ANDROID_HOME:-}" "$HOME/.dotnet" /Applications/Xcode_*.app; do
		[ -n "$dir" ] && [ -d "$dir" ] && [ ! -L "$dir" ] || continue
		[ "$(cd -P "$dir" && pwd)" != "$active_xcode" ] || continue
		sudo rm -rf "$dir"
		echo "ci-install-sbh: reclaimed unused runner image dir $dir"
		verdict=0
		"$dest/sbh" check --need 10G >/dev/null 2>&1 || verdict=$?
		[ "$verdict" = 1 ] || break
	done
fi

# Diagnostic only: the runner's own verdict, so a pressure deferral in the
# ladder is attributable from this log. heavy makes the admission decision.
verdict=0
"$dest/sbh" check --need 10G || verdict=$?
echo "ci-install-sbh: runner disk verdict: sbh check --need 10G exit $verdict (0 healthy, 1 pressure, other error)"
