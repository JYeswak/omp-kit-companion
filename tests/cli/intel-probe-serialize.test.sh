#!/bin/sh
# intel-probe-serialize.test.sh — B7 rz5.30.2: the Intel probe serializes its OMP tracks.
#
# Run 39199001547 refused BOTH tracks in the regex-budget live-stream gate
# (500ms ceiling; certified missed at 519.5ms) while load1 sat at 5.5-13 with
# the minimum and certified tracks running concurrently on the same
# macos-15-intel label. The probe keeps continue-on-error and unchanged
# thresholds; it just stops interfering with itself via max-parallel: 1.
# Planted parallel/unbounded fixtures must fail this pin.
set -u
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$HERE/../.." && pwd)
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
kitlib_tmp TMP intel-probe-serialize-test || exit 1
pass=0
fail=0
check() { # name expected_rc actual_rc output [pattern...]
	name=$1; want=$2; got=$3; out=$4; shift 4
	ok=1
	[ "$got" = "$want" ] || ok=0
	for pattern in "$@"; do
		printf '%s' "$out" | grep -q -- "$pattern" || ok=0
	done
	if [ "$ok" = "1" ]; then pass=$((pass + 1)); printf 'ok %s\n' "$name";
	else fail=$((fail + 1)); printf 'FAIL %s (rc=%s want=%s out=%s)\n' "$name" "$got" "$want" "$out"; fi
}
# Bun.YAML (the repo's own runtime, as the .ts workflow tests use) turns the workflow into JSON, so the
# python below needs only its standard library: PyYAML is a per-user install a scratch HOME hides.
bun --no-env-file --config=/dev/null -e \
	'const [i, o] = process.argv.slice(-2); await Bun.write(o, JSON.stringify(Bun.YAML.parse(await Bun.file(i).text())));' \
	"$ROOT/.github/workflows/release-intel-probe.yml" "$TMP/probe.json"
cat > "$TMP/pin.py" <<'PYEOF'
import json, sys
doc = json.load(open(sys.argv[1])) or {}
job = (doc.get("jobs", {}) or {}).get("intel-probe", {})
strategy = job.get("strategy", {}) or {}
tracks = (strategy.get("matrix", {}) or {}).get("track", [])
print("max-parallel=%s tracks=%s runner=%s" % (
    strategy.get("max-parallel"), list(tracks), job.get("runs-on")))
ok = (strategy.get("max-parallel") == 1
      and list(tracks) == ["minimum", "certified"]
      and job.get("runs-on") == "macos-15-intel")
sys.exit(0 if ok else 1)
PYEOF
out=$(python3 "$TMP/pin.py" "$TMP/probe.json" 2>&1); rc=$?
check "probe serializes both OMP tracks on the Intel label" 0 "$rc" "$out" "max-parallel=1"
# Planted: two-way parallel tracks must fail the pin.
python3 - "$TMP/probe.json" "$TMP/parallel.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
d["jobs"]["intel-probe"]["strategy"]["max-parallel"] = 2
json.dump(d, open(sys.argv[2], "w"))
PYEOF
out=$(python3 "$TMP/pin.py" "$TMP/parallel.json" 2>&1); rc=$?
check "planted parallel tracks refused" 1 "$rc" "$out" "max-parallel=2"
# Planted: unbounded (key absent) tracks must fail the pin.
python3 - "$TMP/probe.json" "$TMP/unbounded.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
d["jobs"]["intel-probe"]["strategy"].pop("max-parallel", None)
json.dump(d, open(sys.argv[2], "w"))
PYEOF
out=$(python3 "$TMP/pin.py" "$TMP/unbounded.json" 2>&1); rc=$?
check "planted unbounded tracks refused" 1 "$rc" "$out" "max-parallel=None"
printf '%s tests passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
