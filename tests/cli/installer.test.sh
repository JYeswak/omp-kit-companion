#!/bin/sh
set -eu
: "${TMPDIR:?set a private test scratch directory}"
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
WORK=$(mktemp -d "$TMPDIR/omp-kit-installer-test.XXXXXXXX")
server=
trap '[ -z "$server" ] || { kill "$server" 2>/dev/null || :; wait "$server" 2>/dev/null || :; }; rm -rf -- "$WORK"' EXIT HUP INT TERM
mkdir -m 700 "$WORK/assets" "$WORK/home"
/usr/bin/env -u HOME "$ROOT/installer/install.sh" --help > "$WORK/help.log"
python3 - "$WORK/help.log" <<'PY'
import sys
assert 'Usage: install.sh' in open(sys.argv[1]).read()
PY
ASSET=$(TMPDIR="$WORK" "$ROOT/scripts/package-release.sh" --version 1.2.3 --platform "$(/usr/bin/uname -s | tr '[:upper:]' '[:lower:]')-$(/usr/bin/uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')-$(if [ "$(/usr/bin/uname -s)" = Darwin ]; then printf none; else printf gnu; fi)" --out "$WORK/assets")
printf '%s\n' "$ASSET" > "$WORK/asset.json"
python3 - "$WORK/asset.json" "$WORK/assets/release-index.json" <<'PY'
import json,sys
asset=json.load(open(sys.argv[1]))
key='-'.join(asset[k] for k in ('os','arch','libc'))
with open(sys.argv[2],'w') as out: json.dump({'schema_version':1,'version':'1.2.3','source_tag':'v1.2.3','assets':{key:asset}},out)
PY
ARCHIVE=$(python3 - "$WORK/asset.json" "$WORK/assets" <<'PY'
import json,os,sys
print(os.path.join(sys.argv[2],json.load(open(sys.argv[1]))['filename']))
PY
)
INSTALL="$ROOT/installer/install.sh"
HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/prefix" --dry-run > "$WORK/dry.log"
[ ! -e "$WORK/prefix/bin/omp-kit" ]
[ ! -e "$WORK/prefix" ]
python3 -B - "$WORK/home" <<'PY'
from pathlib import Path
import sys
assert not list(Path(sys.argv[1]).iterdir()), "installer dry-run modified fresh HOME"
PY
if HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3-01 --prefix "$WORK/prefix" > "$WORK/invalid-version.log" 2>&1; then
  printf 'invalid numeric prerelease accepted\n' >&2; exit 1
fi
[ ! -e "$WORK/prefix/bin/omp-kit" ]
if HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/prefix/../alias" > "$WORK/alias-prefix.log" 2>&1; then
  printf 'non-canonical prefix accepted\n' >&2; exit 1
fi
[ ! -e "$WORK/alias" ]
HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/prefix" > "$WORK/installed.log"
(cd "$WORK" && "$WORK/prefix/bin/omp-kit" --info --json > "$WORK/info.json")
python3 - "$WORK/info.json" <<'PY'
import json,sys
info=json.load(open(sys.argv[1]))
assert info['data']['version']=='1.2.3',info
PY
if (cd "$WORK" && HOME="$WORK/home" PATH=/usr/bin:/bin OMP='' OMP_BIN='' OMP_PATH='' OMP_SRC='' "$WORK/prefix/bin/omp-kit" status --json > "$WORK/no-omp.json"); then
  printf 'missing OMP claimed a working status\n' >&2; exit 1
else
  missing_rc=$?
  [ "$missing_rc" -eq 3 ] || { printf 'missing OMP returned rc=%s instead of unavailable\\n' "$missing_rc" >&2; exit 1; }
fi
python3 - "$WORK/no-omp.json" <<'PY'
import json,sys
report=json.load(open(sys.argv[1]))
assert report['ok'] is False and any(error['code']=='OMP_UNAVAILABLE' for error in report['errors']),report
PY
HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/prefix" > "$WORK/repeated.log"
[ "$(readlink "$WORK/prefix/bin/omp-kit")" = "../releases/1.2.3/bin/omp-kit" ]
mkdir -m 700 "$WORK/bad"
python3 - "$ARCHIVE" "$WORK/bad/$(basename "$ARCHIVE")" <<'PY'
import sys
buf=bytearray(open(sys.argv[1],'rb').read()); buf[0]^=1
with open(sys.argv[2],'wb') as out: out.write(buf)
PY
if HOME="$WORK/home" "$INSTALL" --offline "$WORK/bad/$(basename "$ARCHIVE")" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/prefix" > "$WORK/bad.log" 2>&1; then
  printf 'tampered archive accepted\n' >&2; exit 1
fi
python3 - "$WORK/bad.log" <<'PY'
import sys
assert 'archive SHA-256 mismatch' in open(sys.argv[1]).read()
PY
[ "$(readlink "$WORK/prefix/bin/omp-kit")" = "../releases/1.2.3/bin/omp-kit" ]
mkdir -m 700 "$WORK/badlink"
python3 - "$ARCHIVE" "$WORK/badlink/$(basename "$ARCHIVE")" "$WORK/assets/release-index.json" "$WORK/badlink/index.json" <<'PY'
import hashlib,json,sys
content=bytearray(open(sys.argv[1],'rb').read())
content[156]=ord('2')  # A verified outer digest cannot authorize a symlink archive member.
content[148:156]=b'        '
content[148:156]=f'{sum(content[:512]):06o}\0 '.encode()
with open(sys.argv[2],'wb') as out: out.write(content)
index=json.load(open(sys.argv[3])); asset=next(iter(index['assets'].values()))
asset['sha256']=hashlib.sha256(content).hexdigest()
with open(sys.argv[4],'w') as out: json.dump(index,out)
PY
if HOME="$WORK/home" "$INSTALL" --offline "$WORK/badlink/$(basename "$ARCHIVE")" --index "$WORK/badlink/index.json" --version 1.2.3 --prefix "$WORK/prefix" > "$WORK/badlink.log" 2>&1; then
  printf 'rehashed symlink archive accepted\n' >&2; exit 1
fi
python3 - "$WORK/badlink.log" <<'PY'
import sys
assert 'unsafe archive member type' in open(sys.argv[1]).read()
PY
[ "$(readlink "$WORK/prefix/bin/omp-kit")" = "../releases/1.2.3/bin/omp-kit" ]
mkdir -m 700 "$WORK/unsafe-prefix"
mkdir -m 700 "$WORK/unsafe-prefix/bin"
ln -s '../releases/../../../other/bin/omp-kit' "$WORK/unsafe-prefix/bin/omp-kit"
if HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE" --index "$WORK/assets/release-index.json" --version 1.2.3 --prefix "$WORK/unsafe-prefix" > "$WORK/unsafe-link.log" 2>&1; then
  printf 'unsafe pre-existing stable symlink accepted\n' >&2; exit 1
fi
[ "$(readlink "$WORK/unsafe-prefix/bin/omp-kit")" = '../releases/../../../other/bin/omp-kit' ]
[ ! -e "$WORK/unsafe-prefix/releases/1.2.3" ]
ASSET2=$(TMPDIR="$WORK" "$ROOT/scripts/package-release.sh" --version 1.2.4 --platform "$(/usr/bin/uname -s | tr '[:upper:]' '[:lower:]')-$(/usr/bin/uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')-$(if [ "$(/usr/bin/uname -s)" = Darwin ]; then printf none; else printf gnu; fi)" --out "$WORK/assets")
printf '%s\n' "$ASSET2" > "$WORK/asset2.json"
python3 - "$WORK/asset2.json" "$WORK/assets/release-index2.json" <<'PY'
import json,sys
asset=json.load(open(sys.argv[1])); key='-'.join(asset[k] for k in ('os','arch','libc'))
with open(sys.argv[2],'w') as out: json.dump({'schema_version':1,'version':'1.2.4','source_tag':'v1.2.4','assets':{key:asset}},out)
PY
ARCHIVE2=$(python3 - "$WORK/asset2.json" "$WORK/assets" <<'PY'
import json,os,sys
print(os.path.join(sys.argv[2],json.load(open(sys.argv[1]))['filename']))
PY
)
HOME="$WORK/home" "$INSTALL" --offline "$ARCHIVE2" --index "$WORK/assets/release-index2.json" --version 1.2.4 --prefix "$WORK/prefix" > "$WORK/switched.log"
[ "$(readlink "$WORK/prefix/bin/omp-kit")" = "../releases/1.2.4/bin/omp-kit" ]
[ -x "$WORK/prefix/releases/1.2.3/bin/omp-kit" ]
(cd "$WORK" && "$WORK/prefix/bin/omp-kit" --info --json > "$WORK/switched-info.json")
python3 - "$WORK/switched-info.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['data']['version']=='1.2.4'
PY
python3 - "$WORK/assets" "$WORK/port" > "$WORK/server.log" 2>&1 <<'PY' &
import functools,http.server,pathlib,sys
handler=functools.partial(http.server.SimpleHTTPRequestHandler,directory=sys.argv[1])
service=http.server.ThreadingHTTPServer(('127.0.0.1',0),handler)
pathlib.Path(sys.argv[2]).write_text(str(service.server_port))
service.serve_forever()
PY
server=$!
tries=0
until [ -s "$WORK/port" ]; do
  if ! kill -0 "$server" 2>/dev/null; then
    cat "$WORK/server.log" >&2
    printf 'fixture HTTP server exited before readiness\n' >&2; exit 1
  fi
  tries=$((tries + 1))
  [ "$tries" -lt 300 ] || { cat "$WORK/server.log" >&2; printf 'fixture HTTP server did not start within 30 seconds\n' >&2; exit 1; }
  sleep 0.1
done
port=$(cat "$WORK/port")
mkdir -m 700 "$WORK/online-home" "$WORK/assets/no-archive"
cp "$WORK/assets/release-index.json" "$WORK/assets/no-archive/release-index.json"
if HOME="$WORK/online-home" "$INSTALL" --index "http://127.0.0.1:$port/no-archive/release-index.json" --version 1.2.3 --prefix "$WORK/online-prefix" > "$WORK/failed-download.log" 2>&1; then
  printf 'missing archive download accepted\n' >&2; exit 1
fi
python3 -B - "$WORK/online-home" <<'PY'
from pathlib import Path
import sys
assert not list(Path(sys.argv[1]).iterdir()), "failed archive download modified fresh HOME"
PY
HOME="$WORK/online-home" "$INSTALL" --index "http://127.0.0.1:$port/release-index.json" --version 1.2.3 --prefix "$WORK/online-prefix" --dry-run > "$WORK/online-dry.log"
python3 -B - "$WORK/online-home" <<'PY'
from pathlib import Path
import sys
assert not list(Path(sys.argv[1]).iterdir()), "online dry-run modified fresh HOME"
PY
[ ! -e "$WORK/online-prefix" ]
HOME="$WORK/home" "$INSTALL" --index "http://127.0.0.1:$port/release-index.json" --version 1.2.3 --prefix "$WORK/online-prefix" --no-color > "$WORK/online.log"
(cd "$WORK" && "$WORK/online-prefix/bin/omp-kit" --info --json > "$WORK/online-info.json")
python3 - "$WORK/online-info.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['data']['version']=='1.2.3'
PY
printf 'installer real archive dry-run/install/reinstall/digest-refusal/two-version-switch/online PASS\n'
