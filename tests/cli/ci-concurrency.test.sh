#!/bin/sh
# ci-concurrency.test.sh — RELFAST2 (ompkit-fp72.5): release macOS jobs fit the runner pool.
#
# Counts macOS runner instances at max matrix expansion across release.yml
# (which calls ci.yml as its native-candidate job) grouped by needs-depth,
# and fails above MAX_MACOS_CONCURRENT. Matrix rules (documented
# approximations): literal fromJSON lists parsed; inputs/event conditionals
# take the max branch; the OMP version matrix resolves to minimum+certified
# (2, per ci.yml header); darwin-x64 ships only when version is empty, and
# releases pass a version, so native-certification counts darwin-arm64 only.
# A planted fixture with one extra macOS job at the max depth must fail.
set -u
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$HERE/../.." && pwd)
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP ci-concurrency-test || exit 1
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
# Bun.YAML (the repo's own runtime, as the .ts workflow tests use) turns each workflow into JSON, so the
# python below needs only its standard library: PyYAML is a per-user install a scratch HOME hides.
yaml_json() { # in.yml out.json
	bun --no-env-file --config=/dev/null -e \
		'const [i, o] = process.argv.slice(-2); await Bun.write(o, JSON.stringify(Bun.YAML.parse(await Bun.file(i).text())));' \
		"$1" "$2"
}
yaml_json "$ROOT/.github/workflows/ci.yml" "$TMP/ci.json"
yaml_json "$ROOT/.github/workflows/release.yml" "$TMP/release.json"
cat > "$TMP/count.py" <<'PYEOF'
import json, sys

MAX_MACOS_CONCURRENT = int(sys.argv[3]) if len(sys.argv) > 3 else 5
ci_path, rel_path = sys.argv[1], sys.argv[2]

def macos_of(runner):
    if not isinstance(runner, str):
        return 0
    return 1 if "macos" in runner else 0

def matrix_sizes(job):
    """Max-expansion sizes per matrix axis relevant to runner count."""
    strategy = job.get("strategy", {}) or {}
    matrix = strategy.get("matrix", {}) or {}
    sizes = {}
    for axis, value in matrix.items():
        if isinstance(value, list):
            sizes[axis] = len(value)
        elif isinstance(value, str) and "inputs.reuse_fast_ci" in value:
            sizes[axis] = 2  # max branch: ubuntu + macos
        elif isinstance(value, str) and "inputs.version" in value:
            sizes[axis] = 3  # release passes version: 3 platforms
        elif isinstance(value, str) and "resolve-omp-versions" in value:
            sizes[axis] = 2  # minimum + certified OMP tracks
        elif isinstance(value, str) and "include" in value:
            sizes[axis] = 1
        else:
            sizes[axis] = 1
    return sizes

def job_macos(job):
    runner = job.get("runs-on", "")
    if isinstance(runner, str) and "matrix" not in runner:
        return macos_of(runner)
    # matrix runner: find which axis selects the OS
    text = json.dumps(job.get("strategy", {}))
    if "macos" not in text:
        return 0
    sizes = matrix_sizes(job)
    # count OS entries that are macos at max expansion
    os_lists = []
    import re
    for m in re.finditer(r'fromJSON\(\'(\[.*?\])\'\)', text):
        try:
            os_lists.append(json.loads(m.group(1).replace("'", '"')))
        except Exception:
            pass
    for m in re.finditer(r'"(darwin-arm64-none|darwin-x64-none|linux-[^"]+)"\s*:\s*"(macos[^"]*|ubuntu[^"]*)"', text):
        os_lists.append([m.group(2)])
    count = 0
    for lst in os_lists:
        n = sum(1 for o in lst if "macos" in str(o))
        if "platform" in text and "darwin-x64" in text and "inputs.version" in text:
            n = sum(1 for o in lst if o == "macos-15" or (isinstance(o, str) and o.startswith("macos") and "intel" not in o and lst != ["macos-15", "macos-15-intel"]))
            n = 1  # darwin-arm64 only when version is passed
        count = max(count, n)
    omp_mult = sizes.get("omp", 1)
    include_mult = len(job.get("strategy", {}).get("matrix", {}).get("include", [1])) if isinstance(job.get("strategy", {}).get("matrix", {}).get("include"), list) else 1
    runners = count if count else (1 if "macos" in text else 0)
    # include-style matrices list runners explicitly
    inc = job.get("strategy", {}).get("matrix", {}).get("include")
    if isinstance(inc, list):
        runners = sum(1 for row in inc if "macos" in str(row.get("runner", "")))
        return runners
    return runners * omp_mult

def depths(jobs):
    order, depth = {}, {}
    def visit(name, stack=()):
        if name in depth:
            return depth[name]
        job = jobs.get(name, {})
        needs = job.get("needs", [])
        if isinstance(needs, str):
            needs = [needs]
        d = 0
        for parent in needs or []:
            if parent in stack:
                continue
            d = max(d, visit(parent, stack + (name,)) + 1)
        depth[name] = d
        return d
    for name in jobs:
        visit(name)
    return depth

ci = json.load(open(ci_path)) or {}
rel = json.load(open(rel_path)) or {}
ci_jobs, rel_jobs = ci.get("jobs", {}) or {}, rel.get("jobs", {}) or {}
levels = {}
ci_depth = depths(ci_jobs)
for name, job in ci_jobs.items():
    n = job_macos(job)
    if n:
        # ci jobs run inside release.yml native-candidate window: shift by 1
        levels.setdefault(ci_depth.get(name, 0) + 1, []).append((name, n))
rel_depth = depths(rel_jobs)
for name, job in rel_jobs.items():
    n = job_macos(job)
    if n:
        levels.setdefault(rel_depth.get(name, 0), []).append(("release:" + name, n))
worst = (0, [])
for depth in sorted(levels):
    total = sum(n for _, n in levels[depth])
    if total > worst[0]:
        worst = (total, levels[depth])
print("MAX_MACOS_CONCURRENT=%d depth details: %s" % (worst[0], "; ".join("%s=%d" % pair for pair in worst[1])))
sys.exit(0 if worst[0] <= MAX_MACOS_CONCURRENT else 1)
PYEOF
out=$(python3 "$TMP/count.py" "$TMP/ci.json" "$TMP/release.json" 2>&1); rc=$?
check "macOS concurrency fits the pool" 0 "$rc" "$out" "MAX_MACOS_CONCURRENT="
printf '%s\n' "$out"
# Planted: one extra macOS job at the max depth must fail the ceiling.
python3 - "$TMP/ci.json" "$TMP/ci-six.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
d["jobs"]["planted-macos"] = {"runs-on": "macos-15", "needs": "resolve-omp-versions"}
d["jobs"]["planted-macos-2"] = {"runs-on": "macos-15", "needs": "resolve-omp-versions"}
json.dump(d, open(sys.argv[2], "w"))
PYEOF
out=$(python3 "$TMP/count.py" "$TMP/ci-six.json" "$TMP/release.json" 2>&1); rc=$?
check "planted sixth concurrent macOS job fails" 1 "$rc" "$out" "MAX_MACOS_CONCURRENT="
printf '%s tests passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
