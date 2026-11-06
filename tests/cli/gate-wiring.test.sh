#!/bin/sh
# Real adapter + local bare origin: scripts/gate-wiring.py scripts/pre-push-gate.sh.
# shellcheck source=tests/cli/pre-push-gate-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/pre-push-gate-fixtures.sh"

wiring_repo() {
	name=$1
	repo=$(mkrepo "$name" 'echo FIXTURE-FRESH-GATE') || exit 1
	mkdir -p "$repo/.omp"
	if [ -f "$KITREPO/scripts/gate-wiring.py" ]; then
		cp "$KITREPO/scripts/gate-wiring.py" "$repo/scripts/gate-wiring.py"
	fi
	printf '#!/bin/sh\nexit 0\n' > "$repo/scripts/check-required.sh"
	printf '#!/bin/sh\nsh scripts/check-required.sh\n' > "$repo/scripts/chain.sh"
	cat > "$repo/.omp/gate-wiring.json" <<'JSON'
{"version":1,"gate_globs":["scripts/check-*.sh"],"entrypoints":["scripts/chain.sh"],"thresholds":{"unwired":0,"unreachable":0,"expired_quarantine":0},"quarantines":{}}
JSON
	git -C "$repo" add .omp scripts
	git -C "$repo" commit -qm '[test] wiring policy'
	git init --template= -q --bare --initial-branch=main "$repo.origin.git"
	git -C "$repo" remote add origin "$repo.origin.git"
	git -C "$repo" push -q origin HEAD:refs/heads/main
	mkdir -p "$repo/.git/hooks"
	printf '#!/bin/sh\nexec sh "%s" "$@"\n' "$ADAPTER" > "$repo/.git/hooks/pre-push"
	chmod +x "$repo/.git/hooks/pre-push"
	printf '%s' "$repo"
}

push_case() {
	label=$1 expected=$2 marker=$3
	git -C "$repo" add .omp scripts
	git -C "$repo" commit -qm "[test] $label" --allow-empty
	before=$(git --git-dir="$repo.origin.git" rev-parse refs/heads/main)
	rc=0
	git -C "$repo" push origin HEAD:refs/heads/main > "$TMP/$label.log" 2>&1 || rc=$?
	# Read every byte and retain the producer rc before diagnosing this push.
	printf '\n== %s producer_rc=%s\n' "$label" "$rc"
	cat "$TMP/$label.log"
	after=$(git --git-dir="$repo.origin.git" rev-parse refs/heads/main)
	out=$(cat "$TMP/$label.log")
	case "$expected:$rc" in
		pass:0) [ "$after" = "$(git -C "$repo" rev-parse HEAD)" ] && origin_ok=1 || origin_ok=0 ;;
		fail:0) origin_ok=0 ;;
		fail:*) [ "$before" = "$after" ] && origin_ok=1 || origin_ok=0 ;;
		*) origin_ok=0 ;;
	esac
	if [ "$origin_ok" = 1 ] && printf '%s' "$out" | grep -Fq "$marker"; then
		pass=$((pass + 1)); printf 'PASS %s push_rc=%s origin=%s\n' "$label" "$rc" "$expected"
	else
		fail=$((fail + 1)); printf 'FAIL %s push_rc=%s origin_ok=%s wanted=%s\n' "$label" "$rc" "$origin_ok" "$marker"
	fi
}

repo=$(wiring_repo wired)
push_case wired-control pass 'GREEN gate-wiring'

repo=$(wiring_repo unwired)
printf '#!/bin/sh\nexit 0\n' > "$repo/scripts/check-new.sh"
push_case unwired-negative fail 'unwired: scripts/check-new.sh'
printf '\nsh scripts/check-new.sh\n' >> "$repo/scripts/chain.sh"
push_case unwired-repaired-control pass 'GREEN gate-wiring'

repo=$(wiring_repo unreachable)
printf '#!/bin/sh\nexit 0\n' > "$repo/scripts/check-orphan.sh"
printf '#!/bin/sh\nsh scripts/check-orphan.sh\n' > "$repo/scripts/orphan-wrapper.sh"
push_case unreachable-negative fail 'unreachable: scripts/check-orphan.sh'
printf '\nsh scripts/orphan-wrapper.sh\n' >> "$repo/scripts/chain.sh"
push_case transitive-control pass 'GREEN gate-wiring'

repo=$(wiring_repo expired)
# Baseline policy supplies expiry; the candidate cannot grant itself an extension.
cat > "$repo/.omp/gate-wiring.json" <<'JSON'
{"version":1,"gate_globs":["scripts/check-*.sh"],"entrypoints":["scripts/chain.sh"],"thresholds":{"unwired":0,"unreachable":0,"expired_quarantine":0},"quarantines":{"scripts/check-required.sh":{"owner":"fixture","reason":"paired expiry control","expires_on":"2000-01-01"}}}
JSON
git -C "$repo" add .omp/gate-wiring.json
git -C "$repo" commit -qm '[test] expired policy baseline'
# Advance only the disposable origin directly, before the tested push.
git --git-dir="$repo.origin.git" fetch -q "$repo" HEAD:refs/heads/main
push_case expired-negative fail 'expired_quarantine: scripts/check-required.sh'
cat > "$repo/.omp/gate-wiring.json" <<'JSON'
{"version":1,"gate_globs":["scripts/check-*.sh"],"entrypoints":["scripts/chain.sh"],"thresholds":{"unwired":0,"unreachable":0,"expired_quarantine":0},"quarantines":{}}
JSON
push_case quarantine-retired-wired-control pass 'GREEN gate-wiring'

repo=$(wiring_repo unexpired)
cat > "$repo/.omp/gate-wiring.json" <<'JSON'
{"version":1,"gate_globs":["scripts/check-*.sh"],"entrypoints":["scripts/chain.sh"],"thresholds":{"unwired":0,"unreachable":0,"expired_quarantine":0},"quarantines":{"scripts/check-required.sh":{"owner":"fixture","reason":"paired expiry control","expires_on":"9999-12-31"}}}
JSON
git -C "$repo" add .omp/gate-wiring.json
git -C "$repo" commit -qm '[test] unexpired policy baseline'
git --git-dir="$repo.origin.git" fetch -q "$repo" HEAD:refs/heads/main
push_case unexpired-control pass 'GREEN gate-wiring'

repo=$(wiring_repo inert)
printf '#!/bin/sh\necho "sh scripts/check-required.sh"\n# sh scripts/check-required.sh\n' > "$repo/scripts/chain.sh"
push_case inert-reference-negative fail 'unwired: scripts/check-required.sh'

repo=$(wiring_repo weakened)
printf '#!/bin/sh\nexit 0\n' > "$repo/scripts/check-new.sh"
cat > "$repo/.omp/gate-wiring.json" <<'JSON'
{"version":1,"gate_globs":["scripts/check-*.sh"],"entrypoints":["scripts/chain.sh"],"thresholds":{"unwired":1,"unreachable":0,"expired_quarantine":0},"quarantines":{}}
JSON
push_case weakened-policy-negative fail 'unwired: scripts/check-new.sh'
repo=$(wiring_repo newexpired)
cat > "$repo/.omp/gate-wiring.json" <<'JSON'
{"version":1,"gate_globs":["scripts/check-*.sh"],"entrypoints":["scripts/chain.sh"],"thresholds":{"unwired":0,"unreachable":0,"expired_quarantine":0},"quarantines":{"scripts/check-required.sh":{"owner":"fixture","reason":"new expired record","expires_on":"2000-01-01"}}}
JSON
push_case newly-expired-negative fail 'expired_quarantine: scripts/check-required.sh'


# Exercise policy boundaries and parser rejection through the public checker,
# without fixture checker stubs or a hosted-CI service.
if python3 -B - "$KITREPO" "$TMP" <<'PY'
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))
from kitlib_run import run

root = Path(sys.argv[2]) / "policy-boundaries"
(root / "scripts").mkdir(parents=True)
(root / ".omp").mkdir()
gate = root / "scripts/check-required.sh"
gate.write_text("#!/bin/sh\nexit 0\n")
chain = root / "scripts/chain.sh"
policy = {
    "version": 1, "gate_globs": ["scripts/check-*.sh"],
    "entrypoints": ["scripts/chain.sh"],
    "thresholds": {"unwired": 0, "unreachable": 0, "expired_quarantine": 0},
    "quarantines": {},
}
def check(label, source, expected, marker):
    chain.write_text(source)
    (root / ".omp/gate-wiring.json").write_text(json.dumps(policy))
    result = run(["python3", "-B", str(Path(sys.argv[1]) / "scripts/gate-wiring.py"), "--repo", str(root)], deadline_s=30)
    output = (result.stdout + result.stderr).decode()
    print(f"== {label} producer_rc={result.rc}\n{output}", flush=True)
    assert not result.timed_out and not result.truncated and not result.killed, label
    assert result.rc == expected and marker in output, label

check("quoted-control", 'sh "scripts/check-required.sh"\n', 0, "GREEN gate-wiring")
check("escaped-control", "sh scripts/check-\\required.sh\n", 0, "GREEN gate-wiring")
check("stopped-negative", "exit 0\nsh scripts/check-required.sh\n", 1, "unwired: scripts/check-required.sh")
policy["thresholds"]["unwired"] = 1
check("configured-inclusive-maximum", ":\n", 0, '"unwired": 1')
(root / "scripts/check-second.sh").write_text("exit 0\n")
check("configured-maximum-exceeded", ":\n", 1, "unwired: scripts/check-second.sh")
policy["thresholds"]["unwired"] = 0
for label, source in (
    ("nested-negative", "if false; then sh scripts/check-required.sh; fi\n"),
    ("heredoc-negative", "cat <<'EOF'\nsh scripts/check-required.sh\nEOF\n"),
    ("prefix-junk-negative", "sh scripts/check-required.sh &&\n"),
    ("quote-junk-negative", "sh scripts/check-required.sh\n'unclosed"),
):
    check(label, source, 2, "cannot parse reachable shell source")
policy["thresholds"]["unwired"] = True
check("malformed-threshold-negative", ":\n", 2, "must be a nonnegative integer")
print("policy-boundaries: 10 pass 0 fail")
PY
then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
fi

printf '\ngate-wiring: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
