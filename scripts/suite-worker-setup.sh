#!/bin/sh
# suite-worker-setup.sh -- SUITEREMOTE1 (ompkit-qsktr): bring Linux suite workers to CI parity.
#
# Usage: sh scripts/suite-worker-setup.sh [--host USER@HOST]... [--check]
#
# With no --host, the workers are rch's own enabled Linux workers (`python3 scripts/full-suite-remote.py
# workers`, which reads `rch workers list --json`); there is no second inventory. Each host is reached as
# root over ssh (BatchMode) and gets, idempotently, what .github/workflows/ci.yml installs for its
# ubuntu-24.04 cli-contracts legs, at the same pins:
#   - bubblewrap, with kernel.apparmor_restrict_unprivileged_userns=0 persisted (CI sets it per run), and a
#     bwrap containment smoke as the suite user;
#   - Bun at the repo's .bun-version;
#   - Node (pinned below, checksum-verified) and, in one npm prefix, the certified OMP from
#     scripts/omp-compat.json plus the TypeScript LSP pins from ci.yml;
#   - br at ci.yml's pinned version, checksum-verified against the release's .sha256;
#   - the apt packages the suite's Linux legs need beyond a stock Ubuntu image (SUITE_APT below);
#   - an unprivileged suite user (omp-suite; CI runs as a non-root runner, and root bypasses permission
#     checks tests rely on) reachable over ssh with root's authorized keys, and its work root.
# Last it writes /opt/omp-kit-suite/READY.json naming every installed version; full-suite-remote.py
# admits a worker only when that marker matches the pins it expects. --check installs nothing and
# reports whether each host is ready. Every host prints what it installed, or "unchanged".
# Exit: 0 every host ready; 1 a host failed (the others still ran); 2 usage.
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)
SUITE_APT="bubblewrap xz-utils unzip git python3 jq curl ca-certificates util-linux procps gh"
CHECK=0
HOSTS=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--host) [ "$#" -ge 2 ] || { echo "usage: suite-worker-setup.sh [--host USER@HOST]... [--check]" >&2; exit 2; }; HOSTS="$HOSTS $2"; shift 2 ;;
		--check) CHECK=1; shift ;;
		-h|--help) sed -n '2,24p' "$0"; exit 0 ;;
		*) echo "usage: suite-worker-setup.sh [--host USER@HOST]... [--check]" >&2; exit 2 ;;
	esac
done
pins=$(PYTHONPATH="$SCRIPT_DIR" python3 -B -m full-suite-remote pins --root "$ROOT") || { echo "suite-worker-setup: cannot read the CI pins" >&2; exit 1; }
if [ -z "$HOSTS" ]; then
	HOSTS=$(PYTHONPATH="$SCRIPT_DIR" python3 -B -m full-suite-remote workers --format ssh) || { echo "suite-worker-setup: cannot list rch workers" >&2; exit 1; }
	[ -n "$HOSTS" ] || { echo "suite-worker-setup: rch lists no enabled Linux worker" >&2; exit 1; }
fi
# The marker the runner compares (full-suite-remote.py pins --marker): every pin, comma-joined.
marker=$(PYTHONPATH="$SCRIPT_DIR" python3 -B -m full-suite-remote pins --root "$ROOT" --marker) || { echo "suite-worker-setup: cannot read the CI pins" >&2; exit 1; }
apt_list=$(printf '%s' "$SUITE_APT" | tr ' ' ',')
failed=0
for host in $HOSTS; do
	echo "== suite-worker-setup $host"
	# The body runs as root on the worker; its arguments are pins without spaces (ssh re-splits the remote
	# command line), never interpolated code.
	# shellcheck disable=SC2086 # $pins is a space-separated key=value list with no spaces inside values
	if ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$host" \
		sh -s -- "$CHECK" "$apt_list" "$marker" $pins <<'REMOTE'
set -eu
CHECK=$1; SUITE_APT=$(printf '%s' "$2" | tr ',' ' '); MARKER=$3; shift 3
for pin in "$@"; do
	case "$pin" in
		bun=*) BUN_VERSION=${pin#bun=} ;;
		omp=*) OMP_VERSION=${pin#omp=} ;;
		tsls=*) TSLS_VERSION=${pin#tsls=} ;;
		ts=*) TS_VERSION=${pin#ts=} ;;
		br=*) BR_VERSION=${pin#br=} ;;
		node=*) NODE_VERSION=${pin#node=} ;;
		node_sha256=*) NODE_SHA256=${pin#node_sha256=} ;;
		shellcheck=*) SHELLCHECK_IMAGE=${pin#shellcheck=} ;;
		uv=*) UV_VERSION=${pin#uv=} ;;
		python311=*) PYTHON311_VERSION=${pin#python311=} ;;
		regexploit=*) REGEXPLOIT_VERSION=${pin#regexploit=} ;;
		rch=*) RCH_VERSION=${pin#rch=} ;;
		*) echo "unknown pin $pin" >&2; exit 2 ;;
	esac
done
SUITE_HOME=/opt/omp-kit-suite
SUITE_USER=omp-suite
NPM_PREFIX=$SUITE_HOME/npm-global
host=$(hostname)
installed=""
note() { installed="$installed $1"; printf 'suite-worker-setup[%s]: %s\n' "$host" "$1"; }
die() { printf 'suite-worker-setup[%s]: FAILED: %s\n' "$host" "$1" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"
[ "$(uname -s)/$(uname -m)" = Linux/x86_64 ] || die "only Linux/x86_64 workers are supported (CI's ubuntu-24.04 leg)"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "only Ubuntu workers are supported, not ${ID:-unknown}"
if [ "$CHECK" = 1 ]; then
	have=$(cat "$SUITE_HOME/READY.json" 2>/dev/null) || have=""
	got=$(printf '%s' "$have" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except ValueError: d={}
print(d.get("pins", "") if isinstance(d, dict) else "")' 2>/dev/null) || got=""
	[ "$got" = "$MARKER" ] || die "not ready (marker: ${have:-absent}); run suite-worker-setup.sh without --check"
	echo "suite-worker-setup[$host]: READY $have"
	exit 0
fi
mkdir -p "$SUITE_HOME"
# 1. apt packages, bounded on the dpkg lock (rch builds share these boxes).
missing=""
for package in $SUITE_APT; do
	dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || missing="$missing $package"
done
if [ -n "$missing" ]; then
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -q update >/dev/null
	# shellcheck disable=SC2086
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -q -y install $missing >/dev/null
	note "apt:$(echo $missing | tr ' ' ',')"
fi
# 2. unprivileged user namespaces for bwrap (CI: sysctl -w per run; here persisted).
conf=/etc/sysctl.d/60-omp-kit-suite-userns.conf
if [ "$(cat "$conf" 2>/dev/null)" != "kernel.apparmor_restrict_unprivileged_userns = 0" ]; then
	printf 'kernel.apparmor_restrict_unprivileged_userns = 0\n' >"$conf"
	note "sysctl-file:$conf"
fi
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != 0 ]; then
	sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=0
	note "sysctl:apparmor_restrict_unprivileged_userns=0"
fi
# 3. the suite user, reachable with root's keys, and its work root.
if ! id -u "$SUITE_USER" >/dev/null 2>&1; then
	useradd --create-home --shell /bin/bash "$SUITE_USER"
	note "user:$SUITE_USER"
fi
suite_home=$(getent passwd "$SUITE_USER" | cut -d: -f6)
install -d -m 700 -o "$SUITE_USER" -g "$SUITE_USER" "$suite_home/.ssh" "$suite_home/work"
if ! cmp -s /root/.ssh/authorized_keys "$suite_home/.ssh/authorized_keys"; then
	install -m 600 -o "$SUITE_USER" -g "$SUITE_USER" /root/.ssh/authorized_keys "$suite_home/.ssh/authorized_keys"
	note "authorized_keys:$SUITE_USER"
fi
# 4. Bun at .bun-version, executable by the suite user (a link into /root is not).
if [ "$(runuser -u "$SUITE_USER" -- /usr/local/bin/bun --version 2>/dev/null || :)" != "$BUN_VERSION" ]; then
	dir="$SUITE_HOME/bun-$BUN_VERSION"
	rm -rf "$dir.part"; mkdir -p "$dir.part"
	base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
	curl -fsSL -o "$dir.part/bun.zip" "$base/bun-linux-x64.zip"
	want=$(curl -fsSL "$base/SHASUMS256.txt" | awk '$2 == "bun-linux-x64.zip" { print $1 }')
	got=$(sha256sum "$dir.part/bun.zip" | cut -d' ' -f1)
	[ -n "$want" ] && [ "$want" = "$got" ] || die "bun $BUN_VERSION sha256 mismatch"
	unzip -q -o "$dir.part/bun.zip" -d "$dir.part"
	rm -rf "$dir"; mv "$dir.part" "$dir"
	ln -sfn "$dir/bun-linux-x64/bun" /usr/local/bin/bun
	note "bun:$BUN_VERSION"
fi
# 5. Node, pinned and checksum-verified, unless the box already carries that exact version.
node_bin=$(command -v node 2>/dev/null || :)
if [ -z "$node_bin" ] || [ "$("$node_bin" --version)" != "v$NODE_VERSION" ]; then
	if [ "$("$SUITE_HOME/node-v$NODE_VERSION/bin/node" --version 2>/dev/null || :)" != "v$NODE_VERSION" ]; then
		tarball="$SUITE_HOME/node-v$NODE_VERSION-linux-x64.tar.xz"
		curl -fsSL -o "$tarball" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
		[ "$(sha256sum "$tarball" | cut -d' ' -f1)" = "$NODE_SHA256" ] || die "node $NODE_VERSION sha256 mismatch"
		rm -rf "$SUITE_HOME/node-v$NODE_VERSION.part"; mkdir -p "$SUITE_HOME/node-v$NODE_VERSION.part"
		tar -xJf "$tarball" -C "$SUITE_HOME/node-v$NODE_VERSION.part" --strip-components=1
		rm -rf "$SUITE_HOME/node-v$NODE_VERSION"; mv "$SUITE_HOME/node-v$NODE_VERSION.part" "$SUITE_HOME/node-v$NODE_VERSION"
		rm -f "$tarball"
		note "node:$NODE_VERSION"
	fi
	[ -n "$node_bin" ] || { ln -sfn "$SUITE_HOME/node-v$NODE_VERSION/bin/node" /usr/local/bin/node; note "link:/usr/local/bin/node"; }
	node_dir="$SUITE_HOME/node-v$NODE_VERSION/bin"
else
	# A link this script made points into the pinned build; npm lives beside the real node.
	node_dir=$(dirname "$(readlink -f "$node_bin")")
fi
# 6. OMP and the TypeScript LSP in one prefix (CI: npm install --global at the same pins).
npm_want="@oh-my-pi/pi-coding-agent@$OMP_VERSION typescript-language-server@$TSLS_VERSION typescript@$TS_VERSION"
npm_have=""
for pkg in @oh-my-pi/pi-coding-agent typescript-language-server typescript; do
	v=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$NPM_PREFIX/lib/node_modules/$pkg/package.json" 2>/dev/null || :)
	npm_have="$npm_have $pkg@$v"
done
if [ "$npm_have" != " $npm_want" ]; then
	# shellcheck disable=SC2086
	PATH="$node_dir:$PATH" "$node_dir/npm" install --global --prefix "$NPM_PREFIX" --no-fund --no-audit --loglevel=error $npm_want >/dev/null
	note "npm:$(echo $npm_want | tr ' ' ',')"
fi
for tool in omp typescript-language-server tsc tsserver; do
	[ "$(readlink "/usr/local/bin/$tool" 2>/dev/null || :)" = "$NPM_PREFIX/bin/$tool" ] && continue
	ln -sfn "$NPM_PREFIX/bin/$tool" "/usr/local/bin/$tool"
	note "link:/usr/local/bin/$tool"
done
# 6b. Docker and the shellcheck engine scripts/commit-preflight.py pins (CI's ubuntu runner and the Mac carry
# both; without them the preflight suites report UNJUDGED shellcheck). The suite user joins the docker group.
if ! command -v docker >/dev/null 2>&1; then
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -q update >/dev/null
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -q -y install docker.io >/dev/null
	note "apt:docker.io"
fi
systemctl is-active --quiet docker || { systemctl enable --now docker >/dev/null 2>&1; note "service:docker"; }
if ! id -nG "$SUITE_USER" | tr ' ' '\n' | grep -qx docker; then
	usermod -aG docker "$SUITE_USER"
	note "group:docker+$SUITE_USER"
fi
if ! docker image inspect "$SHELLCHECK_IMAGE" >/dev/null 2>&1; then
	docker pull -q "$SHELLCHECK_IMAGE" >/dev/null
	note "docker:$SHELLCHECK_IMAGE"
fi
# 6c. python3.11 and regexploit/regexploit-js in one venv (what the Mac's omp-kit-regex-tools provides; the
# regexploit gate and its suites require both), built with a sha256-checked uv release.
uv_bin="$SUITE_HOME/uv-$UV_VERSION/uv"
if [ "$("$uv_bin" --version 2>/dev/null | cut -d' ' -f1-2 || :)" != "uv $UV_VERSION" ]; then
	base="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz"
	rm -rf "$SUITE_HOME/uv-$UV_VERSION"; mkdir -p "$SUITE_HOME/uv-$UV_VERSION"
	curl -fsSL -o "$SUITE_HOME/uv-$UV_VERSION/uv.tar.gz" "$base"
	want=$(curl -fsSL "$base.sha256" | awk '{print $1}')
	[ -n "$want" ] && [ "$want" = "$(sha256sum "$SUITE_HOME/uv-$UV_VERSION/uv.tar.gz" | cut -d' ' -f1)" ] || die "uv $UV_VERSION sha256 mismatch"
	tar -xzf "$SUITE_HOME/uv-$UV_VERSION/uv.tar.gz" -C "$SUITE_HOME/uv-$UV_VERSION" --strip-components=1
	note "uv:$UV_VERSION"
fi
venv="$SUITE_HOME/regexploit-$REGEXPLOIT_VERSION-py$PYTHON311_VERSION"
if [ "$("$venv/bin/python" --version 2>/dev/null || :)" != "Python $PYTHON311_VERSION" ] ||
	! "$venv/bin/python" -c 'import importlib.metadata as m, sys; sys.exit(m.version("regexploit") != sys.argv[1])' "$REGEXPLOIT_VERSION" 2>/dev/null; then
	export UV_PYTHON_INSTALL_DIR="$SUITE_HOME/uv-python" UV_CACHE_DIR="$SUITE_HOME/uv-cache"
	"$uv_bin" python install -q "$PYTHON311_VERSION"
	rm -rf "$venv"
	"$uv_bin" venv -q --python "$PYTHON311_VERSION" "$venv"
	"$uv_bin" pip install -q --python "$venv/bin/python" "regexploit==$REGEXPLOIT_VERSION"
	chmod -R a+rX "$SUITE_HOME/uv-python" "$venv"
	note "regexploit:$REGEXPLOIT_VERSION+python:$PYTHON311_VERSION"
fi
js_dir=$(ls -d "$venv"/lib/python*/site-packages/regexploit/bin/javascript 2>/dev/null | head -n 1)
[ -n "$js_dir" ] || die "regexploit $REGEXPLOIT_VERSION ships no JavaScript scanner"
if [ ! -d "$js_dir/node_modules" ]; then
	# regexploit-js refuses without its parser modules ("Run (cd .../bin/javascript; npm install)").
	(cd "$js_dir" && PATH="$node_dir:$PATH" "$node_dir/npm" install --no-fund --no-audit --loglevel=error >/dev/null)
	chmod -R a+rX "$js_dir/node_modules"
	note "npm:regexploit-js-parsers"
fi
for tool in regexploit regexploit-js; do
	[ "$(readlink "/usr/local/bin/$tool" 2>/dev/null || :)" = "$venv/bin/$tool" ] && continue
	ln -sfn "$venv/bin/$tool" "/usr/local/bin/$tool"
	note "link:/usr/local/bin/$tool"
done
if [ "$(readlink /usr/local/bin/python3.11 2>/dev/null || :)" != "$venv/bin/python3.11" ]; then
	ln -sfn "$venv/bin/python3.11" /usr/local/bin/python3.11
	note "link:/usr/local/bin/python3.11"
fi
# 7. br at ci.yml's pin, checksum from the release (CI's own procedure).
if [ "$(/usr/local/bin/br --version 2>/dev/null || :)" != "br $BR_VERSION" ]; then
	base="br-$BR_VERSION-linux_amd64.tar.gz"
	url="https://github.com/Dicklesworthstone/beads_rust/releases/download/v$BR_VERSION/$base"
	dir="$SUITE_HOME/br-$BR_VERSION"
	rm -rf "$dir"; mkdir -p "$dir"
	curl -fsSL -o "$dir/$base" "$url"
	want=$(curl -fsSL "$url.sha256" | awk '{print $1}')
	[ "$want" = "$(sha256sum "$dir/$base" | cut -d' ' -f1)" ] || die "br $BR_VERSION sha256 mismatch"
	tar -xzf "$dir/$base" -C "$dir"
	bin=$(find "$dir" -name br -type f | head -n 1)
	[ -n "$bin" ] || die "br binary missing in $base"
	chmod 755 "$bin"
	ln -sfn "$bin" /usr/local/bin/br
	note "br:$BR_VERSION"
fi
# 7b. the rch client (diagnostics.test.ts exercises it; the boxes carry only rch-wkr), checksum from the release.
if [ "$(/usr/local/bin/rch --version 2>/dev/null | cut -d' ' -f1-2 || :)" != "rch $RCH_VERSION" ]; then
	base="rch-v$RCH_VERSION-x86_64-unknown-linux-gnu.tar.gz"
	url="https://github.com/Dicklesworthstone/remote_compilation_helper/releases/download/v$RCH_VERSION/$base"
	dir="$SUITE_HOME/rch-$RCH_VERSION"
	rm -rf "$dir"; mkdir -p "$dir"
	curl -fsSL -o "$dir/$base" "$url"
	want=$(curl -fsSL "$url.sha256" | awk '{print $1}')
	[ -n "$want" ] && [ "$want" = "$(sha256sum "$dir/$base" | cut -d' ' -f1)" ] || die "rch $RCH_VERSION sha256 mismatch"
	tar -xzf "$dir/$base" -C "$dir"
	bin=$(find "$dir" -name rch -type f | head -n 1)
	[ -n "$bin" ] || die "rch binary missing in $base"
	chmod 755 "$bin"
	ln -sfn "$bin" /usr/local/bin/rch
	note "rch:$RCH_VERSION"
fi
# 8. verify every tool as the suite user, with the suite's pinned PATH order (scripts/fixed-env.sh).
verify=$(runuser -u "$SUITE_USER" -- env -i HOME="$suite_home" sh -c '
	PATH="$HOME/Library/Application Support/Tern/omp/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/bin"
	export PATH
	set -e
	v=$(bun --version); printf "bun=%s " "$v"
	v=$(omp --version); printf "omp=%s " "$v"
	v=$(typescript-language-server --version); printf "tsls=%s " "$v"
	v=$(tsc --version); printf "ts=%s " "$v"
	v=$(br --version); printf "br=%s " "$v"
	v=$(node --version); printf "node=%s " "$v"
	v=$(python3 --version); printf "python=%s " "$v"
	v=$(git --version); printf "git=%s " "$v"
	v=$(python3.11 --version); printf "python311=%s " "$v"
	v=$(command -v regexploit-js); printf "regexploit_js=%s " "$v"
	v=$(gh --version | head -n 1); printf "gh=%s " "$v"
	smoke="$HOME/work/bwrap-smoke"
	rm -rf "$smoke"; mkdir -p "$smoke"
	bwrap --ro-bind / / --bind "$smoke" "$smoke" --proc /proc --dev /dev --share-net --die-with-parent -- /usr/bin/true
	rmdir "$smoke"
	printf "bwrap=ok"
') || die "tool verification as $SUITE_USER failed: $verify"
case "$verify" in *"omp=omp/$OMP_VERSION "*) ;; *) die "omp on the suite PATH is not $OMP_VERSION: $verify" ;; esac
case "$verify" in *"bun=$BUN_VERSION "*) ;; *) die "bun on the suite PATH is not $BUN_VERSION: $verify" ;; esac
case "$verify" in *"br=br $BR_VERSION "*) ;; *) die "br on the suite PATH is not $BR_VERSION: $verify" ;; esac
python3 -c 'import json,sys; json.dump({"pins": sys.argv[1], "verified": sys.argv[2], "user": sys.argv[3]}, open(sys.argv[4], "w"), sort_keys=True)' \
	"$MARKER" "$verify" "$SUITE_USER" "$SUITE_HOME/READY.json.tmp"
mv "$SUITE_HOME/READY.json.tmp" "$SUITE_HOME/READY.json"
printf 'suite-worker-setup[%s]: READY %s; installed:%s\n' "$host" "$verify" "${installed:- unchanged}"
REMOTE
	then :; else
		echo "suite-worker-setup: $host FAILED" >&2
		failed=1
	fi
done
exit "$failed"
